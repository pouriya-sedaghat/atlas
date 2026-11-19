"""Real-child handoff fixtures, isolated from retained provider runs and bytes."""

import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from atlas_intake.control import get_control, launch_manual, set_selection
from atlas_intake.models import Artifact, Audit, CatalogRevision, Run
from atlas_verification.control import canonical, get_handoff, request_verification
from atlas_verification.models import VerificationAttempt
from atlas_verification.records import inspect_object_stream
from atlas_verification.worker import VerificationWorker
from tests.test_verification_decoder import block, pbf


# This is an explicitly synthetic two-region catalog. No provider request or
# preexisting acquisition history participates in either fixture.
FIXTURE_CATALOG = [
    {
        "id": "synthetic-selected", "name": "Synthetic selected region", "parent": None,
        "path": "synthetic/selected",
        "pbf_url": "https://atlas-fixture.invalid/selected-latest.osm.pbf",
        "poly_url": "https://atlas-fixture.invalid/selected.poly",
    },
    {
        "id": "synthetic-boundary", "name": "Synthetic boundary-only region", "parent": None,
        "path": "synthetic/boundary",
        "pbf_url": "https://atlas-fixture.invalid/boundary-latest.osm.pbf",
        "poly_url": "https://atlas-fixture.invalid/boundary.poly",
    },
]
VALID_POLY = b"synthetic fixture\n1\n0 0\n2 0\n2 2\n0 2\n0 0\nEND\nEND\n"


class VerificationHandoffTests(TransactionTestCase):
    """Catch regressions between the child, publication and durable handoff."""

    def setUp(self):
        # TransactionTestCase commits fixture metadata and the normal control
        # transitions. The child consumes its private on-disk snapshot, not ORM.
        self.assertEqual(connection.vendor, "postgresql")
        self.assertFalse(connection.in_atomic_block)
        temporary = TemporaryDirectory(prefix="atlas-synthetic-handoff-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.inbox = root / "inbox"
        self.output = root / "verification"
        self.inbox.mkdir()
        self.output.mkdir()
        attempt_bytes = 16 * 1024**2
        root_bytes = 64 * 1024**2
        configured = override_settings(
            ATLAS_INBOX=self.inbox, ATLAS_VERIFICATION_ROOT=self.output,
            ATLAS_VERIFICATION_ATTEMPT_BYTES=attempt_bytes,
            ATLAS_VERIFICATION_ROOT_BYTES=root_bytes,
            ATLAS_VERIFICATION_TIMEOUT=60,
            ATLAS_LIMITS={**settings.ATLAS_LIMITS, "free": 1024**2},
        )
        configured.enable()
        self.addCleanup(configured.disable)
        # A fresh management-command child does not inherit override_settings.
        # Only environment configuration is patched; every pipeline step is real.
        environment = patch.dict(os.environ, {
            "ATLAS_INBOX": str(self.inbox),
            "ATLAS_VERIFICATION_ROOT": str(self.output),
            "ATLAS_VERIFICATION_ATTEMPT_BYTES": str(attempt_bytes),
            "ATLAS_VERIFICATION_ROOT_BYTES": str(root_bytes),
            "ATLAS_VERIFICATION_TIMEOUT": "60",
            "ATLAS_MIN_FREE_BYTES": str(1024**2),
        })
        environment.start()
        self.addCleanup(environment.stop)

    def seal_fixture(self, pbf_bytes):
        catalog = CatalogRevision.objects.create(
            digest=hashlib.sha256(canonical(FIXTURE_CATALOG)).hexdigest(),
            regions=FIXTURE_CATALOG,
        )
        control = get_control()
        control.catalog = catalog
        control.save(update_fields=["catalog"])
        set_selection(["synthetic-selected"], "fixture-operator")
        run = launch_manual("synthetic-handoff", "fixture-operator")
        self.assertEqual(run.artifacts.count(), 3)
        self.originals = {}
        received = timezone.now()
        for artifact in run.artifacts.all():
            data = pbf_bytes if artifact.kind == Artifact.Kind.PBF else VALID_POLY
            path = self.inbox / artifact.relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            artifact.status = Artifact.Status.COMPLETE
            artifact.actual_length = len(data)
            artifact.sha256 = hashlib.sha256(data).hexdigest()
            artifact.finished_at = received
            artifact.save(update_fields=["status", "actual_length", "sha256", "finished_at"])
            self.originals[str(artifact.pk)] = (artifact.relative_path, data, artifact.sha256)
        run.status = Run.Status.SEALED
        run.sealed_at = received
        run.save(update_fields=["status", "sealed_at"])
        return run

    def publish_fixture(self, pbf_bytes, counts, *, build_eligible):
        run = self.seal_fixture(pbf_bytes)
        attempt = request_verification(run.pk, "synthetic-handoff", "fixture-operator")
        self.assertEqual(attempt.status, "queued")
        self.assertEqual(attempt.snapshot["selected_pbfs"], ["synthetic-selected"])
        self.assertEqual(attempt.snapshot["regions"], ["synthetic-boundary", "synthetic-selected"])
        for artifact in attempt.snapshot["artifacts"]:
            path, data, digest = self.originals[artifact["artifact_id"]]
            self.assertEqual((artifact["path"], artifact["length"], artifact["sha256"]),
                             (path, len(data), digest))

        worker = VerificationWorker()
        # tick invokes the default management-command child, complete and publish.
        self.assertTrue(worker.tick())
        attempt.refresh_from_db()
        generation = worker.generation_path(attempt)
        diagnostics = (generation / "child.stderr").read_text()
        self.assertEqual(attempt.status, "verified", {
            "error": attempt.error, "blocking": attempt.summary.get("blocking"),
            "reasons": attempt.summary.get("reasons"), "stderr": diagnostics,
        })
        self.assertTrue(attempt.successful)
        self.assertEqual(attempt.build_eligible, build_eligible)
        self.assertEqual(attempt.reserved_bytes, 0)
        self.assertEqual(attempt.executions.count(), 1)
        execution = attempt.executions.get()
        self.assertEqual(execution.status, "verified")
        self.assertIsNotNone(execution.finished_at)
        self.assertEqual(execution.report["counts"], counts)
        self.assertEqual(json.loads((generation / "snapshot.json").read_bytes()), attempt.snapshot)
        self.assertEqual(list((generation / "spool").iterdir()), [])

        handoff = get_handoff(attempt.pk, verify_outputs=True)
        self.assertEqual(handoff["run_id"], str(run.pk))
        self.assertEqual(handoff["verification_id"], str(attempt.pk))
        self.assertEqual(handoff["manifest_schema_version"], 1)
        self.assertEqual(handoff["policy_version"], "atlas-input-v1")
        self.assertEqual(handoff["build_eligible"], build_eligible)
        manifest_path = self.output / handoff["manifest_path"]
        manifest_bytes = manifest_path.read_bytes()
        self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), handoff["manifest_sha256"])
        manifest = json.loads(manifest_bytes)
        self.assertEqual(manifest["catalog_digest"], run.catalog_id)
        self.assertEqual(manifest["frozen_inputs"], attempt.snapshot)
        self.assertEqual(manifest["input_fingerprint"], attempt.input_fingerprint)
        self.assertEqual(manifest["counts"], counts)
        self.assertEqual(manifest["blocking"], [])
        self.assertEqual(manifest["checks_incomplete"], [])
        self.assertEqual(set(manifest["checks_completed"]), set(self.originals))
        self.assertEqual(manifest["boundary_only_regions"], ["synthetic-boundary"])
        self.assertGreater(manifest["resources"]["child_peak_rss_kib"], 0)
        self.assertTrue(manifest["tools"]["osmium"])
        self.assertTrue(manifest["tools"]["geos"])

        registered = {item["path"]: item for item in attempt.intended["files"]}
        target = self.output / attempt.intended["target"]
        self.assertEqual(set(registered), {
            str(path.relative_to(self.output)) for path in target.rglob("*") if path.is_file()
        })
        selected = None
        for descriptor in manifest["regions"]:
            regional_path = manifest_path.parent / descriptor["path"]
            regional_bytes = regional_path.read_bytes()
            self.assertEqual(len(regional_bytes), descriptor["size"])
            self.assertEqual(hashlib.sha256(regional_bytes).hexdigest(), descriptor["sha256"])
            regional = json.loads(regional_bytes)
            self.assertEqual(regional["checks"]["poly"]["status"], "verified")
            for output in regional["outputs"]:
                path = regional_path.parent / output["path"]
                registered_output = registered[str(path.relative_to(self.output))]
                self.assertEqual((registered_output["size"], registered_output["sha256"]),
                                 (output["size"], output["sha256"]))
            if descriptor["region_id"] == "synthetic-selected":
                selected = regional
                self.objects = regional_path.parent / "objects.jsonl.zst"
        self.assertIsNotNone(selected)
        check = selected["checks"]["pbf"]
        self.assertEqual(check["status"], "verified")
        self.assertEqual(check["counts"], counts)
        self.assertEqual(check["osmium"]["counts"], counts)
        self.assertEqual(check["reread"]["counts"], counts)
        reread = inspect_object_stream(self.objects)
        self.assertEqual(reread["counts"], counts)
        self.assertEqual(reread["count"], sum(counts.values()))
        self.assertEqual(reread["uncompressed_sha256"], check["reread"]["uncompressed_sha256"])

        replay = request_verification(run.pk, "synthetic-handoff", "fixture-operator")
        self.assertEqual(replay.pk, attempt.pk)
        self.assertFalse(worker.tick())
        self.assertEqual(VerificationAttempt.objects.filter(run=run, successful=True).count(), 1)
        self.assertEqual(attempt.executions.count(), 1)
        self.assertTrue(Audit.objects.filter(run=run, action="verification.completed").exists())
        for path, data, digest in self.originals.values():
            retained = (self.inbox / path).read_bytes()
            self.assertEqual(retained, data)
            self.assertEqual(hashlib.sha256(retained).hexdigest(), digest)
        return attempt, check

    def test_real_child_publishes_handoff_and_changed_registered_output_revokes_it(self):
        primitive = block()
        nodes = primitive.primitivegroup.add()
        nodes.nodes.add(id=1, lat=0, lon=0)
        nodes.nodes.add(id=2, lat=10000000, lon=10000000)
        primitive.primitivegroup.add().ways.add(id=10).refs.extend([1, 1])
        relation = primitive.primitivegroup.add().relations.add(id=20)
        relation.memids.extend([10, -9])
        relation.types.extend([1, 0])
        relation.roles_sid.extend([3, 0])
        attempt, check = self.publish_fixture(
            pbf(primitive, compression="zlib"), {"nodes": 2, "ways": 1, "relations": 1},
            build_eligible=True,
        )
        for finding in check["references"].values():
            self.assertEqual(finding["missing_occurrences"], 0)
        # Preserve length so digest verification, rather than just size, must fail.
        original = self.objects.read_bytes()
        self.objects.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValidationError, "registered verification output"):
            get_handoff(attempt.pk, verify_outputs=True)

    def test_valid_empty_real_child_publishes_successful_build_ineligible_handoff(self):
        attempt, check = self.publish_fixture(
            pbf(), {"nodes": 0, "ways": 0, "relations": 0}, build_eligible=False,
        )
        self.assertTrue(check["empty"])
        self.assertIn("valid_empty_snapshot", [reason["code"] for reason in check["reasons"]])
        inspection = check["osmium"]
        self.assertEqual(inspection["adapter"], "osmium-1.18-no-node-bounds-counts-v1")
        self.assertIsNone(inspection["bounds"])
        self.assertEqual([item["exit_code"] for item in inspection["invocations"]], [1, 0, 0, 0])
        self.assertEqual([item["stdout"] for item in inspection["invocations"][1:]], ["0\n"] * 3)
        self.assertFalse(get_handoff(attempt.pk, verify_outputs=True)["build_eligible"])
