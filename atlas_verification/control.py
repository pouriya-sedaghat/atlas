import hashlib
import json
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction

from atlas_intake.control import audit, lock_control
from atlas_intake.models import Artifact, Run
from .models import VerificationAttempt, VerificationExecution


POLICY_VERSION = "atlas-input-v1"
SUCCESS = {VerificationAttempt.Status.VERIFIED, VerificationAttempt.Status.WARNINGS}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def input_fingerprint(snapshot):
    return hashlib.sha256(canonical(snapshot)).hexdigest()


def frozen_inputs(run):
    if run.status != Run.Status.SEALED:
        raise ValidationError("Choose an intact sealed intake run.")
    rows = list(run.artifacts.order_by("region_id", "kind", "pk"))
    regions = {r["id"] for r in run.catalog.regions}
    expected = {(r, "poly") for r in regions} | {(r, "pbf") for r in run.selection}
    actual = {(a.region_id, a.kind) for a in rows}
    if actual != expected or len(actual) != len(rows):
        raise ValidationError("The intake artifacts differ from the frozen catalog and selection.")
    artifacts = []
    for artifact in rows:
        excepted = artifact.kind == "poly" and artifact.status == Artifact.Status.EXCEPTED and artifact.exception
        if not excepted and (
            artifact.status != Artifact.Status.COMPLETE or not artifact.relative_path
            or artifact.actual_length is None or len(artifact.sha256) != 64
        ):
            raise ValidationError("The run has an incomplete or invalidated required artifact.")
        artifacts.append({
            "artifact_id": str(artifact.pk), "region_id": artifact.region_id, "kind": artifact.kind,
            "path": artifact.relative_path, "length": artifact.actual_length, "sha256": artifact.sha256,
            "exception": artifact.exception if excepted else {},
            "requested_url": artifact.requested_url, "resolved_url": artifact.resolved_url,
            "provider_checksum_status": artifact.checksum_status, "pin": artifact.pin,
            "received_at": artifact.finished_at.isoformat() if artifact.finished_at else None,
            "http_last_modified": artifact.http_last_modified,
        })
    result = {
        "run_id": str(run.pk), "catalog_digest": run.catalog_id,
        "retrieval_local_date": run.local_date.isoformat(), "zone": run.zone,
        "selected_pbfs": sorted(run.selection), "regions": sorted(regions), "artifacts": artifacts,
    }
    from atlas_build.control import fixture_binding
    binding = fixture_binding(run.pk)
    if binding:
        result["fixture"] = binding
    return result


@transaction.atomic
def request_verification(run_id, key, actor):
    if not isinstance(key, str) or not key or len(key) > 96:
        raise ValidationError("Reload the verification form to obtain a valid request key.")
    lock_control()
    # Resolve accepted request identity before eligibility, including after invalidation.
    previous = VerificationAttempt.objects.filter(requested_by=actor, request_key=key).first()
    if previous:
        return previous
    run = Run.objects.select_for_update().select_related("catalog").get(pk=run_id)
    snapshot = frozen_inputs(run)
    from .execute import tool_versions
    attempt = VerificationAttempt.objects.create(
        run=run, request_key=key, requested_by=actor, snapshot=snapshot,
        input_fingerprint=input_fingerprint(snapshot), policy_version=POLICY_VERSION,
        tools=tool_versions(),
    )
    audit("verification.requested", actor, run, verification=str(attempt.pk),
          input_fingerprint=attempt.input_fingerprint)
    return attempt


@transaction.atomic
def retry_verification(attempt_id, actor):
    lock_control()
    attempt = VerificationAttempt.objects.select_for_update().get(pk=attempt_id)
    if attempt.successful or attempt.status in {"queued", "running", "prepared"}:
        return attempt
    if attempt.status != VerificationAttempt.Status.OPERATIONAL:
        raise ValidationError("Only an operational verification failure can be retried.")
    attempt.status = VerificationAttempt.Status.PREPARED if attempt.intended else VerificationAttempt.Status.QUEUED
    fields=["status","error","finished_at"]
    if attempt.intended:
        from django.utils import timezone
        attempt.generation += 1
        attempt.intended = {**attempt.intended,"generation":attempt.generation}
        VerificationExecution.objects.create(
            attempt=attempt,generation=attempt.generation,started_at=timezone.now(),status="prepared",
        )
        fields.extend(["generation","intended"])
    attempt.error = ""
    attempt.finished_at = None
    attempt.save(update_fields=fields)
    audit("verification.retry_requested", actor, attempt.run, verification=str(attempt.pk))
    return attempt


def assert_current(attempt):
    run = Run.objects.select_related("catalog").get(pk=attempt.run_id)
    if frozen_inputs(run) != attempt.snapshot:
        raise ValidationError("The acquisition run no longer matches the verified input snapshot.")


def read_manifest(attempt):
    from .storage import read_checked
    if not attempt.successful:
        raise ValidationError("A complete verified result is unavailable.")
    data = read_checked(Path(settings.ATLAS_VERIFICATION_ROOT), attempt.manifest_path,
                        attempt.manifest_sha256, 4 * 1024**2)
    manifest = json.loads(data)
    from .manifest import validate_manifest
    validate_manifest("batch",manifest)
    if manifest.get("schema_version") != 1 or manifest.get("policy_version") != POLICY_VERSION:
        raise ValidationError("The verification manifest version is unsupported.")
    return manifest


def get_handoff(attempt_id, verify_outputs=True):
    from .storage import hash_file
    attempt = VerificationAttempt.objects.get(pk=attempt_id)
    assert_current(attempt)
    manifest = read_manifest(attempt)
    if manifest.get("input_fingerprint") != attempt.input_fingerprint:
        raise ValidationError("The verification manifest has an inconsistent input identity.")
    if verify_outputs:
        root = Path(settings.ATLAS_VERIFICATION_ROOT)
        for output in attempt.intended.get("files", []):
            length, digest = hash_file(root, output["path"], expected_size=output["size"])
            if length != output["size"] or digest != output["sha256"]:
                raise ValidationError("A registered verification output is missing or has changed.")
    # Recheck after potentially long output reads, so a concurrent invalidation
    # cannot be hidden by the earlier eligibility check.
    assert_current(attempt)
    result = {
        "run_id": str(attempt.run_id), "verification_id": str(attempt.pk),
        "manifest_schema_version": 1, "policy_version": attempt.policy_version,
        "manifest_path": attempt.manifest_path, "manifest_sha256": attempt.manifest_sha256,
        "build_eligible": attempt.build_eligible and manifest.get("build_eligible") is True,
    }
    if manifest.get("fixture"):
        result["fixture"] = manifest["fixture"]
    return result
