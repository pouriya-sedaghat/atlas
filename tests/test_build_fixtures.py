"""New QA fixtures use real verification, never copied success or READY state."""
import os
from tempfile import TemporaryDirectory
from pathlib import Path
from django.test import TransactionTestCase,override_settings
from django.core.exceptions import ValidationError
from tests import test_verification_handoff as handoff_tests

@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildFixtureTests(TransactionTestCase):
    setUp=handoff_tests.VerificationHandoffTests.setUp
    def verify(self,kind):
        from atlas_build.fixtures import register_fixture,COVERAGE,expected_coverage
        from atlas_build.control import activate_fixture_profile,dispatch_receipts
        from atlas_verification.worker import VerificationWorker
        profile=activate_fixture_profile(expected_coverage(kind),'fixture-operator',bootstrap=True)
        attempt=register_fixture(kind,'fixture-operator',profile_id=profile.pk)
        self.assertEqual(attempt.status,'queued')
        worker=VerificationWorker();self.assertTrue(worker.tick());attempt.refresh_from_db()
        self.assertTrue(attempt.successful,(attempt.status,attempt.error,attempt.summary.get('blocking')))
        return attempt,dispatch_receipts()
    def test_lossless_multi_source_fixture_verifies_and_admits_once(self):
        attempt,intents=self.verify('lossless')
        self.assertTrue(attempt.build_eligible);self.assertEqual(len(intents),1)
        self.assertEqual(attempt.summary['counts'],{'nodes':6,'ways':2,'relations':2})
        from atlas_build.inputs import spool_inputs
        graph=spool_inputs(attempt.pk,self.output.parent/'fixture-spool')
        self.assertEqual(len(graph['regions']),3)
    def test_relation_only_fixture_is_eligible_and_empty_fixture_is_not(self):
        attempt,intents=self.verify('relation-only')
        self.assertTrue(attempt.build_eligible);self.assertEqual(attempt.summary['counts'],{'nodes':0,'ways':0,'relations':2});self.assertEqual(len(intents),1)
    def test_valid_empty_has_no_automatic_receipt(self):
        attempt,intents=self.verify('empty')
        self.assertFalse(attempt.build_eligible);self.assertEqual(intents,[])
    @override_settings(ATLAS_BUILD_FIXTURE_MODE=False)
    def test_helper_refuses_nonfixture_deployment(self):
        from atlas_build.fixtures import register_fixture
        from uuid import uuid4
        with self.assertRaises(ValidationError):register_fixture('lossless','operator',profile_id=uuid4())

    def test_boundary_only_success_never_auto_admits(self):
        attempt,intents=self.verify('boundary-only')
        self.assertFalse(attempt.build_eligible);self.assertEqual(intents,[])
        self.assertEqual(attempt.summary['counts'],{'nodes':0,'ways':0,'relations':0})
    def test_provider_plane_boundaries_pass_normal_verification_without_repair(self):
        attempt,intents=self.verify('boundary-policy')
        self.assertTrue(attempt.build_eligible);self.assertEqual(len(intents),1)
    def test_one_empty_selected_source_remains_ineligible_under_accepted_policy(self):
        attempt,intents=self.verify('mixed-empty')
        self.assertFalse(attempt.build_eligible);self.assertEqual(attempt.summary['counts'],{'nodes':3,'ways':1,'relations':1})
        self.assertEqual(intents,[])

    def test_registration_is_invisible_to_another_connection_until_inputs_are_sealed(self):
        import threading
        from unittest.mock import patch
        from django.db import connections
        from atlas_intake.models import Run,Artifact
        from atlas_intake.control import launch_manual
        from atlas_intake.worker import Worker
        from atlas_build.fixtures import register_fixture,COVERAGE
        from atlas_build.control import activate_fixture_profile
        profile=activate_fixture_profile(COVERAGE,'fixture-operator',bootstrap=True)
        created=threading.Event();release=threading.Event();errors=[];claimed=[]
        def paused(*args,**kwargs):
            run=launch_manual(*args,**kwargs);created.set()
            if not release.wait(10):raise RuntimeError('registration test barrier expired')
            return run
        def register():
            try:register_fixture('lossless','fixture-operator',profile_id=profile.pk)
            except BaseException as error:errors.append(error)
            finally:connections.close_all()
        def probe():
            try:claimed.append(Worker().active_run())
            except BaseException as error:errors.append(error)
            finally:connections.close_all()
        with patch('atlas_build.fixtures.launch_manual',side_effect=paused):
            thread=threading.Thread(target=register);thread.start()
            try:
                self.assertTrue(created.wait(10))
                self.assertEqual(Run.objects.filter(status__in=['queued','running']).count(),0)
                worker=threading.Thread(target=probe);worker.start()
            finally:release.set();thread.join(15)
        self.assertFalse(thread.is_alive());worker.join(10);self.assertFalse(worker.is_alive())
        self.assertEqual(errors,[]);self.assertEqual(claimed,[None])
        self.assertEqual(Run.objects.get().status,'sealed')
        self.assertEqual(Artifact.objects.exclude(status='complete').count(),0)
