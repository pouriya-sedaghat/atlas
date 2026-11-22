"""Fixture-only build control. Reports preserve source strings over bytea."""
from uuid import uuid4
from django.db import models
from atlas_verification.fields import LosslessJSONField


class BuildProfile(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid4,editable=False)
    scope=models.CharField(max_length=16,default='fixture',editable=False)
    enabled=models.BooleanField(default=False)
    epoch=models.UUIDField(default=uuid4,editable=False)
    coverage=LosslessJSONField(default=dict)
    bootstrap=models.BooleanField(default=False)
    actor=models.CharField(max_length=150)
    activated_at=models.DateTimeField(auto_now_add=True)
    class Meta:
        constraints=[models.CheckConstraint(condition=models.Q(scope='fixture'),name='build_fixture_scope_only')]


class BuildScope(models.Model):
    scope=models.CharField(primary_key=True,max_length=16,default='fixture')
    last_ready=models.ForeignKey('Candidate',null=True,on_delete=models.PROTECT,related_name='+')
    last_ready_order=models.PositiveBigIntegerField(default=0)
    class Meta:
        constraints=[models.CheckConstraint(condition=models.Q(scope='fixture'),name='only_fixture_baseline')]


class FixtureRunBinding(models.Model):
    run=models.OneToOneField('atlas_intake.Run',primary_key=True,on_delete=models.PROTECT)
    profile=models.ForeignKey(BuildProfile,on_delete=models.PROTECT)
    epoch=models.UUIDField()
    actor=models.CharField(max_length=150)
    created_at=models.DateTimeField(auto_now_add=True)


class BuildReceipt(models.Model):
    # Sequence allocated at publication/request, never by completion or dispatcher.
    id=models.BigAutoField(primary_key=True)
    verification=models.ForeignKey('atlas_verification.VerificationAttempt',on_delete=models.PROTECT)
    profile=models.ForeignKey(BuildProfile,on_delete=models.PROTECT)
    epoch=models.UUIDField()
    manifest_sha256=models.CharField(max_length=64)
    coverage=LosslessJSONField(default=dict)
    bootstrap=models.BooleanField(default=False)
    rebuild_nonce=models.CharField(max_length=96,blank=True)
    approval=models.ForeignKey('ShrinkApproval',null=True,on_delete=models.PROTECT,related_name='+')
    actor=models.CharField(max_length=150)
    requested_at=models.DateTimeField(auto_now_add=True)
    status=models.CharField(max_length=16,default='pending',db_index=True)
    error=models.TextField(blank=True)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['verification','rebuild_nonce'],name='one_build_publication_nonce')]


class ShrinkApproval(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid4,editable=False)
    profile=models.ForeignKey(BuildProfile,on_delete=models.PROTECT)
    baseline=models.ForeignKey('Candidate',on_delete=models.PROTECT)
    baseline_digest=models.CharField(max_length=64)
    proposed_digest=models.CharField(max_length=64)
    detail=LosslessJSONField(default=dict)
    actor=models.CharField(max_length=150)
    created_at=models.DateTimeField(auto_now_add=True)


class BuildIntent(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid4,editable=False)
    receipt=models.OneToOneField(BuildReceipt,on_delete=models.PROTECT)
    profile=models.ForeignKey(BuildProfile,on_delete=models.PROTECT)
    scope=models.CharField(max_length=16,default='fixture')
    request_order=models.PositiveBigIntegerField(unique=True)
    requested_at=models.DateTimeField()
    zone=models.CharField(max_length=64,default='Asia/Tehran')
    bundle_date=models.DateField()
    coverage=LosslessJSONField(default=dict)
    coverage_digest=models.CharField(max_length=64)
    fingerprint=models.CharField(max_length=64)
    versions=LosslessJSONField(default=dict)
    admission=LosslessJSONField(default=dict)
    status=models.CharField(max_length=24,default='queued',db_index=True)
    generation=models.PositiveIntegerField(default=0)
    error=models.TextField(blank=True)
    cancelled_at=models.DateTimeField(null=True)


class BuildExecution(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid4,editable=False)
    intent=models.ForeignKey(BuildIntent,on_delete=models.PROTECT,related_name='executions')
    generation=models.PositiveIntegerField()
    token=models.UUIDField(default=uuid4)
    status=models.CharField(max_length=24,default='running',db_index=True)
    started_at=models.DateTimeField()
    finished_at=models.DateTimeField(null=True)
    lease_until=models.DateTimeField(null=True)
    progress=LosslessJSONField(default=dict)
    report=LosslessJSONField(default=dict)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['intent','generation'],name='build_execution_generation'),
            models.UniqueConstraint(models.Value(1),condition=models.Q(status__in=['running','prepared']),name='one_active_build_execution')]


class Candidate(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid4,editable=False)
    execution=models.OneToOneField(BuildExecution,on_delete=models.PROTECT,related_name='candidate')
    status=models.CharField(max_length=24,default='CREATE_INTENT',db_index=True)
    identity=LosslessJSONField(default=dict)
    validation=LosslessJSONField(default=dict)
    bundle=LosslessJSONField(default=dict)
    publication_failures=models.PositiveSmallIntegerField(default=0)
    ready_at=models.DateTimeField(null=True)
    revoked_at=models.DateTimeField(null=True)
    cleanup_at=models.DateTimeField(null=True)


class DDLOperation(models.Model):
    candidate=models.ForeignKey(Candidate,on_delete=models.PROTECT,related_name='ddl')
    operation=models.CharField(max_length=24)
    intended=LosslessJSONField(default=dict)
    observed=LosslessJSONField(default=dict)
    status=models.CharField(max_length=16,default='intended')
    created_at=models.DateTimeField(auto_now_add=True)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['candidate','operation'],name='one_candidate_ddl_intent')]


class BuildReservation(models.Model):
    execution=models.OneToOneField(BuildExecution,primary_key=True,on_delete=models.PROTECT)
    filesystem=models.CharField(max_length=64)
    reserved_bytes=models.PositiveBigIntegerField()
    allocated_bytes=models.PositiveBigIntegerField(default=0)


class BuildHealth(models.Model):
    id=models.PositiveSmallIntegerField(primary_key=True,default=1)
    heartbeat=models.DateTimeField(null=True)
    legacy=LosslessJSONField(default=dict)
    legacy_until=models.DateTimeField(null=True)
