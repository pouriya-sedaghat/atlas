"""One supervised fixture builder with short Control-first fenced transitions."""
import json,os,selectors,signal,subprocess,sys,time
from datetime import timedelta
from pathlib import Path
from uuid import UUID,uuid4
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection,transaction
from django.db.models import Q
from django.utils import timezone
from atlas_intake.control import lock_control,audit
from atlas_intake.models import Run
from atlas_intake.storage import make_directories,sync_directory
from atlas_verification.control import assert_current,canonical
from atlas_verification.models import VerificationAttempt
from atlas_verification.diagnostics import diagnostic_text
from atlas_verification.storage import safe_open
from atlas_verification.resources import CgroupObservation
from .models import BuildIntent,BuildExecution,Candidate,DDLOperation,BuildReservation,BuildHealth,BuildScope
from .control import fixture_guard,dispatch_receipts,coverage,compare_baseline,digest,VERSIONS
from .capacity import allocated_bytes,admission_capacity,growth_check,legacy_window,RESERVATION,lsn_bytes,AdmissionDeferred
from .inputs import validate_inputs
from .provision import operation_marker
from . import rpc

LEASE=timedelta(seconds=60)
ACTIVE=('running','prepared')
# A five-second metrics budget tolerates quota-bound catalog/stat observations,
# while three failures plus termination still fit the 30-second wall margin.
METRIC_TIMEOUT=5

class RevalidationUnavailable(ValidationError):
    pass


def heartbeat():BuildHealth.objects.update_or_create(pk=1,defaults={'heartbeat':timezone.now()})

def work_relative(e):return f'build-work/{e.intent_id}/{e.generation}'


def current(e,token):
    return (str(e.token)==str(token) and e.status in ACTIVE and e.intent.generation==e.generation
        and not e.intent.cancelled_at and e.lease_until and e.lease_until>timezone.now()
        and e.intent.profile.enabled and e.intent.profile.epoch==e.intent.receipt.epoch)


def locked_execution(execution_id):
    # Caller already holds Control. Row relationships are immutable; avoid FOR
    # UPDATE over nullable joins and never hold this across external operations.
    e=BuildExecution.objects.select_for_update(of=('self',)).select_related('intent__profile','intent__receipt').get(pk=execution_id)
    c=Candidate.objects.select_for_update().get(execution=e)
    return e,c


@transaction.atomic
def phase(execution_id,token,state,*,identity=None,validation=None,bundle=None,report=None,operation=None,observed_operation=None):
    fixture_guard();lock_control();e,c=locked_execution(execution_id)
    if not current(e,token):raise ValidationError('Builder generation lost its lease or authorization.')
    c.status=state
    if identity is not None:c.identity=identity
    if validation is not None:c.validation=validation
    if bundle is not None:c.bundle=bundle
    if report is not None:e.report=report
    if state=='BUNDLE_PREPARED':e.status='prepared'
    c.save();e.progress={**e.progress,'phase':state};e.save()
    if operation:DDLOperation.objects.get_or_create(candidate=c,operation=operation,defaults={'intended':{'marker':operation_marker(c,e)}})
    if observed_operation:
        name,proof=observed_operation
        if name not in ['create','freeze']:raise ValidationError('Unsupported observed DDL operation.')
        record=DDLOperation.objects.select_for_update().get(candidate=c,operation=name)
        record.observed=proof;record.status='completed';record.save(update_fields=['observed','status'])
    audit('build.phase','builder',candidate=str(c.pk),execution=str(e.pk),generation=e.generation,state=state)
    return c


@transaction.atomic
def cancel_build(intent_id,actor,reason):
    fixture_guard();lock_control();i=BuildIntent.objects.select_for_update().get(pk=intent_id)
    if not reason or len(reason)>2000:raise ValidationError('Cancellation needs a bounded reason.')
    if i.status=='ready':raise ValidationError('READY evidence is immutable; revalidate eligibility instead.')
    i.cancelled_at=timezone.now();i.error=diagnostic_text(reason)
    if i.status in ['queued','blocked','resume_queued']:i.status='cancelled'
    i.save(update_fields=['cancelled_at','error','status'])
    audit('build.cancel_requested',actor,intent=str(i.pk),reason=diagnostic_text(reason))


@transaction.atomic
def retry_build(intent_id,actor,reason):
    fixture_guard();lock_control();i=BuildIntent.objects.select_for_update().get(pk=intent_id)
    old=i.executions.order_by('-generation').first()
    if not reason or len(reason)>2000 or not old or old.status not in ['failed','cancelled'] or not old.candidate.cleanup_at:
        raise ValidationError('Retry needs a terminal execution, checked cleanup and an explicit reason.')
    if not i.profile.enabled or i.profile.epoch!=i.receipt.epoch:raise ValidationError('Activation no longer current.')
    i.status='queued';i.cancelled_at=None;i.error='';i.save(update_fields=['status','cancelled_at','error'])
    audit('build.retry_requested',actor,intent=str(i.pk),reason=diagnostic_text(reason))


@transaction.atomic
def resume_publication(intent_id,actor,reason):
    fixture_guard();lock_control();i=BuildIntent.objects.select_for_update().get(pk=intent_id)
    e=i.executions.order_by('-generation').first()
    if (not reason or len(reason)>2000 or not e or e.status!='publication_paused' or not e.candidate.bundle
            or e.candidate.status!='PUBLICATION_PAUSED' or i.cancelled_at):
        raise ValidationError('Only a paused frozen publication can be resumed without importing.')
    i.status='resume_queued';i.error='';i.save(update_fields=['status','error'])
    audit('build.publication_resume_requested',actor,intent=str(i.pk),candidate=str(e.candidate.pk),reason=diagnostic_text(reason))


def cleanup_candidate(candidate_id,actor,reason,*,explicit=False):
    fixture_guard()
    if not reason or len(reason)>2000:raise ValidationError('Cleanup needs a bounded audited reason.')
    with transaction.atomic():
        lock_control();c=Candidate.objects.select_related('execution__intent__receipt').select_for_update(of=('self',)).get(pk=candidate_id);e=c.execution
        if c.ready_at or c.status=='READY':raise ValidationError('READY resources are never cleanup targets.')
        if c.cleanup_at:return c
        if e.status in ACTIVE:raise ValidationError('Cancel and stop the active execution before cleanup.')
        if not explicit and (not e.finished_at or timezone.now()-e.finished_at<timedelta(hours=24)):
            raise ValidationError('Automatic cleanup grace has not elapsed.')
        DDLOperation.objects.get_or_create(candidate=c,operation='drop',defaults={'intended':{
             'marker':operation_marker(c,e),'explicit':explicit,'actor':actor,'reason':diagnostic_text(reason)}})
        audit('build.cleanup_requested',actor,candidate=str(c.pk),explicit=explicit,reason=diagnostic_text(reason))
    result=rpc.call('drop',c.pk,e.pk,e.token)
    with transaction.atomic():
        lock_control();c=Candidate.objects.select_for_update().get(pk=c.pk)
        if c.ready_at:raise ValidationError('Candidate unexpectedly became READY; cleanup is quarantined.')
        c.cleanup_at=timezone.now();c.save(update_fields=['cleanup_at'])
        DDLOperation.objects.filter(candidate=c,operation='drop').update(status='completed',observed=result)
        audit('build.cleaned',actor,candidate=str(c.pk),explicit=explicit)
    return c


class BuildWorker:
    def __init__(self,root=None,child_command=None,wall_seconds=270):
        fixture_guard();self.root=Path(root or settings.ATLAS_BUILD_ROOT)
        if self.root.is_symlink():raise ValidationError('Builder root may not be a symlink.')
        self.root=self.root.resolve(strict=True);self.child_command=child_command;self.wall_seconds=wall_seconds
        make_directories(self.root,self.root/'build-work')

    def input_checkpoint(self):
        started=time.monotonic();last=0
        def check():
            nonlocal last
            now=time.monotonic()
            if now-started>270:raise ValidationError('Bounded input validation deadline reached before claim.')
            if now-last>=1:heartbeat();last=now
        return check

    def claim(self,checkpoint=None):
        fixture_guard();checkpoint=checkpoint or self.input_checkpoint()
        row=BuildIntent.objects.filter(status__in=['queued','resume_queued']).order_by('request_order').first()
        if not row:return None
        try:
            graph=validate_inputs(row.receipt.verification_id,checkpoint)
            if (graph['coverage']!=coverage(row.coverage) or graph['handoff']['manifest_sha256']!=row.receipt.manifest_sha256
                    or row.versions!=VERSIONS):raise ValidationError('Frozen build input identity changed.')
            legacy=legacy_window()
            if not all(k in legacy for k in ['candidate_bytes','new_service_uncommitted']):raise ValidationError('Complete new-service capacity observation is required.')
            used=allocated_bytes([self.root])+legacy['candidate_bytes']
            with transaction.atomic():
                lock_control()
                if BuildExecution.objects.filter(status__in=ACTIVE).exists():return None
                # A new failure must not create a second retained failed DB.
                if Candidate.objects.filter(status__in=['FAILED','CANCELLED'],cleanup_at__isnull=True).exists():return None
                run=Run.objects.select_for_update().get(pk=row.receipt.verification.run_id)
                attempt=VerificationAttempt.objects.select_for_update().get(pk=row.receipt.verification_id);assert_current(attempt)
                i=BuildIntent.objects.select_for_update().select_related('profile','receipt').get(pk=row.pk)
                if i.status not in ['queued','resume_queued'] or i.cancelled_at:return None
                if not i.profile.enabled or i.profile.epoch!=i.receipt.epoch:raise ValidationError('Fixture activation no longer current.')
                comparison=compare_baseline(i.profile,i.coverage,bootstrap=i.receipt.bootstrap,approval_id=i.admission.get('approval'))
                capacity=admission_capacity(self.root,used,new_service_uncommitted=legacy['new_service_uncommitted'])
                capacity['legacy']={key:legacy[key] for key in ['quiescent','inventory_digest','headroom_bytes','observed_at'] if key in legacy}
                resume=i.status=='resume_queued'
                if resume:
                    e=i.executions.select_for_update().get(generation=i.generation)
                    c=Candidate.objects.select_for_update().get(execution=e)
                    if e.status!='publication_paused' or c.status!='PUBLICATION_PAUSED':raise ValidationError('Paused publication changed.')
                    e.token=uuid4();e.status='running';e.finished_at=None;e.lease_until=timezone.now()+LEASE
                    e.progress={**e.progress,'resume':True,'capacity':capacity,'coverage_comparison':comparison};e.save()
                    c.status='BUNDLE_PREPARED';c.save(update_fields=['status'])
                else:
                    i.generation+=1
                    e=BuildExecution.objects.create(intent=i,generation=i.generation,started_at=timezone.now(),lease_until=timezone.now()+LEASE,
                         progress={'phase':'CREATE_INTENT','resume':False,'capacity':capacity,'coverage_comparison':comparison})
                    c=Candidate.objects.create(execution=e)
                    DDLOperation.objects.create(candidate=c,operation='create',intended={'marker':operation_marker(c,e)})
                i.status='running';i.save(update_fields=['generation','status'])
                BuildReservation.objects.update_or_create(execution=e,defaults={'filesystem':capacity['filesystem'],'reserved_bytes':RESERVATION,'allocated_bytes':0})
                audit('build.claimed','builder',intent=str(i.pk),execution=str(e.pk),candidate=str(c.pk),generation=e.generation,resume=resume)
                return e
        except AdmissionDeferred as error:
            BuildIntent.objects.filter(pk=row.pk,status__in=['queued','resume_queued']).update(error=diagnostic_text(error))
            return None
        except (ValidationError,OSError,ValueError,KeyError) as error:
            BuildIntent.objects.filter(pk=row.pk,status__in=['queued','resume_queued']).update(status='blocked',error=diagnostic_text(error))
            return None

    @transaction.atomic
    def renew(self,execution_id,token,progress):
        lock_control();e,c=locked_execution(execution_id)
        if not current(e,token):return False
        e.lease_until=timezone.now()+LEASE;e.progress={**e.progress,**progress}
        if len(canonical(e.progress))>16384:raise ValidationError('Builder progress exceeds its bounded control record.')
        e.save(update_fields=['lease_until','progress']);heartbeat();return True

    def finish_failure(self,execution_id,token,message,*,paused=False):
        with transaction.atomic():
            lock_control();e,c=locked_execution(execution_id)
            if str(e.token)!=str(token) or (e.status not in ACTIVE and not(e.status=='publication_paused' and e.intent.cancelled_at)):return False
            paused=bool(paused and not e.intent.cancelled_at and c.bundle and c.status in ['BUNDLE_PREPARED','PUBLICATION_PAUSED'])
            status='publication_paused' if paused else 'cancelled' if e.intent.cancelled_at else 'failed'
            e.status=status;e.finished_at=timezone.now();e.lease_until=None;e.report={**e.report,'failure':diagnostic_text(message)};e.save()
            c.status='PUBLICATION_PAUSED' if paused else 'CANCELLED' if status=='cancelled' else 'FAILED';c.save(update_fields=['status'])
            e.intent.status=status;e.intent.error=diagnostic_text(message);e.intent.save(update_fields=['status','error'])
            BuildReservation.objects.filter(execution=e).update(reserved_bytes=0,allocated_bytes=0)
            if not paused:DDLOperation.objects.get_or_create(candidate=c,operation='cancel',defaults={'intended':{'marker':operation_marker(c,e)}})
            audit('build.'+status,'builder',candidate=str(c.pk),execution=str(e.pk),reason=diagnostic_text(message))
        if not paused:
            try:
                result=rpc.call('cancel',c.pk,e.pk,e.token,timeout=3,attempts=3)
                DDLOperation.objects.filter(candidate=c,operation='cancel').update(status='completed',observed=result)
            except ValidationError as error:
                DDLOperation.objects.filter(candidate=c,operation='cancel').update(status='quarantined',observed={'error':diagnostic_text(error)})
        return True

    def recover(self):
        for operation in DDLOperation.objects.filter(operation='drop',status='intended').select_related('candidate')[:8]:
            intended=operation.intended
            if intended.get('explicit') and not operation.candidate.ready_at:
                try:cleanup_candidate(operation.candidate_id,intended.get('actor','operator'),intended.get('reason',''),explicit=True)
                except ValidationError as error:
                    DDLOperation.objects.filter(pk=operation.pk).update(status='quarantined',observed={'error':diagnostic_text(error)})
        for e in BuildExecution.objects.filter(Q(status__in=ACTIVE)|Q(status='publication_paused',intent__cancelled_at__isnull=False)).select_related('intent','candidate'):
            if e.intent.cancelled_at or not e.lease_until or e.lease_until<=timezone.now():
                self.finish_failure(e.pk,e.token,'Builder lease expired or cancellation was requested.',paused=bool(e.candidate.bundle and not e.intent.cancelled_at))
        for c in Candidate.objects.filter(status__in=['FAILED','CANCELLED'],cleanup_at__isnull=True,
                    execution__finished_at__lte=timezone.now()-timedelta(hours=24)).order_by('execution__finished_at')[:1]:
            try:cleanup_candidate(c.pk,'builder','Automatic owned failed-candidate cleanup after 24-hour grace.')
            except ValidationError:pass # Preserve unknown ownership for the operator; never force-delete.

    @transaction.atomic
    def complete(self,execution_id,token,report):
        lock_control()
        preliminary=BuildExecution.objects.select_related('intent__profile','intent__receipt__verification').get(pk=execution_id)
        if not current(preliminary,token):return False
        Run.objects.select_for_update().get(pk=preliminary.intent.receipt.verification.run_id)
        attempt=VerificationAttempt.objects.select_for_update().get(pk=preliminary.intent.receipt.verification_id);assert_current(attempt)
        e,c=locked_execution(execution_id)
        if not current(e,token):return False
        if (report.get('outcome')!='READY' or c.status!='BUNDLE_PREPARED' or not c.bundle
                or report.get('logical_fingerprint')!=c.validation.get('logical_fingerprint')
                or report.get('index_sha256')!=c.bundle.get('index_sha256')):raise ValidationError('Incomplete candidate proof cannot register READY.')
        comparison=compare_baseline(e.intent.profile,e.intent.coverage,bootstrap=e.intent.receipt.bootstrap,approval_id=e.intent.admission.get('approval'))
        if comparison!=report.get('coverage_comparison'):raise ValidationError('Current coverage baseline changed after final validation.')
        observed=timezone.datetime.fromisoformat(report['validated_at'])
        if observed.tzinfo is None or (timezone.now()-observed).total_seconds()>10:raise ValidationError('Final candidate proof is stale.')
        c.status='READY';c.ready_at=timezone.now();c.save(update_fields=['status','ready_at'])
        e.status='ready';e.finished_at=c.ready_at;e.lease_until=None;e.report={**e.report,'completion':report};e.save()
        e.intent.status='ready';e.intent.save(update_fields=['status'])
        scope=BuildScope.objects.select_for_update().get(pk='fixture')
        if e.intent.request_order>scope.last_ready_order:
            scope.last_ready=c;scope.last_ready_order=e.intent.request_order;scope.save(update_fields=['last_ready','last_ready_order'])
        BuildReservation.objects.filter(execution=e).update(reserved_bytes=0,allocated_bytes=0)
        audit('build.ready','builder',candidate=str(c.pk),execution=str(e.pk),index_sha256=c.bundle['index_sha256'],logical_fingerprint=c.validation['logical_fingerprint'])
        return True

    def execute(self,e):
        directory=self.root/work_relative(e);make_directories(self.root,directory);os.chmod(directory,0o700)
        command=self.child_command or [sys.executable,'manage.py','atlas_build_execute',str(e.pk),str(e.token)]
        env={**os.environ,'POSTGRES_DB':connection.settings_dict['NAME']}
        started=time.monotonic();observation=CgroupObservation();failure=None;metrics_failures=0;peak={}
        stderr=directory/'child.stderr'
        try:
            initial=rpc.call('metrics',e.candidate.pk,e.pk,e.token,timeout=METRIC_TIMEOUT,attempts=1)
            with transaction.atomic():
                lock_control();latest,candidate=locked_execution(e.pk)
                if not current(latest,e.token):raise ValidationError('Initial cluster observation lost its lease.')
                operation=DDLOperation.objects.select_for_update().get(candidate=candidate,operation='create')
                expected=operation.intended.get('cluster')
                if expected and expected!=initial['cluster']:raise ValidationError('Recorded cluster changed; target will not be recreated.')
                operation.intended={**operation.intended,'cluster':initial['cluster']};operation.save(update_fields=['intended'])
                latest.progress={**latest.progress,'wal_start_lsn':initial['lsn']};latest.save(update_fields=['progress'])
        except ValidationError as error:return self.finish_failure(e.pk,e.token,diagnostic_text(error))
        with stderr.open('ab',buffering=0) as errors:
            child=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=errors,start_new_session=True,bufsize=0)
            selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ);pending=bytearray();last=0
            try:
                while child.poll() is None:
                    now=time.monotonic()
                    if now-started>self.wall_seconds:raise ValidationError('Fixture builder wall-time stop threshold reached.')
                    if now-last>=2:
                        if not self.renew(e.pk,e.token,{'elapsed_seconds':round(now-started,3)}):raise ValidationError('Builder lease, cancellation or generation fence changed.')
                        observation.sample()
                        if observation.failure():raise ValidationError(observation.failure())
                        try:
                            metrics=rpc.call('metrics',e.candidate.pk,e.pk,e.token,timeout=METRIC_TIMEOUT,attempts=1);metrics_failures=0
                            client=allocated_bytes([directory]);logs=stderr.stat().st_size
                            if metrics['filesystem']!=str(self.root.stat().st_dev):raise ValidationError('Candidate and build filesystem accounting differs.')
                            metrics={**metrics,'root_used':metrics['root_used']+allocated_bytes([self.root]),'client_bytes':client,'bundle_logs':logs+allocated_bytes([directory/'bundle']),
                                     'wal_generated':lsn_bytes(metrics['lsn'])-lsn_bytes(initial['lsn'])}
                            growth_check(self.root,metrics)
                            for key in ['heap_toast','indexes','wal','temp','root_used','client_bytes','bundle_logs','database_bytes','wal_generated']:peak[key]=max(peak.get(key,0),metrics[key])
                            BuildReservation.objects.filter(execution=e).update(allocated_bytes=min(RESERVATION,max(0,metrics['root_used']-e.progress['capacity']['used'])))
                            self.renew(e.pk,e.token,{'metrics':metrics,'sampled_peaks':peak})
                        except ValidationError as error:
                            if str(error).find('transport')<0:raise
                            metrics_failures+=1
                            if metrics_failures>=3:raise
                        last=now
                    for key,_ in selector.select(timeout=0.1):
                        data=os.read(key.fileobj.fileno(),4096)
                        if not data:selector.unregister(key.fileobj);continue
                        pending.extend(data)
                        while b'\n' in pending:
                            line,_,rest=pending.partition(b'\n');pending=bytearray(rest)
                            if len(line)>8192:raise ValidationError('Builder child progress line exceeds its cap.')
                            progress=json.loads(line)
                            if not isinstance(progress,dict) or not self.renew(e.pk,e.token,progress):raise ValidationError('Invalid or stale builder child progress.')
                        if len(pending)>8192:raise ValidationError('Builder child progress exceeds its cap.')
                    if stderr.stat().st_size>64*1024**2:raise ValidationError('Builder log resource limit reached.')
                if child.returncode:raise ValidationError(f'Builder child exited with status {child.returncode}.')
            except (OSError,ValueError,ValidationError) as error:failure=diagnostic_text(error)
            finally:
                selector.close()
                if child.poll() is None:
                    os.killpg(child.pid,signal.SIGTERM)
                    try:child.wait(timeout=2)
                    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=2)
                child.stdout.close()
        cgroup=observation.finish()
        self.renew(e.pk,e.token,{'cgroup':cgroup,'supervised_wall_seconds':time.monotonic()-started})
        if failure:
            c=Candidate.objects.get(execution=e);return self.finish_failure(e.pk,e.token,failure,paused=bool(c.bundle))
        try:
            with safe_open(self.root,work_relative(e)+'/result-'+str(e.token)+'.json') as stream:encoded=stream.read(4*1024**2+1)
            if len(encoded)>4*1024**2:raise ValidationError('Builder result exceeds its bound.')
            report=json.loads(encoded)
            if report.get('outcome')=='FAILED':return self.finish_failure(e.pk,e.token,report['error'])
            if report.get('outcome')=='PUBLICATION_PAUSED':return self.finish_failure(e.pk,e.token,report['error'],paused=True)
            return self.complete(e.pk,e.token,report)
        except (OSError,ValueError,ValidationError) as error:
            c=Candidate.objects.get(execution=e);return self.finish_failure(e.pk,e.token,diagnostic_text(error),paused=bool(c.bundle))

    def process_revalidation(self):
        row=None
        for execution in BuildExecution.objects.filter(status='ready').select_related('candidate').order_by('started_at')[:1000]:
            if execution.progress.get('revalidate_requested'):
                row=execution;break
        if row is None:return False
        requested=row.progress['revalidate_requested'];started=time.monotonic();last=0
        def checkpoint():
            nonlocal last
            now=time.monotonic()
            if now-started>270:raise RevalidationUnavailable('Readiness revalidation reached its bounded wall time.')
            if now-last>=1:
                heartbeat()
                try:legacy_window()
                except ValidationError as error:raise RevalidationUnavailable('The pilot observation window is unavailable.') from error
                last=now
        try:
            proof=candidate_handoff(row.candidate.pk,checkpoint=checkpoint)
            outcome={'eligible':True,'logical_fingerprint':proof['logical_fingerprint']}
        except ValidationError as error:outcome={'eligible':False,'error':diagnostic_text(error)}
        with transaction.atomic():
            lock_control();e=BuildExecution.objects.select_for_update().get(pk=row.pk)
            if e.progress.get('revalidate_requested')==requested:e.progress.pop('revalidate_requested')
            e.progress['last_revalidation']={**outcome,'requested_at':requested,'completed_at':timezone.now().isoformat()}
            e.save(update_fields=['progress'])
            audit('build.revalidated','builder',candidate=str(row.candidate.pk),**outcome)
        heartbeat();return True

    def tick(self):
        heartbeat();self.recover()
        if self.process_revalidation():return True
        checkpoint=self.input_checkpoint();dispatch_receipts(checkpoint=checkpoint);e=self.claim(checkpoint=checkpoint)
        if not e:return False
        self.execute(e);heartbeat();return True


def candidate_handoff(candidate_id,*,checkpoint=lambda:None):
    """Internal fixture handoff; every call revalidates current bytes and reader."""
    from .bundle import check_bundle
    from .validate import reconcile
    import psycopg
    started=time.monotonic();callback=checkpoint
    def checkpoint():
        if time.monotonic()-started>270:raise RevalidationUnavailable('Readiness validation reached its bounded wall time.')
        callback()
    c=Candidate.objects.select_related('execution__intent__receipt','execution__intent__profile').get(pk=candidate_id)
    e=c.execution
    if c.status!='READY' or c.revoked_at:raise ValidationError('Candidate is not currently eligible READY evidence.')
    try:
        graph=validate_inputs(e.intent.receipt.verification_id,checkpoint);graph['spool']=e.report['graph']['spool']
        check_bundle(settings.ATLAS_BUILD_ROOT,c.bundle)
        rpc.call('inspect',c.pk,e.pk,e.token)
        reader=rpc.call('reader_access',c.pk,e.pk,e.token)
        result=reconcile(reader,graph,checkpoint,identity=c.identity)
        if result['logical_fingerprint']!=c.validation['logical_fingerprint']:raise ValidationError('Frozen candidate logical contents changed.')
    except (rpc.ProvisionerUnavailable,RevalidationUnavailable,psycopg.OperationalError) as error:
        raise ValidationError('Candidate revalidation is temporarily unavailable; no current handoff was issued.') from error
    except (ValidationError,OSError,ValueError,KeyError,psycopg.Error) as error:
        with transaction.atomic():
            lock_control();Candidate.objects.filter(pk=c.pk,revoked_at__isnull=True).update(revoked_at=timezone.now())
            audit('build.eligibility_revoked','builder',candidate=str(c.pk),reason=diagnostic_text(error))
        raise ValidationError('Candidate eligibility revalidation failed; original evidence is preserved.') from error
    return {'scope':'fixture','eligible':True,'candidate_id':str(c.pk),'identity':c.identity,
            'logical_fingerprint':result['logical_fingerprint'],'bundle_index_sha256':c.bundle['index_sha256']}
