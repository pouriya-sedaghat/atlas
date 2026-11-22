"""Scoped receipt admission; global Control is never acquired by the publisher."""
import hashlib
import re
from zoneinfo import ZoneInfo
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection,transaction
from django.utils import timezone
from atlas_intake.control import lock_control,audit
from atlas_intake.models import Run
from atlas_verification.control import canonical
from atlas_verification.diagnostics import diagnostic_text
from .models import BuildProfile,BuildScope,FixtureRunBinding,BuildReceipt,BuildIntent,ShrinkApproval

VERSIONS={'importer':'atlas-copy-v1','schema':'atlas-raw-v1','policy':'atlas-build-fixture-v1',
          'ir':1,'verification_policy':'atlas-input-v1','postgres':'17.12','postgis':'3.7.0'}


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def fixture_guard():
    if (not settings.ATLAS_BUILD_FIXTURE_MODE or connection.settings_dict['NAME'] not in
            {'atlas_fixture','test_atlas_fixture'}):
        raise ValidationError('Fixture builds require the isolated opted-in QA control database.')


def coverage(value):
    if not isinstance(value,dict) or set(value)!={'pbfs','boundary_only','exceptions'}:
        raise ValidationError('Complete PBF, boundary-only and exception intent is required.')
    result={}
    for key in ['pbfs','boundary_only']:
        rows=value[key]
        if (not isinstance(rows,list) or len(rows)>10000 or any(not isinstance(s,str) or
             not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_/-]{0,199}',s) for s in rows)
             or len(set(rows))!=len(rows)):
            raise ValidationError('Coverage contains invalid or duplicate region identities.')
        result[key]=sorted(rows)
    if set(result['pbfs'])&set(result['boundary_only']):raise ValidationError('Coverage roles overlap.')
    if not isinstance(value['exceptions'],list):raise ValidationError('Exceptions must be explicit.')
    result['exceptions']=value['exceptions']
    return result


@transaction.atomic
def activate_fixture_profile(expected,actor,*,bootstrap=False):
    fixture_guard();lock_control()
    BuildScope.objects.get_or_create(scope='fixture')
    p=BuildProfile.objects.create(enabled=True,coverage=coverage(expected),bootstrap=bootstrap,actor=actor)
    audit('build.fixture_activated',actor,profile=str(p.pk),epoch=str(p.epoch))
    return p


@transaction.atomic
def bind_fixture_run(run_id,profile_id,actor):
    fixture_guard();lock_control()
    run=Run.objects.select_for_update().get(pk=run_id)
    p=BuildProfile.objects.select_for_update().get(pk=profile_id)
    if (not p.enabled or run.created_at<p.activated_at or run.verifications.exists()
            or FixtureRunBinding.objects.filter(pk=run_id).exists()):
        raise ValidationError('Only a new unverified QA fixture may opt into this activation.')
    return FixtureRunBinding.objects.create(run=run,profile=p,epoch=p.epoch,actor=actor)


def fixture_binding(run_id):
    row=FixtureRunBinding.objects.filter(run_id=run_id).first()
    if row:return {'scope':'fixture','profile':str(row.profile_id),'epoch':str(row.epoch)}
    return None


def publication_receipt(attempt):
    # Called inside Run -> VerificationAttempt publication transaction. No Control
    # or profile row lock here; the independent dispatcher validates current epoch.
    binding=attempt.snapshot.get('fixture')
    if not settings.ATLAS_BUILD_FIXTURE_MODE or not binding or not attempt.successful or not attempt.build_eligible:return None
    fixture_guard()
    p=BuildProfile.objects.get(pk=binding['profile'])
    if not p.enabled or str(p.epoch)!=binding['epoch']:return None
    row,_=BuildReceipt.objects.get_or_create(verification=attempt,rebuild_nonce='',defaults={
        'profile':p,'epoch':p.epoch,'manifest_sha256':attempt.manifest_sha256,'coverage':p.coverage,
        'bootstrap':p.bootstrap,'actor':attempt.requested_by})
    return row


def compare_baseline(profile,expected,*,bootstrap,approval_id=None):
    expected=coverage(expected)
    baseline=BuildScope.objects.select_related('last_ready__execution__intent').get(pk=profile.scope).last_ready
    evidence={'baseline':str(baseline.pk) if baseline else None,'proposed_digest':digest(expected)}
    if baseline is None:
        if not bootstrap:raise ValidationError('An explicit fixture bootstrap is required.')
        return {**evidence,'bootstrap':True,'removed':{}}
    old=baseline.execution.intent.coverage
    removed={'pbfs':sorted(set(old['pbfs'])-set(expected['pbfs'])),
             'boundaries':sorted((set(old['pbfs'])|set(old['boundary_only']))-
                                 (set(expected['pbfs'])|set(expected['boundary_only'])))}
    evidence.update(baseline_digest=digest(old),removed=removed)
    if any(removed.values()) or old['exceptions']!=expected['exceptions']:
        approval=ShrinkApproval.objects.filter(pk=approval_id,profile=profile,baseline=baseline,
                    baseline_digest=digest(old),proposed_digest=digest(expected)).first()
        if (not approval or approval.detail.get('removed')!=removed or not approval.detail.get('reason')):
            raise ValidationError('Coverage shrink or changed exceptions requires approval for the actual baseline.')
        evidence['approval']=str(approval.pk)
    return evidence


def dispatch_receipts(*,receipt_ids=None,limit=8,checkpoint=lambda:None):
    fixture_guard()
    from .inputs import validate_inputs
    rows=BuildReceipt.objects.filter(status='pending').order_by('pk')
    if receipt_ids is not None:rows=rows.filter(pk__in=receipt_ids)
    admitted=[]
    for pk in list(rows.values_list('pk',flat=True)[:limit]):
        receipt=BuildReceipt.objects.select_related('profile').get(pk=pk)
        try:
            graph=validate_inputs(receipt.verification_id,checkpoint)
            with transaction.atomic():
                lock_control()
                r=BuildReceipt.objects.select_for_update().get(pk=pk)
                p=BuildProfile.objects.select_for_update().get(pk=r.profile_id)
                if r.status!='pending':continue
                if (not p.enabled or p.epoch!=r.epoch or r.manifest_sha256!=graph['handoff']['manifest_sha256']
                        or graph['fixture']!={'scope':'fixture','profile':str(p.pk),'epoch':str(p.epoch)}
                        or coverage(r.coverage)!=graph['coverage'] or p.coverage!=r.coverage):
                    raise ValidationError('Activation, handoff or frozen coverage no longer matches.')
                from atlas_verification.control import assert_current
                from atlas_verification.models import VerificationAttempt
                assert_current(VerificationAttempt.objects.get(pk=r.verification_id))
                comparison=compare_baseline(p,r.coverage,bootstrap=r.bootstrap,approval_id=r.approval_id)
                key=digest({'manifest':r.manifest_sha256,'coverage':r.coverage,'versions':VERSIONS,
                            'profile':str(p.pk),'epoch':str(r.epoch),'nonce':r.rebuild_nonce})
                intent,created=BuildIntent.objects.get_or_create(receipt=r,defaults={
                    'profile':p,'request_order':r.pk,'requested_at':r.requested_at,
                    'bundle_date':r.requested_at.astimezone(ZoneInfo('Asia/Tehran')).date(),
                    'coverage':r.coverage,'coverage_digest':digest(r.coverage),'fingerprint':key,
                    'versions':VERSIONS,'admission':comparison})
                r.status='admitted';r.save(update_fields=['status'])
                if created:
                    audit('build.admitted',r.actor,verification=str(r.verification_id),intent=str(intent.pk),order=r.pk)
                    admitted.append(str(intent.pk))
        except (ValidationError,OSError,ValueError,KeyError) as exc:
            BuildReceipt.objects.filter(pk=pk,status='pending').update(status='blocked',error=diagnostic_text(exc))
    return admitted


@transaction.atomic
def advance_baseline(candidate_id):
    from .models import Candidate
    fixture_guard();lock_control()
    c=Candidate.objects.select_related('execution__intent__profile').get(pk=candidate_id)
    intent=c.execution.intent
    if c.status!='READY' or not c.ready_at or c.execution.generation!=intent.generation:
        raise ValidationError('Only the current READY generation may advance a scope baseline.')
    scope=BuildScope.objects.select_for_update().get(pk=intent.profile.scope)
    if intent.request_order>scope.last_ready_order:
        scope.last_ready=c;scope.last_ready_order=intent.request_order
        scope.save(update_fields=['last_ready','last_ready_order'])
    return scope


@transaction.atomic
def request_rebuild(intent_id,nonce,actor):
    fixture_guard();lock_control()
    if not isinstance(nonce,str) or not nonce or len(nonce)>96:
        raise ValidationError('An intentional rebuild needs a fresh explicit nonce.')
    original=BuildIntent.objects.select_related('receipt','profile').get(pk=intent_id)
    p=original.profile
    if not p.enabled or p.epoch!=original.receipt.epoch:raise ValidationError('Activation no longer current.')
    row,_=BuildReceipt.objects.get_or_create(verification=original.receipt.verification,
            rebuild_nonce=nonce,defaults={'profile':p,'epoch':p.epoch,'manifest_sha256':original.receipt.manifest_sha256,
            'coverage':p.coverage,'bootstrap':False,'actor':actor})
    return row


@transaction.atomic
def approve_receipt(receipt_id,baseline_id,actor,reason):
    fixture_guard();lock_control()
    if not reason or len(reason)>2000:raise ValidationError('Coverage approval requires an explicit bounded reason.')
    receipt=BuildReceipt.objects.select_for_update().select_related('profile').get(pk=receipt_id)
    scope=BuildScope.objects.select_for_update(of=('self',)).select_related('last_ready__execution__intent').get(pk='fixture')
    baseline=scope.last_ready
    if not baseline or str(baseline.pk)!=str(baseline_id):raise ValidationError('Approval must identify the actual current scope baseline.')
    if receipt.status not in ['pending','blocked'] or BuildIntent.objects.filter(receipt=receipt).exists():
        raise ValidationError('Only an unadmitted receipt can receive coverage approval.')
    if not receipt.profile.enabled or receipt.epoch!=receipt.profile.epoch:raise ValidationError('Receipt activation changed.')
    old=baseline.execution.intent.coverage;proposed=coverage(receipt.coverage)
    removed={'pbfs':sorted(set(old['pbfs'])-set(proposed['pbfs'])),
             'boundaries':sorted((set(old['pbfs'])|set(old['boundary_only']))-(set(proposed['pbfs'])|set(proposed['boundary_only'])))}
    approval=ShrinkApproval.objects.create(profile=receipt.profile,baseline=baseline,baseline_digest=digest(old),
         proposed_digest=digest(proposed),actor=actor,detail={'removed':removed,'proposed':proposed,'reason':reason,'receipt':receipt.pk})
    receipt.approval=approval;receipt.status='pending';receipt.error='';receipt.save(update_fields=['approval','status','error'])
    audit('build.coverage_approved',actor,receipt=receipt.pk,approval=str(approval.pk),baseline=str(baseline.pk),reason=diagnostic_text(reason))
    return approval
