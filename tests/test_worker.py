import hashlib
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import TestCase, override_settings
from django.utils import timezone

from atlas_intake.control import launch_manual, retry_artifact, set_selection
from atlas_intake.models import Artifact, Audit, Run
from atlas_intake.provider import ProviderError
from atlas_intake.worker import Worker
from tests.test_control import install_catalog


POLY = b"test\n1\n 0 0\n 1 0\n 1 1\n 0 0\nEND\nEND\n"
PBF = b"synthetic extract"


class FixtureProvider:
    bad = False
    pinned_length = len(PBF)
    body_reads = 0

    def resolve_pbf(self, url, *, observer=None):
        return dict(url=url.replace("-latest", "-261117"), length=self.pinned_length,
                    etag='"pbf"', last_modified="")

    def pbf_pin(self, url, *, observer=None):
        return dict(url=url, length=self.pinned_length, etag='"pbf"', last_modified="",
                    md5=hashlib.md5(PBF).hexdigest())

    def poly_pin(self, url, sidecar):
        return dict(url=url, length=len(POLY), etag='"poly"', last_modified="", md5="")

    def download(self, pin, kind, target, limit, progress):
        self.body_reads += 1
        data = PBF if kind == "pbf" else POLY
        target.write(data)
        progress(len(data))
        if self.bad:
            raise ProviderError("checksum_mismatch", "Checksum mismatch.")
        return dict(length=len(data), sha256=hashlib.sha256(data).hexdigest(),
                    md5=hashlib.md5(data).hexdigest(), etag=pin["etag"], last_modified="")


class WorkerTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = install_catalog()
        self.provider = FixtureProvider()
        self.worker = Worker(self.provider, self.root)
        self.limits = override_settings(ATLAS_LIMITS={
            "pbf": 128, "poly": 128, "run": 1024, "inbox": 1024**2, "free": 1,
        })
        self.limits.enable()
        self.addCleanup(self.limits.disable)
        set_selection(["iran"], "operator")

    def run_fixture(self, key):
        run = launch_manual(key, "operator")
        for _ in range(12):
            self.worker.work_tick(parallel=False)
            run.refresh_from_db()
            if run.status not in {Run.Status.QUEUED, Run.Status.RUNNING}:
                break
        return run

    def test_seal_and_same_day_preservation(self):
        first = self.run_fixture("first")
        second = self.run_fixture("second")
        self.assertEqual(first.status, Run.Status.SEALED)
        self.assertEqual(second.status, Run.Status.SEALED)
        one, two = first.artifacts.get(kind="pbf"), second.artifacts.get(kind="pbf")
        self.assertNotEqual(one.relative_path, two.relative_path)
        self.assertEqual((self.root / one.relative_path).read_bytes(), PBF)
        self.assertEqual(one.sha256, hashlib.sha256(PBF).hexdigest())
        self.assertEqual(one.checksum_status, "verified")
        self.assertEqual(first.artifacts.get(kind="poly", region_id="monaco").checksum_status, "unavailable")

    def test_known_oversized_selection_reads_no_bodies(self):
        self.provider.pinned_length = 129
        run = self.run_fixture("oversized")
        self.assertEqual(run.status, Run.Status.INCOMPLETE)
        self.assertEqual(self.provider.body_reads, 0)
        self.assertEqual(run.artifacts.get(kind="pbf").error_code, "artifact_limit")

    def test_corruption_of_completed_bytes_keeps_the_original_digest(self):
        run = self.run_fixture("changed")
        artifact = run.artifacts.get(kind="pbf")
        (self.root / artifact.relative_path).write_bytes(b"changed")
        self.worker.verify_artifact(artifact.pk)
        artifact.refresh_from_db()
        run.refresh_from_db()
        self.assertEqual(artifact.status, Artifact.Status.INTEGRITY_FAILED)
        self.assertEqual(run.status, Run.Status.INTEGRITY_FAILED)
        self.assertIsNotNone(run.sealed_at)
        self.assertEqual(artifact.sha256, hashlib.sha256(PBF).hexdigest())

    def test_prepared_and_already_linked_files_recover(self):
        from unittest.mock import patch

        for linked in (False, True):
            with self.subTest(linked=linked):
                run = launch_manual(f"prepared-{linked}", "operator")
                self.worker.work_tick(parallel=False, transfers=False)
                with patch.object(self.worker, "publish", return_value=None):
                    self.worker.work_tick(parallel=False)
                artifact = run.artifacts.get(kind="pbf")
                self.assertEqual(artifact.status, Artifact.Status.PREPARED)
                if linked:
                    self.worker.install_link(artifact)
                self.worker.recover_publications()
                artifact.refresh_from_db()
                self.assertEqual(artifact.status, Artifact.Status.COMPLETE)
                self.assertEqual((self.root / artifact.relative_path).read_bytes(), PBF)
                self.run_fixture(f"prepared-{linked}")

    def test_stale_claim_cannot_prepare_or_publish(self):
        run = launch_manual("stale", "operator")
        self.worker.work_tick(parallel=False, transfers=False)
        artifact = self.worker.claim(run)
        Artifact.objects.filter(pk=artifact.pk).update(
            lease_until=timezone.now() - timedelta(seconds=1),
        )
        self.worker.reclaim_expired()
        self.assertFalse(self.worker.publish(artifact.pk, artifact.generation))

    def test_approved_poly_exception_and_unexpected_unresolved(self):
        regions = self.catalog.regions
        region = next(region for region in regions if region["id"] == "monaco")
        region.pop("poly_url")
        region["exception"] = {"entry_id": "fixture", "reason": "Verified absent"}
        self.catalog.save(update_fields=["regions"])
        self.assertEqual(self.run_fixture("excepted").status, Run.Status.SEALED)
        region.pop("exception")
        self.catalog.save(update_fields=["regions"])
        self.assertEqual(self.run_fixture("unresolved").status, Run.Status.INCOMPLETE)


    def test_disk_pressure_accounts_for_retained_inbox_bytes(self):
        (self.root / "preexisting").write_bytes(b"x" * 8192)
        with override_settings(ATLAS_LIMITS={
            "pbf": 128, "poly": 128, "run": 1024, "inbox": 8192, "free": 1,
        }):
            run = self.run_fixture("disk-pressure")
        artifact = run.artifacts.get(kind="pbf")
        self.assertEqual(artifact.error_code, "disk_pressure")
        self.assertEqual(self.provider.body_reads, 0)

    def test_conflicting_final_or_ancestor_is_an_integrity_incident(self):
        from unittest.mock import patch

        for cause in ("existing-file", "ancestor"):
            with self.subTest(cause=cause):
                run = launch_manual(cause, "operator")
                self.worker.work_tick(parallel=False, transfers=False)
                with patch.object(self.worker, "publish", return_value=None):
                    self.worker.work_tick(parallel=False)
                artifact = run.artifacts.get(kind="pbf")
                target = self.root / artifact.relative_path
                conflict = target if cause == "existing-file" else target.parent
                conflict.parent.mkdir(parents=True, exist_ok=True)
                conflict.write_bytes(b"preserve this evidence")
                self.worker.recover_publications()
                run.refresh_from_db()
                self.assertEqual(run.status, Run.Status.INTEGRITY_FAILED)
                self.assertEqual(conflict.read_bytes(), b"preserve this evidence")

    def test_mutable_poly_can_retry_the_same_frozen_url(self):
        from unittest.mock import patch

        run = launch_manual("rotate-poly", "operator")
        self.worker.work_tick(parallel=False)
        original = self.provider.download

        def rotated(pin, kind, target, limit, progress):
            if kind == Artifact.Kind.POLY:
                raise ProviderError("validator_changed", "The upstream POLY changed.")
            return original(pin, kind, target, limit, progress)

        with patch.object(self.provider, "download", side_effect=rotated):
            self.worker.work_tick(parallel=False)
        changed = run.artifacts.get(error_code="validator_changed")
        self.assertEqual(changed.status, Artifact.Status.PENDING)
        self.assertEqual(changed.requested_url, changed.resolved_url)
        run.artifacts.filter(pk=changed.pk).update(retry_at=timezone.now())
        self.assertEqual(self.run_fixture("rotate-poly").status, Run.Status.SEALED)
        self.assertTrue(changed.attempts.filter(status="auto_retry").exists())

    def test_publication_retries_are_bounded_and_operator_can_resume_without_redownloading(self):
        import errno
        import os
        from unittest.mock import patch

        first = launch_manual("publication-failure", "operator")
        later = launch_manual("later-run", "operator")
        install = self.worker.install_link

        def failing_link(artifact):
            if artifact.run_id == first.pk and artifact.kind == Artifact.Kind.PBF:
                raise OSError(errno.EIO, "fixture publication failure")
            return install(artifact)

        with patch.object(self.worker, "install_link", side_effect=failing_link) as link:
            self.worker.work_tick(parallel=False)
            pbf = first.artifacts.get(kind="pbf")
            stage = self.root / pbf.stage_path
            committed_intent = pbf.intent
            generation = pbf.generation

            # The running retrieval slot must be released even during backoff.
            self.assertEqual(self.run_fixture("later-run").status, Run.Status.SEALED)
            first.refresh_from_db()
            self.assertEqual(first.status, Run.Status.INCOMPLETE)

            for _ in range(2):
                Artifact.objects.filter(pk=pbf.pk).update(retry_at=timezone.now())
                self.worker.recover_publications()
            pbf.refresh_from_db()
            self.assertEqual(pbf.status, "publication_paused")
            self.assertTrue(pbf.retryable)
            self.assertIsNone(pbf.retry_at)
            calls = link.call_count
            self.worker.recover_publications()
            self.assertEqual(link.call_count, calls)

        old = (timezone.now() - timedelta(hours=25)).timestamp()
        os.utime(stage, (old, old))
        self.worker.clean_staging()
        self.assertEqual(stage.read_bytes(), PBF)
        self.assertEqual(pbf.intent, committed_intent)

        reads = self.provider.body_reads
        retry_artifact(first.pk, pbf.pk, "operator")
        retry_artifact(first.pk, pbf.pk, "operator")
        queued = launch_manual("third-run", "operator")
        self.assertEqual(self.worker.active_run().pk, queued.pk)
        self.worker.recover_publications()
        pbf.refresh_from_db()
        first.refresh_from_db()
        later.refresh_from_db()
        self.assertEqual(pbf.generation, generation)
        self.assertEqual(pbf.intent, committed_intent)
        self.assertEqual((self.root / pbf.relative_path).read_bytes(), PBF)
        self.assertEqual(self.provider.body_reads, reads)
        self.assertEqual(first.status, Run.Status.SEALED)
        self.assertEqual(later.status, Run.Status.SEALED)
        self.assertEqual(Audit.objects.filter(run=first, actor="operator", action="artifact.publication_resumed").count(), 1)
