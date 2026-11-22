"""Normal 1B publication through the supervised real candidate lifecycle."""
import os,sys,threading
from datetime import timedelta
from pathlib import Path
from unittest import skipUnless
from unittest.mock import patch
from django.test import TransactionTestCase,override_settings
from django.utils import timezone
from django.core.exceptions import ValidationError
from tests import test_verification_handoff as handoff_tests
from atlas_build.models import BuildIntent,BuildExecution,Candidate,BuildHealth,BuildReservation

@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated PostGIS provisioner-owned process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildWorkerTests(TransactionTestCase):
    setUpFixture=handoff_tests.VerificationHandoffTests.setUp
    def setUp(self):
        from atlas_build.fixtures import register_fixture,COVERAGE
        from atlas_build.control import activate_fixture_profile,dispatch_receipts
        from atlas_verification.worker import VerificationWorker
        from atlas_build.provision import Provisioner
        from atlas_build.rpc import make_server
        self.setUpFixture()
        from tempfile import TemporaryDirectory
        temporary=TemporaryDirectory(prefix='build-supervision-',dir='/build-tests');self.addCleanup(temporary.cleanup)
        self.build=Path(temporary.name)
        config=override_settings(ATLAS_BUILD_ROOT=self.build);config.enable();self.addCleanup(config.disable)
        self.profile=activate_fixture_profile(COVERAGE,'fixture-operator',bootstrap=True)
        self.attempt=register_fixture('lossless','fixture-operator',profile_id=self.profile.pk)
        self.assertTrue(VerificationWorker().tick());self.attempt.refresh_from_db();self.assertTrue(self.attempt.successful)
        dispatch_receipts();self.intent=BuildIntent.objects.get()
        self.admin=Provisioner();self.admin.bootstrap()
        secret=Path(os.environ['ATLAS_PROVISIONER_SECRET_FILE']).read_bytes().strip()
        server=make_server(('127.0.0.1',0),secret,lambda:self.admin)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        env=patch.dict(os.environ,{'ATLAS_BUILD_ROOT':str(self.build),'ATLAS_BUILD_FIXTURE_MODE':'1',
              'ATLAS_PROVISIONER_URL':'http://127.0.0.1:'+str(server.server_port)})
        env.start();self.addCleanup(env.stop)
        # Test-only attestation; the exact VM pilot requires the external host
        # monitor and never uses this deterministic test observation.
        BuildHealth.objects.update_or_create(pk=1,defaults={'legacy':{'quiescent':True,'inventory_digest':'test-inventory',
             'headroom_bytes':33*1024**3,'candidate_bytes':0,'new_service_uncommitted':0},'legacy_until':timezone.now()+timedelta(minutes=5)})
        self.addCleanup(self.cleanup_owned)
    def cleanup_owned(self):
        from atlas_build.worker import cleanup_candidate
        for candidate in Candidate.objects.select_related('execution').all():
            if candidate.ready_at:continue
            try:cleanup_candidate(candidate.pk,'fixture-operator','owned disposable test cleanup',explicit=True)
            except ValidationError:pass # An ownership fault must remain quarantined, never force-dropped.
    def test_real_supervised_pipeline_reaches_one_ready_bundle_and_scope_baseline(self):
        from atlas_build.worker import BuildWorker,candidate_handoff
        from atlas_build.models import BuildScope
        worker=BuildWorker();self.assertTrue(worker.tick())
        candidate=Candidate.objects.get()
        details=candidate.execution.intent.error+' / '+(self.build/f'build-work/{self.intent.pk}/1/child.stderr').read_text()[-6000:]
        self.assertEqual(candidate.status,'READY',details)
        self.assertIsNotNone(candidate.ready_at);self.assertEqual(BuildScope.objects.get().last_ready_id,candidate.pk)
        self.assertEqual(candidate.validation['counts'],{'node':3,'way':1,'relation':1})
        handoff=candidate_handoff(candidate.pk)
        self.assertEqual(handoff['scope'],'fixture');self.assertTrue(handoff['eligible'])
        self.assertFalse(worker.tick());self.assertEqual(Candidate.objects.count(),1)
        self.assertEqual(BuildReservation.objects.get().reserved_bytes,0)
        from atlas_build.models import DDLOperation
        self.assertEqual(set(DDLOperation.objects.values_list('operation','status')),{('create','completed'),('freeze','completed')})
    def test_expired_claim_is_terminal_and_retry_uses_new_generation_database_and_credentials(self):
        from atlas_build.worker import BuildWorker,retry_build
        worker=BuildWorker();execution=worker.claim();old=execution.candidate.pk
        BuildExecution.objects.filter(pk=execution.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        worker.recover();execution.refresh_from_db();self.assertEqual(execution.status,'failed')
        self.assertIsNone(worker.claim())
        from atlas_build.worker import cleanup_candidate
        cleanup_candidate(old,'operator','test uncreated intent cleanup',explicit=True)
        retry_build(self.intent.pk,'operator','explicit retry after terminal import')
        fresh=worker.claim();self.assertEqual(fresh.generation,2);self.assertNotEqual(fresh.candidate.pk,old);self.assertNotEqual(fresh.token,execution.token)
        self.assertFalse(worker.renew(execution.pk,execution.token,{}))
    def test_supervisor_wall_limit_and_cancel_bound_a_blocked_child(self):
        from atlas_build.worker import BuildWorker
        worker=BuildWorker(child_command=[sys.executable,'-c','import time; time.sleep(30)'],wall_seconds=0.5)
        before=timezone.now();self.assertTrue(worker.tick())
        self.assertLess((timezone.now()-before).total_seconds(),10)
        candidate=Candidate.objects.get();self.assertEqual(candidate.status,'FAILED');self.assertIsNone(candidate.ready_at)
    def test_lease_and_source_invalidation_prevent_ready_registration(self):
        from atlas_build.worker import BuildWorker
        worker=BuildWorker();execution=worker.claim()
        BuildExecution.objects.filter(pk=execution.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        self.assertFalse(worker.complete(execution.pk,execution.token,{'outcome':'READY'}))
        self.assertFalse(Candidate.objects.filter(status='READY').exists())
    def test_database_constraint_reserves_one_slot_across_running_and_prepared(self):
        from django.db import transaction,IntegrityError
        now=timezone.now()
        BuildExecution.objects.create(intent=self.intent,generation=1,status='prepared',started_at=now,lease_until=now+timedelta(seconds=60))
        with self.assertRaises(IntegrityError),transaction.atomic():
            BuildExecution.objects.create(intent=self.intent,generation=2,status='running',started_at=now,lease_until=now+timedelta(seconds=60))
    def test_publication_faults_resume_same_frozen_database_and_unique_exact_intent(self):
        from atlas_build.worker import BuildWorker,resume_publication
        from atlas_build.control import request_rebuild,dispatch_receipts
        from atlas_intake.models import Audit
        faults=['publication','after_bundle_prepared','after_bundle_link','before_ready_result']
        for index,fault in enumerate(faults):
            with self.subTest(fault=fault):
                if index:
                    request_rebuild(self.intent.pk,'fault-'+fault,'fixture-operator');dispatch_receipts()
                worker=BuildWorker(child_command=[sys.executable,'tests/build_fault_child.py',fault]);self.assertTrue(worker.tick())
                e=BuildExecution.objects.order_by('-started_at').first();c=e.candidate
                self.assertEqual(c.status,'PUBLICATION_PAUSED',e.intent.error);self.assertTrue(c.bundle)
                identity=c.identity;intent=c.bundle;fingerprint=c.validation['logical_fingerprint']
                if fault=='publication':self.assertEqual(c.publication_failures,3)
                resume_publication(e.intent_id,'fixture-operator','resume exact owned fixture publication')
                self.assertTrue(BuildWorker().tick());c.refresh_from_db();e.refresh_from_db()
                self.assertEqual(c.status,'READY',e.intent.error);self.assertEqual(c.identity,identity);self.assertEqual(c.bundle,intent)
                self.assertEqual(c.validation['logical_fingerprint'],fingerprint)
                self.assertEqual(Audit.objects.filter(action='build.ready',detail__candidate=str(c.pk)).count(),1)
    def test_import_and_ddl_boundary_deaths_are_terminal_until_explicit_checked_cleanup(self):
        from atlas_build.worker import BuildWorker,cleanup_candidate,retry_build
        for fault in ['before_create','after_create','during_copy','after_freeze','after_validation']:
            with self.subTest(fault=fault):
                self.assertTrue(BuildWorker(child_command=[sys.executable,'tests/build_fault_child.py',fault]).tick())
                e=BuildExecution.objects.order_by('-generation').first();c=e.candidate
                self.assertEqual(c.status,'FAILED',e.intent.error);self.assertIsNone(c.ready_at)
                self.assertIsNone(BuildWorker().claim())
                cleanup_candidate(c.pk,'fixture-operator','owned disposable boundary fault cleanup',explicit=True)
                retry_build(e.intent_id,'fixture-operator','fresh generation after terminal fault')
    def test_ready_revalidation_request_uses_worker_and_source_tampering_revokes_only_eligibility(self):
        from atlas_build.worker import BuildWorker,candidate_handoff
        from django.contrib.auth import get_user_model
        from django.contrib.auth.models import Permission
        from django.urls import reverse
        worker=BuildWorker();self.assertTrue(worker.tick());c=Candidate.objects.get();before=(c.ready_at,c.bundle,c.validation)
        user=get_user_model().objects.create_user('build-panel-operator');user.user_permissions.add(Permission.objects.get(codename='operate'))
        self.client.force_login(user)
        response=self.client.get(reverse('build:detail',args=[self.intent.pk]));self.assertEqual(response.status_code,200);self.assertNotIn(b'\0',response.content)
        response=self.client.post(reverse('build:action',args=[self.intent.pk,'revalidate']),{'reason':'explicit integrity check'})
        self.assertEqual(response.status_code,302)
        self.assertTrue(worker.process_revalidation())
        artifact=self.attempt.run.artifacts.filter(kind='pbf').first();path=self.inbox/artifact.relative_path;path.write_bytes(path.read_bytes()+b'changed')
        with self.assertRaises(ValidationError):candidate_handoff(c.pk)
        c.refresh_from_db();self.assertIsNotNone(c.revoked_at);self.assertEqual((c.ready_at,c.bundle,c.validation),before)
    def test_transient_provisioner_outage_does_not_permanently_revoke_intact_ready_evidence(self):
        from atlas_build.worker import BuildWorker,candidate_handoff
        from atlas_build import rpc
        worker=BuildWorker();self.assertTrue(worker.tick());candidate=Candidate.objects.get()
        original=rpc.call
        def unavailable(operation,*args,**kwargs):
            if operation=='reader_access':raise rpc.ProvisionerUnavailable('temporary controlled transport outage')
            return original(operation,*args,**kwargs)
        with patch('atlas_build.rpc.call',side_effect=unavailable),self.assertRaises(ValidationError):candidate_handoff(candidate.pk)
        candidate.refresh_from_db();self.assertIsNone(candidate.revoked_at)
        self.assertTrue(candidate_handoff(candidate.pk)['eligible'])
    def test_cancel_paused_publication_revokes_roles_and_allows_checked_cleanup(self):
        from atlas_build.worker import BuildWorker,cancel_build,cleanup_candidate
        worker=BuildWorker(child_command=[sys.executable,'tests/build_fault_child.py','publication'])
        self.assertTrue(worker.tick());candidate=Candidate.objects.get()
        self.assertEqual(candidate.status,'PUBLICATION_PAUSED')
        cancel_build(self.intent.pk,'fixture-operator','cancel retained publication')
        worker.recover();candidate.refresh_from_db()
        self.assertEqual(candidate.status,'CANCELLED')
        cleanup_candidate(candidate.pk,'fixture-operator','dispose cancelled never-READY fixture',explicit=True)
        candidate.refresh_from_db();self.assertIsNotNone(candidate.cleanup_at)
    def test_missing_capacity_window_keeps_one_queued_intent_and_admits_when_restored(self):
        from atlas_build.worker import BuildWorker
        BuildHealth.objects.filter(pk=1).update(legacy_until=timezone.now()-timedelta(seconds=1))
        worker=BuildWorker();self.assertIsNone(worker.claim());self.intent.refresh_from_db()
        self.assertEqual(self.intent.status,'queued');self.assertEqual(BuildExecution.objects.count(),0)
        BuildHealth.objects.filter(pk=1).update(legacy_until=timezone.now()+timedelta(minutes=5))
        self.assertIsNotNone(worker.claim());self.assertEqual(BuildIntent.objects.count(),1)

    def test_revoked_reader_select_is_recorded_without_terminating_revalidation_worker(self):
        from atlas_build.worker import BuildWorker
        from psycopg import sql
        worker=BuildWorker();self.assertTrue(worker.tick());candidate=Candidate.objects.get()
        before=(candidate.ready_at,candidate.bundle,candidate.validation)
        with self.admin.connect(candidate.identity['database']) as conn:
            conn.execute(sql.SQL('REVOKE SELECT ON raw.source FROM {}').format(sql.Identifier(candidate.identity['names']['reader'])))
        execution=candidate.execution
        execution.progress={**execution.progress,'revalidate_requested':timezone.now().isoformat()};execution.save(update_fields=['progress'])
        self.assertTrue(worker.process_revalidation())
        execution.refresh_from_db();candidate.refresh_from_db()
        self.assertNotIn('revalidate_requested',execution.progress)
        self.assertFalse(execution.progress['last_revalidation']['eligible']);self.assertIsNotNone(candidate.revoked_at)
        self.assertEqual((candidate.ready_at,candidate.bundle,candidate.validation),before)
        self.assertFalse(worker.tick())
