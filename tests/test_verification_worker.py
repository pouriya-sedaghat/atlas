import json
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import connection, close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from atlas_intake.models import Run
from atlas_verification.control import get_handoff, request_verification, retry_verification
from atlas_verification.models import VerificationAttempt
from atlas_verification.storage import write_json
from atlas_verification.worker import VerificationWorker
from tests.test_control import install_catalog
from tests.test_verification_control import sealed_fixture


class VerificationRecoveryTests(TestCase):
    def setUp(self):
        install_catalog()
        self.run=sealed_fixture()
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.settings=override_settings(
            ATLAS_VERIFICATION_ROOT=self.root,ATLAS_VERIFICATION_ATTEMPT_BYTES=1024**2,
            ATLAS_VERIFICATION_ROOT_BYTES=10*1024**2,ATLAS_INBOX=self.root,
        )
        self.settings.enable()
        self.addCleanup(self.settings.disable)
        self.worker=VerificationWorker(root=self.root)

    def prepare(self,key="first"):
        attempt=request_verification(self.run.pk,key,"operator")
        claimed=self.worker.claim()
        self.assertEqual(claimed.pk,attempt.pk)
        directory=self.worker.generation_path(claimed)
        result=directory/"result"
        result.mkdir()
        write_json(result/"sample.json",{"test":"fixture"})
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"verified",
                "build_eligible":True,"tools":{"test":"fixture"}}
        self.assertTrue(self.worker.complete(claimed.pk,claimed.generation,report,directory))
        claimed.refresh_from_db()
        return claimed

    def test_interrupted_publication_recovers_existing_bytes_and_registers_once(self):
        attempt=self.prepare()
        original=self.worker.publish
        with patch("atlas_verification.worker.sync_directory",side_effect=OSError("fixture crash")):
            self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertFalse(attempt.successful)
        self.assertTrue(attempt.intended["files"])
        retry_verification(attempt.pk,"operator")
        attempt.refresh_from_db()
        self.assertFalse(original(attempt.pk,1))
        self.assertTrue(original(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.generation,2)
        self.assertEqual(attempt.executions.get(generation=1).status,"operational_failed")
        self.assertEqual(attempt.executions.get(generation=2).status,"verified")
        self.assertTrue(attempt.successful)
        self.assertFalse(original(attempt.pk,attempt.generation))
        handoff=get_handoff(attempt.pk)
        self.assertEqual(handoff["verification_id"],str(attempt.pk))
        self.assertTrue(handoff["build_eligible"])
        with self.assertRaises(ValidationError):
            Run.objects.filter(pk=self.run.pk).update(status="integrity_failed")
            get_handoff(attempt.pk)

    def test_invalidation_before_registration_blocks_a_handoff(self):
        attempt=self.prepare()
        Run.objects.filter(pk=self.run.pk).update(status="integrity_failed")
        self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertFalse(attempt.successful)
        with self.assertRaises(ValidationError):
            get_handoff(attempt.pk)

    def test_expired_claim_retries_same_snapshot_with_new_generation(self):
        attempt=request_verification(self.run.pk,"first","operator")
        claim=self.worker.claim()
        snapshot=claim.snapshot
        generation=self.worker.generation_path(claim)
        checkpoint={"status":"operational_failed","build_eligible":False,
                    "checks_completed":["first-artifact"],"checks_incomplete":["next-artifact"],
                    "counts":{"nodes":123},"regions":[],"tools":{}}
        (generation/"partial.json").write_text(json.dumps(checkpoint))
        VerificationAttempt.objects.filter(pk=claim.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        self.worker.recover()
        claim.refresh_from_db()
        self.assertEqual(claim.status,"operational_failed")
        self.assertEqual(claim.summary["checks_completed"],["first-artifact"])
        self.assertEqual(claim.summary["checks_incomplete"],["next-artifact"])
        self.assertEqual(claim.executions.get(generation=1).report["result"]["counts"],{"nodes":123})
        retry_verification(claim.pk,"operator")
        fresh=self.worker.claim()
        self.assertEqual(fresh.generation,2)
        self.assertEqual(fresh.snapshot,snapshot)
        self.assertFalse(self.worker.renew(claim.pk,1,{}))
        self.assertFalse(self.worker.complete(claim.pk,1,{"status":"verified"},self.root))

    def test_capacity_reservation_failure_releases_queue(self):
        with override_settings(ATLAS_VERIFICATION_ROOT_BYTES=100):
            attempt=request_verification(self.run.pk,"first","operator")
            self.assertIsNone(self.worker.claim())
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertEqual(attempt.reserved_bytes,0)
        second=request_verification(self.run.pk,"second","operator")
        self.assertEqual(self.worker.claim().pk,second.pk)

    def test_child_exit_is_an_operational_failure_and_can_release_the_slot(self):
        import sys
        request_verification(self.run.pk,"exit","operator")
        self.worker.child_command=[sys.executable,"-c","raise SystemExit(7)"]
        attempt=self.worker.claim()
        self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertFalse(attempt.successful)
        self.assertEqual(attempt.reserved_bytes,0)
        self.assertFalse(attempt.build_eligible)
        second=request_verification(self.run.pk,"next","operator")
        self.assertEqual(self.worker.claim().pk,second.pk)

    def test_child_timeout_is_killed_and_retains_the_original_snapshot(self):
        import sys
        request_verification(self.run.pk,"timeout","operator")
        self.worker.child_command=[sys.executable,"-c","import time; time.sleep(10)"]
        self.worker.deadline=0.1
        attempt=self.worker.claim()
        self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])
        self.assertEqual(attempt.reserved_bytes,0)
        self.assertEqual(attempt.snapshot["run_id"],str(self.run.pk))

    def test_invalidation_before_generation_completion_blocks_publication(self):
        attempt=request_verification(self.run.pk,"invalidated","operator")
        attempt=self.worker.claim()
        path=self.worker.generation_path(attempt)
        Run.objects.filter(pk=self.run.pk).update(status="integrity_failed")
        self.assertFalse(self.worker.complete(attempt.pk,attempt.generation,{"status":"verified"},path))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"input_invalid")
        self.assertFalse(attempt.successful)


class VerificationConcurrencyTests(TransactionTestCase):
    def test_concurrent_claims_process_one_attempt(self):
        install_catalog()
        run=sealed_fixture()
        request_verification(run.pk,"one","operator")
        request_verification(run.pk,"two","operator")
        barrier=Barrier(2)
        with TemporaryDirectory() as temporary:
            root=Path(temporary)
            # Construct directories serially. Each claim then uses a distinct PG connection.
            worker=VerificationWorker(root=root)
            def claim():
                close_old_connections()
                try:
                    barrier.wait(timeout=10)
                    result=worker.claim()
                    return str(result.pk) if result else None
                finally:
                    connection.close()
            with override_settings(ATLAS_INBOX=root), ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(claim) for _ in range(2)]
                results=[future.result(timeout=15) for future in futures]
        self.assertEqual(sum(value is not None for value in results),1)

    def test_concurrent_duplicate_requests_return_one_frozen_attempt(self):
        install_catalog()
        run=sealed_fixture()
        barrier=Barrier(2)
        def request():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return request_verification(run.pk,"same-request","operator").pk
            finally:
                connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(request) for _ in range(2)]
            results=[future.result(timeout=15) for future in futures]
        self.assertEqual(results[0],results[1])
        self.assertEqual(VerificationAttempt.objects.count(),1)
