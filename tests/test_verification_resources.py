import copy
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

from django.test import override_settings

from atlas_verification.resources import CgroupObservation, cgroup_snapshot
from atlas_verification.worker import VerificationWorker


def snapshot(*, current=100, peak=200, oom=5, killed=2, group_killed=0, swap=7):
    return {
        "observed_at": "2026-11-19T18:00:00+00:00", "cgroup_directory_inode": 123,
        "memory_current_bytes": current, "memory_peak_bytes": peak,
        "memory_max_bytes": 2147483648, "memory_max_raw": "2147483648",
        "memory_swap_current_bytes": swap, "memory_swap_peak_bytes": swap+2,
        "memory_swap_max_bytes": 2147483648, "memory_swap_max_raw": "2147483648",
        "cpu_max": "100000 100000", "cpu_quota_usec": 100000, "cpu_period_usec": 100000,
        "memory_stat_bytes": {"anon": current//2, "file": current//3},
        "memory_events": {"oom": oom, "oom_kill": killed, "oom_group_kill": group_killed, "max": 99},
        "unavailable": [],
    }


class CgroupObservationTests(TestCase):
    def test_records_effective_limits_cache_swap_and_counter_values(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            for name,value in {
                "memory.max":"2147483648\n", "memory.current":"4096\n", "memory.peak":"8192\n",
                "memory.swap.max":"max\n", "memory.swap.current":"1024\n", "memory.swap.peak":"2048\n",
                "cpu.max":"100000 100000\n", "memory.stat":"anon 1234\nfile 2345\nkernel 345\n",
                "memory.events":"low 0\nmax 42\noom 5\noom_kill 2\noom_group_kill 0\n",
            }.items():
                (root/name).write_text(value)
            observed=cgroup_snapshot(root)
        self.assertEqual(observed["memory_max_bytes"],2147483648)
        self.assertEqual(observed["cpu_max"],"100000 100000")
        self.assertEqual((observed["cpu_quota_usec"],observed["cpu_period_usec"]),(100000,100000))
        self.assertEqual(observed["memory_stat_bytes"]["file"],2345)
        self.assertEqual(observed["memory_swap_current_bytes"],1024)
        self.assertEqual(observed["memory_swap_peak_bytes"],2048)
        self.assertIsNone(observed["memory_swap_max_bytes"])
        self.assertEqual(observed["memory_swap_max_raw"],"max")
        self.assertEqual(observed["memory_events"]["oom_kill"],2)
        self.assertFalse(observed["unavailable"])

    def test_missing_or_malformed_observations_are_explicit_not_zero(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/"memory.current").write_text("not-a-counter\n")
            observed=cgroup_snapshot(root)
        self.assertIsNone(observed["memory_current_bytes"])
        self.assertIsNone(observed["memory_events"])
        self.assertIn("memory.current",observed["unavailable"])
        self.assertIn("memory.events",observed["unavailable"])

    def test_historical_oom_and_transient_lifetime_peak_do_not_fail_an_attempt(self):
        before=snapshot(peak=2147483648+319488)
        after=snapshot(current=300,peak=2147483648+400000)
        recorder=CgroupObservation(capture=iter([before,after]).__next__)
        report=recorder.finish()
        self.assertIsNone(recorder.failure())
        self.assertEqual(report["oom_event_deltas"],{"oom":0,"oom_kill":0,"oom_group_kill":0})
        self.assertEqual(report["before"]["memory_peak_bytes"],before["memory_peak_bytes"])
        self.assertEqual(report["after"]["memory_peak_bytes"],after["memory_peak_bytes"])
        self.assertIn("cgroup lifetime",report["peak_time_scope"])

    def test_new_oom_and_kill_events_are_resource_failure(self):
        before=snapshot()
        after=snapshot(oom=6,killed=3,group_killed=1)
        recorder=CgroupObservation(capture=iter([before,after]).__next__)
        report=recorder.finish()
        self.assertEqual(report["oom_event_deltas"],{"oom":1,"oom_kill":1,"oom_group_kill":1})
        self.assertIn("OOM",recorder.failure())

    def test_unavailable_after_events_do_not_claim_a_zero_delta(self):
        before=snapshot()
        after=snapshot()
        after["memory_events"]=None
        recorder=CgroupObservation(capture=iter([before,after]).__next__)
        report=recorder.finish()
        self.assertEqual(report["oom_event_deltas"],{key:None for key in ["oom","oom_kill","oom_group_kill"]})

    def test_observed_oom_remains_a_failure_after_a_cgroup_scope_change(self):
        before=snapshot()
        during=snapshot(oom=6,killed=3)
        after=snapshot()
        after["cgroup_directory_inode"]=456
        recorder=CgroupObservation(capture=iter([before,during,after]).__next__)
        recorder.sample()
        report=recorder.finish()
        self.assertTrue(report["cgroup_scope_changed"])
        self.assertEqual(report["oom_event_deltas"],{key:None for key in ["oom","oom_kill","oom_group_kill"]})
        self.assertEqual(report["observed_oom_event_deltas"]["oom_kill"],1)
        self.assertIn("OOM",recorder.failure())

    def test_observed_oom_remains_a_failure_after_a_missing_counter_sample(self):
        before=snapshot()
        during=snapshot(oom=6,killed=3)
        after=snapshot()
        after["memory_events"]=None
        recorder=CgroupObservation(capture=iter([before,during,after]).__next__)
        recorder.sample()
        recorder.finish()
        self.assertIn("OOM",recorder.failure())

    def test_sampled_attempt_peaks_are_separate_from_historical_peak_and_rss(self):
        before=snapshot(current=100,peak=10000,swap=7)
        during=snapshot(current=500,peak=10000,swap=11)
        after=snapshot(current=200,peak=10000,swap=9)
        recorder=CgroupObservation(capture=iter([before,during,after]).__next__)
        recorder.sample()
        report=recorder.finish()
        self.assertEqual(report["sampled_peaks"]["memory_current_bytes"],500)
        self.assertEqual(report["sampled_peaks"]["memory_swap_current_bytes"],11)
        self.assertEqual(report["sampled_peaks"]["anon_bytes"],250)
        self.assertEqual(report["sampled_peaks"]["file_cache_bytes"],166)
        self.assertEqual(report["after"]["memory_peak_bytes"],10000)
        self.assertEqual(report["observations"],3)
        self.assertNotIn("rss",report["sampled_peaks"])


class WorkerCgroupTests(TestCase):
    def execute_fixture(self,before,after):
        with TemporaryDirectory() as directory, override_settings(ATLAS_VERIFICATION_ROOT=Path(directory)):
            root=Path(directory)
            attempt=SimpleNamespace(pk=uuid4(),run_id=uuid4(),generation=1,snapshot={"artifacts":[],"retrieval_local_date":"2026-11-19"},tools={"fixture":True},policy_version="atlas-input-v1")
            worker=VerificationWorker(root=root)
            path=root/".work"/str(attempt.pk)/"1"
            report={"status":"verified","build_eligible":True,"counts":{"nodes":123}}
            worker.child_command=[sys.executable,"-c",f"import time; from pathlib import Path; Path({str(path/'report.json')!r}).write_text({json.dumps(report)!r}); print('{{}}',flush=True); time.sleep(0.2)"]
            captures=[copy.deepcopy(before),copy.deepcopy(before)]+[copy.deepcopy(after)]*10
            with patch("atlas_verification.resources.cgroup_snapshot",side_effect=captures), patch(
                "atlas_verification.execute.tool_versions",return_value={"fixture":True}
            ), patch.object(worker,"storage_limit",return_value=(4096,None)), patch.object(
                worker,"renew",return_value=True
            ), patch("atlas_verification.worker.heartbeat"), patch.object(worker,"complete") as complete:
                result=worker.execute(attempt)
            self.assertTrue(complete.called)
            self.assertEqual(complete.call_args.args[2],result)
            self.assertTrue((path/"cgroup-before.json").is_file())
            self.assertTrue((path/"cgroup-after.json").is_file())
            return result

    def test_failure_checkpoint_retains_before_and_marks_a_recovered_cgroup_scope(self):
        with TemporaryDirectory() as directory:
            worker=VerificationWorker(root=Path(directory))
            attempt=SimpleNamespace(pk=uuid4(),generation=1,snapshot={"artifacts":[]},progress={"phase":"decode"})
            path=worker.generation_path(attempt)
            before=snapshot(peak=2147483648+319488)
            (path/"cgroup-before.json").write_text(json.dumps(before))
            after=snapshot()
            after["cgroup_directory_inode"]=456
            with patch("atlas_verification.resources.cgroup_snapshot",return_value=after):
                report=worker.failure_checkpoint(attempt,"worker restarted")
        self.assertEqual(report["status"],"operational_failed")
        self.assertEqual(report["resources"]["cgroup"]["before"],before)
        self.assertTrue(report["resources"]["cgroup"]["cgroup_scope_changed"])
        self.assertIsNone(report["resources"]["cgroup"]["oom_event_deltas"]["oom_kill"])
        self.assertIn("recovery",report["resources"]["cgroup"]["execution_stage"])

    def test_new_oom_blocks_a_child_report_that_would_otherwise_verify(self):
        result=self.execute_fixture(snapshot(),snapshot(oom=6,killed=3))
        self.assertEqual(result["status"],"operational_failed")
        self.assertFalse(result["build_eligible"])
        self.assertEqual(result["counts"],{"nodes":123})
        self.assertIn("OOM",result["resource_failure"])
        self.assertEqual(result["resources"]["cgroup"]["oom_event_deltas"]["oom_kill"],1)

    def test_transient_counter_excursion_without_new_oom_preserves_verified_result(self):
        result=self.execute_fixture(snapshot(peak=2147483648+319488),snapshot(peak=2147483648+400000))
        self.assertEqual(result["status"],"verified")
        self.assertTrue(result["build_eligible"])
        self.assertEqual(result["resources"]["aggregate_peak_memory_bytes"],2147483648+400000)
        self.assertEqual(result["resources"]["aggregate_peak_memory_scope"],"cgroup lifetime")
        self.assertEqual(result["resources"]["attempt_sampled_peak_memory_bytes"],100)
