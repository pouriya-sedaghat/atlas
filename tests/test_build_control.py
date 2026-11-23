"""Actual verifier publication/outbox and scoped build admission."""
from threading import Thread, Event
from unittest.mock import patch
from uuid import uuid4
from django.db import transaction, connections
from django.test import TransactionTestCase, override_settings
from django.core.exceptions import ValidationError
from atlas_intake.models import Artifact, Control
from atlas_verification.control import request_verification, get_handoff
from atlas_verification.worker import VerificationWorker
from tests.test_verification_decoder import block, pbf
from tests.test_verification_handoff import VerificationHandoffTests


@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildControlTests(TransactionTestCase):
    setUp = VerificationHandoffTests.setUp
    publish_fixture = VerificationHandoffTests.publish_fixture

    def prepare_profile(self, bootstrap=True):
        from atlas_build.control import activate_fixture_profile
        return activate_fixture_profile({'pbfs':['synthetic-selected'],
                'boundary_only':['synthetic-boundary'],'exceptions':[]},'fixture-operator',bootstrap=bootstrap)

    def seal_fixture(self,data):
        from atlas_build.control import bind_fixture_run
        if getattr(self,"unbound",False):
            return VerificationHandoffTests.seal_fixture(self,data)
        self.profile=self.prepare_profile()
        run=VerificationHandoffTests.seal_fixture(self,data)
        bind_fixture_run(run.pk,self.profile.pk,'fixture-operator')
        return run

    def source(self):
        b=block();b.primitivegroup.add().nodes.add(id=1,lat=0,lon=0)
        return pbf(b)

    def published(self):
        return self.publish_fixture(self.source(),{'nodes':1,'ways':0,'relations':0},build_eligible=True)[0]

    def test_real_publication_creates_one_durable_receipt_and_idempotent_intent(self):
        from atlas_build.models import BuildReceipt,BuildIntent
        from atlas_build.control import dispatch_receipts
        a=self.published()
        self.assertEqual(BuildReceipt.objects.count(),1)
        self.assertEqual(BuildIntent.objects.count(),0)
        receipt=BuildReceipt.objects.get()
        self.assertEqual(receipt.verification_id,a.pk)
        self.assertTrue(get_handoff(a.pk)['fixture'])
        self.assertEqual(len(dispatch_receipts()),1)
        intent=BuildIntent.objects.get()
        self.assertEqual(intent.request_order,receipt.pk)
        self.assertEqual(intent.coverage,self.profile.coverage)
        self.assertEqual(intent.status,'queued')
        self.assertEqual(intent.scope,'fixture')
        self.assertEqual(dispatch_receipts(),[])
        self.assertEqual(BuildIntent.objects.count(),1)

    def test_empty_success_and_unbound_history_never_auto_enqueue(self):
        from atlas_build.models import BuildReceipt
        self.publish_fixture(pbf(),{'nodes':0,'ways':0,'relations':0},build_eligible=False)
        self.assertFalse(BuildReceipt.objects.exists())

    def test_epoch_rotation_invalidates_old_opt_in(self):
        from atlas_build.models import BuildIntent,BuildProfile
        from atlas_build.control import dispatch_receipts
        self.published()
        BuildProfile.objects.filter(pk=self.profile.pk).update(epoch=uuid4())
        self.assertEqual(dispatch_receipts(),[])
        self.assertFalse(BuildIntent.objects.exists())

    def test_changed_input_or_output_blocks_admission(self):
        from atlas_build.models import BuildIntent
        from atlas_build.control import dispatch_receipts
        a=self.published();raw=self.objects.read_bytes();self.objects.write_bytes(raw+b'x')
        self.assertEqual(dispatch_receipts(),[])
        self.assertFalse(BuildIntent.objects.exists())

    def test_coverage_role_downgrade_and_missing_bootstrap_are_blocked(self):
        from atlas_build.models import BuildProfile,BuildIntent
        from atlas_build.control import dispatch_receipts
        self.published()
        BuildProfile.objects.filter(pk=self.profile.pk).update(coverage={'pbfs':[],
            'boundary_only':['synthetic-boundary','synthetic-selected'],'exceptions':[]})
        self.assertEqual(dispatch_receipts(),[])
        self.assertFalse(BuildIntent.objects.exists())

    def test_success_and_receipt_roll_back_together_and_retry_is_unique(self):
        from atlas_build.models import BuildReceipt
        run=self.seal_fixture(self.source());a=request_verification(run.pk,'rollback','operator')
        w=VerificationWorker();a=w.claim();w.execute(a)
        with patch('atlas_verification.worker.audit',side_effect=RuntimeError('after receipt')):
            with self.assertRaises(RuntimeError):w.publish(a.pk,a.generation)
        a.refresh_from_db();self.assertFalse(a.successful)
        self.assertEqual(a.status,'prepared');self.assertFalse(BuildReceipt.objects.exists())
        self.assertTrue(w.publish(a.pk,a.generation));self.assertEqual(BuildReceipt.objects.count(),1)

    def test_publisher_completes_while_another_connection_holds_control(self):
        from atlas_build.models import BuildReceipt
        run=self.seal_fixture(self.source());a=request_verification(run.pk,'lock-graph','operator')
        w=VerificationWorker();a=w.claim();w.execute(a)
        done=Event();errors=[]
        def publish():
            try:
                self.assertTrue(w.publish(a.pk,a.generation))
            except BaseException as e:errors.append(e)
            finally:connections.close_all();done.set()
        with transaction.atomic():
            Control.objects.select_for_update().get(pk=1)
            thread=Thread(target=publish);thread.start()
            finished=done.wait(5)
        thread.join(5)
        self.assertTrue(finished,'publisher acquired Control late while holding Run')
        self.assertFalse(errors,errors);self.assertEqual(BuildReceipt.objects.count(),1)

    def test_delayed_receipt_dispatch_preserves_original_request_order(self):
        from atlas_build.control import dispatch_receipts
        from atlas_build.models import BuildReceipt,BuildIntent
        a=self.published()
        second=request_verification(a.run_id,'second','operator');VerificationWorker().tick()
        ids=list(BuildReceipt.objects.order_by('pk').values_list('pk',flat=True));self.assertEqual(len(ids),2)
        dispatch_receipts(receipt_ids=[ids[1]])
        dispatch_receipts(receipt_ids=[ids[0]])
        self.assertEqual(list(BuildIntent.objects.order_by('request_order').values_list('request_order',flat=True)),ids)

    def test_profile_activation_is_rejected_outside_fixture_database(self):
        from atlas_build.control import activate_fixture_profile
        with override_settings(ATLAS_BUILD_FIXTURE_MODE=False):
            with self.assertRaises(ValidationError):activate_fixture_profile({'pbfs':[],'boundary_only':[],'exceptions':[]},'operator',bootstrap=True)

    def test_unbound_success_does_not_admit_history(self):
        from atlas_build.models import BuildReceipt
        self.unbound=True
        self.published()
        self.assertFalse(BuildReceipt.objects.exists())

    def test_disabling_build_pipeline_preserves_fixture_verification_and_binding(self):
        from atlas_build.models import BuildReceipt
        run=self.seal_fixture(self.source());a=request_verification(run.pk,'disabled','operator')
        with override_settings(ATLAS_BUILD_FIXTURE_MODE=False):VerificationWorker().tick()
        a.refresh_from_db();self.assertTrue(a.successful,a.error)
        self.assertTrue(get_handoff(a.pk)['fixture'])
        self.assertFalse(BuildReceipt.objects.exists())

    def test_batch_count_graph_inconsistency_is_rejected_before_copy(self):
        import hashlib
        from atlas_verification.control import canonical,read_manifest
        from atlas_build.inputs import validate_inputs
        a=self.published();batch=read_manifest(a);batch['counts']['nodes']+=1
        payload=canonical(batch);path=self.output/a.manifest_path;path.write_bytes(payload)
        a.manifest_sha256=hashlib.sha256(payload).hexdigest()
        intended=a.intended
        for entry in intended['files']:
            if entry['path']==a.manifest_path:entry.update(size=len(payload),sha256=a.manifest_sha256)
        intended['manifest_sha256']=a.manifest_sha256;a.intended=intended
        a.save(update_fields=['manifest_sha256','intended'])
        with self.assertRaises(ValidationError):validate_inputs(a.pk)

    def test_scope_baseline_cannot_be_bypassed_by_a_new_profile(self):
        from atlas_build.control import dispatch_receipts,compare_baseline,advance_baseline
        from atlas_build.models import BuildIntent,BuildExecution,Candidate
        from django.utils import timezone
        a=self.published();dispatch_receipts();intent=BuildIntent.objects.get()
        e=BuildExecution.objects.create(intent=intent,generation=1,status='complete',started_at=timezone.now())
        candidate=Candidate.objects.create(execution=e,status='READY',ready_at=timezone.now())
        BuildIntent.objects.filter(pk=intent.pk).update(generation=1)
        advance_baseline(candidate.pk)
        new=self.prepare_profile(bootstrap=True)
        with self.assertRaises(ValidationError):compare_baseline(new,{'pbfs':[],
                    'boundary_only':['synthetic-selected','synthetic-boundary'],'exceptions':[]},bootstrap=True)

    def unit_ready(self,intent):
        # Unit-only state for coverage/order rules, never VM acceptance evidence.
        from atlas_build.models import BuildExecution,Candidate,BuildIntent
        from django.utils import timezone
        BuildIntent.objects.filter(pk=intent.pk).update(generation=1)
        execution=BuildExecution.objects.create(intent=intent,generation=1,status='complete',started_at=timezone.now())
        return Candidate.objects.create(execution=execution,status='READY',ready_at=timezone.now())

    def test_late_lower_order_ready_does_not_move_scope_backward(self):
        from atlas_build.control import dispatch_receipts,advance_baseline
        from atlas_build.models import BuildIntent,BuildScope
        a=self.published()
        request_verification(a.run_id,'later-request','operator');VerificationWorker().tick();dispatch_receipts()
        intents=list(BuildIntent.objects.order_by('request_order'))
        first,second=[self.unit_ready(i) for i in intents]
        advance_baseline(second.pk);advance_baseline(first.pk)
        state=BuildScope.objects.get(pk='fixture')
        self.assertEqual(state.last_ready_id,second.pk)
        self.assertEqual(state.last_ready_order,intents[1].request_order)

    def test_shrink_approval_matches_actual_baseline_and_removed_roles(self):
        from atlas_build.control import dispatch_receipts,advance_baseline,compare_baseline,digest,coverage
        from atlas_build.models import BuildIntent,ShrinkApproval
        self.published();dispatch_receipts();intent=BuildIntent.objects.get();c=self.unit_ready(intent);advance_baseline(c.pk)
        proposed={'pbfs':['other'],'boundary_only':['synthetic-selected','synthetic-boundary'],'exceptions':[]}
        removed={'pbfs':['synthetic-selected'],'boundaries':[]}
        with self.assertRaises(ValidationError):compare_baseline(self.profile,proposed,bootstrap=False)
        approval=ShrinkApproval.objects.create(profile=self.profile,baseline=c,baseline_digest=digest(intent.coverage),
             proposed_digest=digest(coverage(proposed)),actor='operator',detail={'removed':removed,'reason':'explicit reviewed QA coverage'})
        evidence=compare_baseline(self.profile,proposed,bootstrap=False,approval_id=approval.pk)
        self.assertEqual(evidence['approval'],str(approval.pk))
        ShrinkApproval.objects.filter(pk=approval.pk).update(baseline_digest='0'*64)
        with self.assertRaises(ValidationError):compare_baseline(self.profile,proposed,bootstrap=False,approval_id=approval.pk)

    def test_real_out_of_order_publication_commits_keep_sequence_order(self):
        from atlas_intake.control import launch_manual as real_launch
        from atlas_intake.models import CatalogRevision
        from atlas_build.models import BuildReceipt,BuildIntent
        from atlas_build.control import dispatch_receipts
        from atlas_verification.worker import audit as real_audit
        run1=self.seal_fixture(self.source())
        catalog=run1.catalog
        with patch('tests.test_verification_handoff.CatalogRevision.objects.create',return_value=catalog), patch(
                'tests.test_verification_handoff.launch_manual',side_effect=lambda key,actor:real_launch(str(uuid4()),actor)):
            run2=self.seal_fixture(self.source())
        a1=request_verification(run1.pk,'commit-one','operator')
        a2=request_verification(run2.pk,'commit-two','operator')
        worker=VerificationWorker()
        for expected in [a1,a2]:
            claimed=worker.claim();self.assertEqual(claimed.pk,expected.pk);worker.execute(claimed)
            expected.refresh_from_db();self.assertEqual(expected.status,'prepared')
        inserted=Event();release=Event();finished=Event();errors=[]
        def audit(action,*args,**kwargs):
            if action=='verification.completed' and kwargs.get('verification')==str(a1.pk):
                inserted.set()
                if not release.wait(10):raise RuntimeError('bounded publication synchronization expired')
            return real_audit(action,*args,**kwargs)
        def first():
            try:worker.publish(a1.pk,a1.generation)
            except BaseException as e:errors.append(e)
            finally:connections.close_all();finished.set()
        with patch('atlas_verification.worker.audit',side_effect=audit):
            thread=Thread(target=first);thread.start()
            try:
                self.assertTrue(inserted.wait(5))
                self.assertTrue(worker.publish(a2.pk,a2.generation))
                visible=BuildReceipt.objects.get();self.assertEqual(visible.verification_id,a2.pk)
                self.assertEqual(len(dispatch_receipts()),1)
                high=BuildIntent.objects.get().request_order
            finally:release.set();thread.join(5)
        self.assertTrue(finished.is_set());self.assertFalse(errors,errors)
        self.assertEqual(len(dispatch_receipts()),1)
        orders=list(BuildIntent.objects.order_by('request_order').values_list('request_order',flat=True))
        self.assertLess(orders[0],high);self.assertEqual(orders[1],high)

    def test_operator_approval_is_bound_to_one_blocked_receipt_and_actual_baseline(self):
        from atlas_build.control import dispatch_receipts,advance_baseline,approve_receipt
        from atlas_build.models import BuildReceipt,BuildIntent
        a=self.published();dispatch_receipts();old=BuildIntent.objects.get()
        # Unit-only baseline coverage, not a VM acceptance READY claim.
        old.coverage={**old.coverage,'pbfs':[*old.coverage['pbfs'],'removed-pbf']};old.save(update_fields=['coverage'])
        baseline=self.unit_ready(old);advance_baseline(baseline.pk)
        request_verification(a.run_id,'approved-shrink','operator');self.assertTrue(VerificationWorker().tick())
        self.assertEqual(dispatch_receipts(),[])
        receipt=BuildReceipt.objects.exclude(pk=old.receipt_id).get();self.assertEqual(receipt.status,'blocked')
        with self.assertRaises(ValidationError):approve_receipt(receipt.pk,uuid4(),'operator','wrong baseline')
        approval=approve_receipt(receipt.pk,baseline.pk,'operator','explicit fixture coverage removal')
        self.assertEqual(len(dispatch_receipts()),1)
        intent=BuildIntent.objects.exclude(pk=old.pk).get()
        self.assertEqual(intent.admission['approval'],str(approval.pk))
        self.assertEqual(intent.admission['removed'],{'pbfs':['removed-pbf'],'boundaries':['removed-pbf']})
