from uuid import uuid4

from django.db import models


class CatalogRevision(models.Model):
    digest = models.CharField(max_length=64, primary_key=True)
    source_digest = models.CharField(max_length=64, blank=True)
    regions = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)


class Schedule(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        DISPATCHED = "dispatched", "Dispatched"
        MISSED = "missed", "Missed"
        SUPERSEDED = "superseded", "Superseded"

    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    wall_date = models.DateField()
    wall_time = models.TimeField()
    zone = models.CharField(max_length=128)
    offset = models.CharField(max_length=6, blank=True)
    due_at = models.DateTimeField()
    selection = models.JSONField(default=list)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)


class Control(models.Model):
    class Mode(models.TextChoices):
        MANUAL = "manual", "Manual"
        AUTOMATIC = "automatic", "Automatic"

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    mode = models.CharField(max_length=12, choices=Mode.choices, default=Mode.MANUAL)
    selection = models.JSONField(default=list)
    catalog = models.ForeignKey(CatalogRevision, on_delete=models.PROTECT, null=True)
    schedule = models.ForeignKey(Schedule, on_delete=models.PROTECT, null=True)
    catalog_error = models.TextField(blank=True)
    catalog_refresh_requested = models.BooleanField(default=True)
    catalog_checked_at = models.DateTimeField(null=True)
    worker_heartbeat = models.DateTimeField(null=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name="one_atlas_control")]
        permissions = [("operate", "Can operate Atlas intake")]


class Run(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        INCOMPLETE = "incomplete", "Incomplete"
        SEALED = "sealed", "Sealed"
        INTEGRITY_FAILED = "integrity_failed", "Integrity failure"

    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    request_key = models.CharField(max_length=180, unique=True)
    origin = models.CharField(max_length=12, choices=Control.Mode.choices)
    actor = models.CharField(max_length=150)
    catalog = models.ForeignKey(CatalogRevision, on_delete=models.PROTECT)
    schedule = models.OneToOneField(Schedule, on_delete=models.PROTECT, null=True)
    selection = models.JSONField(default=list)
    limits = models.JSONField(default=dict)
    zone = models.CharField(max_length=128)
    created_at = models.DateTimeField()
    local_date = models.DateField(db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.QUEUED)
    issue = models.TextField(blank=True)
    sealed_at = models.DateTimeField(null=True)
    preflight_passed = models.BooleanField(default=False)

    class Meta:
        indexes = [models.Index(fields=["status", "created_at"])]


class Artifact(models.Model):
    class Kind(models.TextChoices):
        PBF = "pbf", "PBF"
        POLY = "poly", "POLY"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        TRANSFERRING = "transferring", "Transferring"
        PREPARED = "prepared", "Prepared"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed"
        UNAVAILABLE = "unavailable", "Unavailable"
        EXCEPTED = "excepted", "Provider exception"
        INTEGRITY_FAILED = "integrity_failed", "Integrity failure"

    run = models.ForeignKey(Run, on_delete=models.PROTECT, related_name="artifacts")
    region_id = models.CharField(max_length=200)
    region_name = models.CharField(max_length=255)
    kind = models.CharField(max_length=4, choices=Kind.choices)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    relative_path = models.TextField(blank=True)
    requested_url = models.TextField(blank=True)
    sidecar_url = models.TextField(blank=True)
    resolved_url = models.TextField(blank=True)
    resolved_at = models.DateTimeField(null=True)
    pinned_at = models.DateTimeField(null=True)
    pin = models.JSONField(default=dict)
    exception = models.JSONField(default=dict)
    stage_path = models.TextField(blank=True)
    intent = models.JSONField(default=dict)
    expected_length = models.PositiveBigIntegerField(null=True)
    actual_length = models.PositiveBigIntegerField(null=True)
    sha256 = models.CharField(max_length=64, blank=True)
    checksum_status = models.CharField(max_length=20, blank=True)
    http_last_modified = models.TextField(blank=True)
    content_timestamp = models.DateTimeField(null=True)
    bytes_received = models.PositiveBigIntegerField(default=0)
    reserved_bytes = models.PositiveBigIntegerField(default=0)
    generation = models.PositiveIntegerField(default=0)
    lease_until = models.DateTimeField(null=True)
    attempt_count = models.PositiveIntegerField(default=0)
    retry_at = models.DateTimeField(null=True)
    retryable = models.BooleanField(default=False)
    error_code = models.CharField(max_length=64, blank=True)
    error = models.TextField(blank=True)
    finished_at = models.DateTimeField(null=True)
    integrity_checked_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["run", "region_id", "kind"], name="one_artifact_per_intent")]
        indexes = [models.Index(fields=["run", "status"]), models.Index(fields=["status", "integrity_checked_at"])]


class Attempt(models.Model):
    artifact = models.ForeignKey(Artifact, on_delete=models.PROTECT, related_name="attempts")
    generation = models.PositiveIntegerField()
    status = models.CharField(max_length=20, default="transferring")
    stage_path = models.TextField(blank=True)
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(null=True)
    error = models.TextField(blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["artifact", "generation"], name="one_attempt_per_generation")]


class Audit(models.Model):
    run = models.ForeignKey(Run, on_delete=models.PROTECT, null=True, related_name="audit_events")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    actor = models.CharField(max_length=150)
    action = models.CharField(max_length=64)
    detail = models.JSONField(default=dict)
