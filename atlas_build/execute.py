"""Supervised child: stable spool -> COPY -> freeze -> validate -> bundle."""
import json,os,resource,sys,time,traceback
from pathlib import Path
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import close_old_connections,transaction
from django.utils import timezone
from atlas_intake.control import lock_control
from atlas_intake.storage import sync_directory
from atlas_verification.control import canonical
from atlas_verification.diagnostics import diagnostic_text
from atlas_verification.resources import cgroup_snapshot
from .models import BuildExecution,Candidate
from .control import VERSIONS,compare_baseline
from .inputs import spool_inputs,validate_inputs
from .importer import import_graph
from .validate import reconcile
from . import bundle,rpc
from .worker import phase,current,work_relative,locked_execution


def write_result(path,result):
    encoded=canonical(result)
    if len(encoded)>4*1024**2:raise ValidationError('Builder result exceeds its control-report limit.')
    with path.open('xb') as output:output.write(encoded);output.flush();os.fsync(output.fileno())
    sync_directory(path.parent)


def execute(execution_id,token):
    e=BuildExecution.objects.select_related('intent__profile','intent__receipt','candidate').get(pk=execution_id)
    root=Path(settings.ATLAS_BUILD_ROOT);work=root/work_relative(e);result_path=work/'result.json'
    # A publication resume has a fresh token and fresh result filename. Earlier
    # result/log bytes remain evidence rather than being overwritten.
    result_path=work/('result-'+str(token)+'.json')
    started=time.monotonic();last_check=0;last_progress=0
    def checkpoint(force=False,**progress):
        nonlocal last_check,last_progress
        now=time.monotonic()
        if now-started>270:raise ValidationError('Fixture child wall-time stop threshold reached.')
        if force or now-last_check>=0.25:
            close_old_connections()
            observed=BuildExecution.objects.select_related('intent__profile','intent__receipt').get(pk=e.pk)
            if not current(observed,token):raise ValidationError('Child execution lost its fenced lease.')
            last_check=now
        if progress or now-last_progress>=1:
            print(json.dumps(progress or {'child_elapsed':round(now-started,3)},separators=(',',':')),flush=True);last_progress=now
    c=e.candidate
    try:
        checkpoint(True,phase='spooling')
        if e.progress.get('resume'):
            graph=validate_inputs(e.intent.receipt.verification_id,checkpoint)
            stored=e.report['graph']
            if graph['registry']!=stored['registry'] or graph['handoff']!=stored['handoff']:
                raise ValidationError('Publication resume input graph changed.')
            graph['spool']=stored['spool'];imported=e.report['import']
        else:
            graph=spool_inputs(e.intent.receipt.verification_id,work/'spool',checkpoint)
            checkpoint(True,phase='provisioning')
            created=rpc.call('create',c.pk,e.pk,token)
            c=phase(e.pk,token,'LOADING',identity=created['identity'],observed_operation=('create',{'identity':created['identity']}))
            checkpoint(True,phase='loading')
            imported=import_graph(created['loader'],graph,checkpoint)
            phase(e.pk,token,'LOADING',operation='freeze')
            checkpoint(True,phase='freezing')
            frozen=rpc.call('freeze',c.pk,e.pk,token)
            c=phase(e.pk,token,'FROZEN',observed_operation=('freeze',frozen))
        checkpoint(True,phase='validating')
        c=phase(e.pk,token,'VALIDATING')
        inspection=rpc.call('inspect',c.pk,e.pk,token)
        reader=rpc.call('reader_access',c.pk,e.pk,token)
        checked=reconcile(reader,graph,checkpoint,identity=c.identity)
        if e.progress.get('resume') and checked['logical_fingerprint']!=c.validation.get('logical_fingerprint'):
            raise ValidationError('Publication resume frozen database differs from validated contents.')
        final_inputs=validate_inputs(e.intent.receipt.verification_id,checkpoint)
        if final_inputs['registry']!=graph['registry'] or final_inputs['handoff']!=graph['handoff']:
            raise ValidationError('Current source/output graph changed during import.')
        comparison=compare_baseline(e.intent.profile,e.intent.coverage,bootstrap=e.intent.receipt.bootstrap,approval_id=e.intent.admission.get('approval'))
        e.refresh_from_db()
        checked['coverage_comparison']=comparison
        checked['resources']={'supervisor':e.progress,'child_peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                              'cgroup_at_validation':cgroup_snapshot(),'child_wall_seconds':time.monotonic()-started}
        report={'graph':graph,'import':imported,'inspection':inspection,'validation':checked}
        if c.bundle:
            # Exact intent and immutable original validation evidence survive a
            # publication-only resume; no import or schema recreation occurs.
            intended=c.bundle
            if c.validation.get('logical_fingerprint')!=checked['logical_fingerprint']:
                raise ValidationError('Frozen publication fingerprint changed.')
            c=phase(e.pk,token,'BUNDLE_PREPARED',report={**e.report,'graph':graph,'resume_check':checked})
        else:
            metadata={'schema_version':1,'scope':'fixture','candidate_id':str(c.pk),'execution_id':str(e.pk),
              'generation':e.generation,'intent_id':str(e.intent_id),'request_order':e.intent.request_order,
              'requested_at_utc':e.intent.requested_at.isoformat(),'saved_zone':e.intent.zone,'bundle_date':str(e.intent.bundle_date),
              'retrieval_dates':{'local':graph['snapshot']['retrieval_local_date'],'utc':graph['snapshot'].get('created_at')},
              'coverage':e.intent.coverage,'coverage_digest':e.intent.coverage_digest,'admission':e.intent.admission,
              'final_coverage_comparison':comparison,'identity':c.identity,'native':inspection['native'],'versions':VERSIONS,
              'handoff':graph['handoff'],'source_inputs':graph['snapshot']['artifacts'],'registered_outputs':graph['registry'],
              'import':imported,'logical_fingerprint':checked['logical_fingerprint'],'resources':checked['resources']}
            target=f'database/{e.intent.bundle_date}/{c.pk}'
            intended=bundle.stage_bundle(root,work_relative(e)+'/bundle',target,metadata,{'schema_version':1,**checked})
            c=phase(e.pk,token,'BUNDLE_PREPARED',validation=checked,bundle=intended,report=report)
        checkpoint(True,phase='publishing')
        publication_error=None
        for attempt in range(3):
            try:bundle.publish_bundle(root,intended);publication_error=None;break
            except (OSError,ValidationError) as error:
                publication_error=error
                with transaction.atomic():
                    lock_control();latest,candidate=locked_execution(e.pk)
                    if not current(latest,token):raise ValidationError('Publication lost its generation fence.')
                    candidate.publication_failures+=1;candidate.save(update_fields=['publication_failures'])
                if isinstance(error,ValidationError):break
                if attempt<2:time.sleep(0.2*(2**attempt));checkpoint(True)
        if publication_error:raise publication_error
        checkpoint(True,phase='final_checks')
        final_inputs=validate_inputs(e.intent.receipt.verification_id,checkpoint)
        if final_inputs['registry']!=graph['registry'] or final_inputs['handoff']!=graph['handoff']:
            raise ValidationError('Source/output graph changed before READY.')
        repeated=reconcile(reader,graph,checkpoint,identity=c.identity)
        if repeated['logical_fingerprint']!=checked['logical_fingerprint']:raise ValidationError('Frozen contents changed after validation.')
        rpc.call('inspect',c.pk,e.pk,token)
        bundle.check_bundle(root,intended)
        final_comparison=compare_baseline(e.intent.profile,e.intent.coverage,bootstrap=e.intent.receipt.bootstrap,approval_id=e.intent.admission.get('approval'))
        if final_comparison!=comparison:raise ValidationError('Coverage baseline changed during bundle publication.')
        checkpoint(True)
        outcome={'outcome':'READY','scope':'fixture','candidate_id':str(c.pk),
          'logical_fingerprint':checked['logical_fingerprint'],'index_sha256':intended['index_sha256'],
          'coverage_comparison':final_comparison,'validated_at':timezone.now().isoformat()}
    except Exception as error:
        sys.stderr.write(diagnostic_text(traceback.format_exc())+'\n')
        c.refresh_from_db()
        outcome={'outcome':'PUBLICATION_PAUSED' if c.bundle else 'FAILED','error':diagnostic_text(error),'phase':c.status}
    write_result(result_path,outcome)
    return outcome
