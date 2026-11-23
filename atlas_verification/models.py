from uuid import uuid4

from django.db import models
from .fields import LosslessJSONField


class VerificationAttempt(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        PREPARED = "prepared", "Publishing"
        INPUT_INVALID = "input_invalid", "Input invalid"
        UNSUPPORTED = "unsupported_profile", "Unsupported profile"
        OPERATIONAL = "operational_failed", "Operational failure"
        VERIFIED = "verified", "Verified"
        WARNINGS = "verified_with_warnings", "Verified with warnings"

    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    run = models.ForeignKey("atlas_intake.Run", on_delete=models.PROTECT, related_name="verifications")
    request_key = models.CharField(max_length=96)
    requested_by = models.CharField(max_length=150)
    created_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.QUEUED, db_index=True)
    snapshot = models.JSONField(default=dict)
    input_fingerprint = models.CharField(max_length=64)
    tools = models.JSONField(default=dict)
    policy_version = models.CharField(max_length=64, default="atlas-input-v1")
    generation = models.PositiveIntegerField(default=0)
    lease_until = models.DateTimeField(null=True)
    progress = LosslessJSONField(default=dict)
    summary = LosslessJSONField(default=dict)
    error = models.TextField(blank=True)
    reserved_bytes = models.PositiveBigIntegerField(default=0)
    successful = models.BooleanField(default=False)
    build_eligible = models.BooleanField(default=False)
    manifest_path = models.TextField(blank=True)
    manifest_sha256 = models.CharField(max_length=64, blank=True)
    intended = models.JSONField(default=dict)
    finished_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["requested_by", "request_key"], name="verification_operator_request"),
            models.UniqueConstraint(fields=["status"], condition=models.Q(status="running"),
                                    name="one_active_verification"),
        ]


class VerificationExecution(models.Model):
    attempt = models.ForeignKey(VerificationAttempt, on_delete=models.PROTECT, related_name="executions")
    generation = models.PositiveIntegerField()
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(null=True)
    status = models.CharField(max_length=24, default="running")
    report = LosslessJSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["attempt", "generation"], name="verification_generation"),
        ]


class VerificationHealth(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    heartbeat = models.DateTimeField(null=True)
