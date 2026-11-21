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

    def test_partial_progress_line_cannot_block_the_child_deadline(self):
        import sys
        from time import monotonic
        request_verification(self.run.pk,"partial-progress","operator")
        self.worker.child_command=[
            sys.executable,"-c",
            "import sys,time; sys.stdout.write('{}'); sys.stdout.flush(); time.sleep(10)",
        ]
        self.worker.deadline=0.1
        attempt=self.worker.claim()
        started=monotonic()
        self.worker.execute(attempt)
        elapsed=monotonic()-started
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])
        self.assertLess(elapsed,5,"The child must be killed before its ten-second natural exit.")
        self.assertEqual(attempt.reserved_bytes,0)
        self.assertFalse(attempt.successful)

    def test_exit_between_polling_passes_still_enforces_the_storage_cap(self):
        import sys
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"verified",
                "build_eligible":True,"tools":{"test":"fixture"},"counts":{"nodes":123}}
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=64*1024):
            request_verification(self.run.pk,"late-disk-growth","operator")
            attempt=self.worker.claim()
            path=self.root/".work"/str(attempt.pk)/str(attempt.generation)
            self.worker.child_command=[
                sys.executable,"-c",
                "import time; from pathlib import Path; time.sleep(0.75); "
                f"root=Path({str(path)!r}); (root/'result').mkdir(); "
                "(root/'result'/'objects.bin').write_bytes(b'x'*131072); "
                f"(root/'report.json').write_text({json.dumps(report)!r})",
            ]
            self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertEqual(attempt.summary["counts"],{"nodes":123})
        self.assertIn("storage cap",attempt.error)
        self.assertFalse(attempt.intended)
        self.assertEqual(attempt.reserved_bytes,0)

    def test_completion_counts_retained_generations_before_preparing_output(self):
        request_verification(self.run.pk,"complete-disk-growth","operator")
        attempt=self.worker.claim()
        path=self.worker.generation_path(attempt)
        result=path/"result"
        result.mkdir()
        write_json(result/"sample.json",{"test":"fixture"})
        retained=path.parent/"retained-generation"
        retained.mkdir()
        (retained/"scratch.bin").write_bytes(b"x"*131072)
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"verified",
                "build_eligible":True,"tools":{"test":"fixture"},"counts":{"nodes":123}}
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=64*1024):
            self.assertFalse(self.worker.complete(attempt.pk,attempt.generation,report,path))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertEqual(attempt.summary["counts"],{"nodes":123})
        self.assertFalse(attempt.intended)
        self.assertEqual(attempt.reserved_bytes,0)

    def test_publication_cap_failure_retains_intent_for_a_fenced_retry(self):
        attempt=self.prepare("publish-disk-growth")
        retained=self.root/".work"/str(attempt.pk)/"retained-generation"
        retained.mkdir()
        scratch=retained/"scratch.bin"
        scratch.write_bytes(b"x"*131072)
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=64*1024):
            self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertFalse(attempt.successful)
        self.assertTrue(attempt.intended["files"])
        self.assertEqual(attempt.reserved_bytes,0)
        scratch.unlink()
        retry_verification(attempt.pk,"operator")
        attempt.refresh_from_db()
        self.assertTrue(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.generation,2)
        self.assertEqual(attempt.executions.get(generation=1).status,"operational_failed")
        self.assertTrue(attempt.successful)

    def test_publication_rechecks_root_cap_after_linking_outputs(self):
        attempt=self.prepare("root-disk-growth")
        original=self.worker.publish
        from atlas_intake.storage import sync_directory
        changed=False
        def concurrent_growth(directory):
            nonlocal changed
            sync_directory(directory)
            if not changed and any((self.root/item["path"]).exists() for item in attempt.intended["files"]):
                changed=True
                (self.root/"another-attempt.bin").write_bytes(b"x"*131072)
        with override_settings(ATLAS_VERIFICATION_ROOT_BYTES=64*1024), patch(
            "atlas_verification.worker.sync_directory",side_effect=concurrent_growth,
        ):
            self.assertFalse(original(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertFalse(attempt.successful)
        self.assertTrue(attempt.intended["files"])

    def test_publication_rechecks_the_filesystem_free_space_reserve(self):
        attempt=self.prepare("filesystem-free-reserve")
        from shutil import disk_usage
        observed=disk_usage(self.root)
        with patch("atlas_verification.worker.shutil.disk_usage",return_value=observed._replace(free=0)):
            self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("free-space reserve",attempt.error)
        self.assertTrue(attempt.intended["files"])

    def test_published_hard_links_do_not_double_charge_attempt_storage(self):
        attempt=self.prepare("hard-link-accounting")
        from atlas_intake.storage import inbox_usage
        allocated=inbox_usage(self.root/".work"/str(attempt.pk))
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=allocated+1):
            self.assertTrue(self.worker.publish(attempt.pk,attempt.generation))
        attempt.refresh_from_db()
        self.assertTrue(attempt.successful)

    def cleanup_deadline_child(self,child):
        import os
        import signal
        if child.poll() is None:
            try:
                os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait(timeout=5)
        child.stdout.close()

    def test_exit_between_polling_passes_still_enforces_the_deadline(self):
        import subprocess
        import sys
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"verified",
                "build_eligible":True,"tools":{"test":"fixture"},"counts":{"nodes":123}}
        request_verification(self.run.pk,"late-success","operator")
        attempt=self.worker.claim()
        path=self.root/".work"/str(attempt.pk)/str(attempt.generation)
        self.worker.child_command=[
            sys.executable,"-c",
            "from pathlib import Path; "
            f"root=Path({str(path)!r}); (root/'result').mkdir(); "
            f"(root/'report.json').write_text({json.dumps(report)!r})",
        ]
        real_popen=subprocess.Popen
        clock=[1000.0]
        def completed_child(*args,**kwargs):
            if args[0]!=self.worker.child_command:
                return real_popen(*args,**kwargs)
            child=real_popen(*args,**kwargs)
            self.addCleanup(self.cleanup_deadline_child,child)
            self.assertEqual(child.wait(timeout=5),0)
            # The report and successful exit precede the final deadline check.
            clock[0]+=self.worker.deadline+1
            return child
        with patch("atlas_verification.worker.subprocess.Popen",side_effect=completed_child), patch(
            "atlas_verification.worker.monotonic",side_effect=lambda:clock[0],
        ):
            self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])
        self.assertEqual(attempt.summary["counts"],{"nodes":123})
        self.assertFalse(attempt.intended)
        self.assertFalse(attempt.successful)
        self.assertFalse(attempt.build_eligible)
        self.assertFalse(attempt.manifest_path)
        self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        self.assertEqual(attempt.reserved_bytes,0)
        with self.assertRaises(ValidationError):
            get_handoff(attempt.pk)

    def test_ready_child_without_report_is_killed_at_the_deadline(self):
        import os
        import select
        import signal
        import subprocess
        import sys
        request_verification(self.run.pk,"blocked-deadline","operator")
        attempt=self.worker.claim()
        path=self.root/".work"/str(attempt.pk)/str(attempt.generation)
        self.worker.child_command=[
            sys.executable,"-c",
            # The alarm only bounds a broken worker's cleanup; readiness advances its clock.
            "import os,signal; signal.alarm(10); os.write(1,b'R'); signal.pause()",
        ]
        real_popen=subprocess.Popen
        clock=[1000.0]
        children=[]
        def ready_child(*args,**kwargs):
            if args[0]!=self.worker.child_command:
                return real_popen(*args,**kwargs)
            child=real_popen(*args,**kwargs)
            children.append(child)
            self.addCleanup(self.cleanup_deadline_child,child)
            ready,_,_=select.select([child.stdout],[],[],5)
            self.assertTrue(ready,"The real verifier child did not signal readiness.")
            self.assertEqual(os.read(child.stdout.fileno(),1),b"R")
            self.assertIsNone(child.poll())
            self.assertFalse((path/"report.json").exists())
            clock[0]+=self.worker.deadline+1
            return child
        with patch("atlas_verification.worker.subprocess.Popen",side_effect=ready_child), patch(
            "atlas_verification.worker.monotonic",side_effect=lambda:clock[0],
        ):
            self.worker.execute(attempt)
        self.assertEqual(children[0].returncode,-signal.SIGKILL)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])
        self.assertFalse(attempt.intended)
        self.assertFalse(attempt.successful)
        self.assertFalse(attempt.build_eligible)
        self.assertFalse(attempt.manifest_path)
        self.assertFalse(self.worker.publish(attempt.pk,attempt.generation))
        self.assertEqual(attempt.reserved_bytes,0)
        with self.assertRaises(ValidationError):
            get_handoff(attempt.pk)

    def test_completion_counts_the_new_manifest_before_preparing_output(self):
        from atlas_intake.storage import inbox_usage
        request_verification(self.run.pk,"manifest-disk-growth","operator")
        attempt=self.worker.claim()
        path=self.worker.generation_path(attempt)
        result=path/"result"
        result.mkdir()
        write_json(result/"sample.json",{"test":"fixture"})
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"verified",
                "build_eligible":True,"tools":{"test":"fixture"}}
        allocated=inbox_usage(path.parent)
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=allocated+1):
            self.assertFalse(self.worker.complete(attempt.pk,attempt.generation,report,path))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertFalse(attempt.intended)

    def test_failure_manifest_growth_is_an_operational_failure_with_final_usage(self):
        from atlas_intake.storage import inbox_usage
        request_verification(self.run.pk,"failure-manifest-disk-growth","operator")
        attempt=self.worker.claim()
        path=self.worker.generation_path(attempt)
        result=path/"result"
        result.mkdir()
        write_json(result/"sample.json",{"test":"fixture"})
        report={"schema_version":1,"policy_version":"atlas-input-v1","run_id":str(self.run.pk),
                "catalog_digest":self.run.catalog_id,"regions":[],"status":"input_invalid",
                "build_eligible":False,"tools":{"test":"fixture"},"counts":{"nodes":123}}
        cap=inbox_usage(path.parent)+1
        with override_settings(ATLAS_VERIFICATION_ATTEMPT_BYTES=cap):
            self.assertFalse(self.worker.complete(attempt.pk,attempt.generation,report,path))
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertEqual(attempt.summary["counts"],{"nodes":123})
        self.assertGreater(attempt.summary["resources"]["disk_high_water_bytes"],cap)
        self.assertTrue(attempt.summary["failure_manifest"]["sha256"])
        self.assertFalse(attempt.intended)
        self.assertEqual(attempt.reserved_bytes,0)

    def test_fragmented_progress_is_reassembled_while_the_deadline_remains_active(self):
        import sys
        request_verification(self.run.pk,"fragmented-progress","operator")
        self.worker.child_command=[
            sys.executable,"-c",
            "import sys,time; sys.stdout.write('{\"phase\":'); sys.stdout.flush(); "
            "time.sleep(0.02); sys.stdout.write('\"fragmented\"}\\n'); sys.stdout.flush(); time.sleep(10)",
        ]
        self.worker.deadline=0.1
        attempt=self.worker.claim()
        self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertEqual(attempt.progress["phase"],"fragmented")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])

    def test_oversized_unterminated_progress_is_bounded_and_stops_the_child(self):
        import sys
        from time import monotonic
        request_verification(self.run.pk,"oversized-progress","operator")
        self.worker.child_command=[
            sys.executable,"-c",
            "import sys,time; sys.stdout.write('x'*16384); sys.stdout.flush(); time.sleep(10)",
        ]
        attempt=self.worker.claim()
        started=monotonic()
        self.worker.execute(attempt)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("progress exceeded",attempt.summary["reasons"][0]["message"])
        self.assertLess(monotonic()-started,5)

    def test_closed_progress_pipe_does_not_spin_while_the_child_stalls(self):
        import sys
        from time import process_time
        request_verification(self.run.pk,"closed-progress","operator")
        self.worker.child_command=[sys.executable,"-c","import os,time; os.close(1); time.sleep(10)"]
        self.worker.deadline=0.1
        attempt=self.worker.claim()
        started=process_time()
        self.worker.execute(attempt)
        cpu_seconds=process_time()-started
        attempt.refresh_from_db()
        self.assertEqual(attempt.status,"operational_failed")
        self.assertIn("deadline",attempt.summary["reasons"][0]["message"])
        self.assertLess(cpu_seconds,0.5,"EOF must not keep the progress selector continuously readable.")

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
