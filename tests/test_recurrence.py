from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, time, timedelta
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.core.exceptions import ValidationError
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase

from atlas_intake.control import (
    dispatch_due, get_control, launch_manual, lock_control, save_schedule, set_manual, set_selection,
)
from atlas_intake.models import Artifact, Audit, CatalogRevision, Run, Schedule
from atlas_intake.worker import Worker
from tests.test_control import install_catalog


START = datetime(2030, 1, 1, tzinfo=UTC)


def recurring(**overrides):
    return save_schedule(**{
        "activation_date": date(2030, 1, 1), "activation_time": time(23, 50),
        "expiry_date": date(2030, 1, 5), "expiry_time": time(23, 50),
        "zone": "Asia/Tehran", "activation_offset": "", "expiry_offset": "",
        "interval_minutes": 1440, "actor": "operator", "now": START,
        **overrides,
    })


class RecurrenceTests(TestCase):
    def setUp(self):
        self.catalog = install_catalog()

    def test_first_two_elapsed_occurrences_store_planned_and_actual_times(self):
        set_selection(["iran"], "operator")
        schedule = recurring()
        first_due = schedule.activation_at + timedelta(hours=24)
        self.assertIsNone(dispatch_due(first_due - timedelta(microseconds=1)))
        actual = first_due + timedelta(minutes=30)
        first = dispatch_due(actual)
        self.assertEqual(first.status, Run.Status.RUNNING)
        self.assertEqual(first.scheduled_for, first_due)
        self.assertEqual(first.created_at, actual)
        self.assertEqual(first.local_date, date(2030, 1, 3))
        self.assertEqual(first.selection, ["iran"])
        self.assertEqual(first.catalog_id, self.catalog.pk)
        self.assertTrue(first.artifacts.filter(kind="poly", region_id="monaco").exists())
        self.assertIsNone(dispatch_due(actual))

        Run.objects.filter(pk=first.pk).update(status=Run.Status.SEALED)
        newer = CatalogRevision.objects.create(pk="c" * 64, regions=self.catalog.regions)
        control = get_control()
        control.catalog = newer
        control.save(update_fields=["catalog"])
        set_selection(["monaco"], "operator")
        second = dispatch_due(first_due + timedelta(hours=24))
        self.assertEqual(second.schedule_id, schedule.pk)
        self.assertEqual(second.scheduled_for - first.scheduled_for, timedelta(hours=24))
        self.assertEqual(second.selection, ["iran"])
        self.assertEqual(second.catalog_id, newer.pk)
        self.assertNotEqual(second.pk, first.pk)
        self.assertIsNone(dispatch_due(second.scheduled_for))
        schedule.refresh_from_db()
        self.assertEqual(schedule.last_resolved, 2)

    def test_queued_work_has_priority_and_exact_next_boundary_misses_old_occurrence(self):
        queued = launch_manual("existing-queue", "operator")
        schedule = recurring(interval_minutes=60)
        first = schedule.due_at
        self.assertIsNone(dispatch_due(first))
        schedule.refresh_from_db()
        self.assertEqual(schedule.last_resolved, 0)
        self.assertEqual(schedule.blocked_reason, "retrieval_slot_busy")
        self.assertFalse(Run.objects.filter(schedule=schedule).exists())
        Run.objects.filter(pk=queued.pk).update(status=Run.Status.SEALED)
        new = dispatch_due(first + timedelta(hours=1))
        missed = Audit.objects.get(action="schedule.missed")
        self.assertEqual(missed.detail["first_planned"], first.isoformat())
        self.assertEqual(missed.detail["count"], 1)
        self.assertEqual(missed.detail["reason"], "retrieval_slot_busy")
        self.assertEqual(new.scheduled_for, first + timedelta(hours=1))

    def test_busy_slot_can_free_within_window_and_paused_publication_does_not_hold_it(self):
        previous = launch_manual("old-run", "operator")
        Run.objects.filter(pk=previous.pk).update(status=Run.Status.RUNNING)
        schedule = recurring()
        self.assertIsNone(dispatch_due(schedule.due_at))
        previous.artifacts.update(status=Artifact.Status.PUBLICATION_PAUSED)
        with TemporaryDirectory() as inbox:
            Worker(root=inbox).settle(previous)
        actual = schedule.due_at + timedelta(minutes=10)
        self.assertEqual(dispatch_due(actual).created_at, actual)
        previous.refresh_from_db()
        self.assertEqual(previous.status, Run.Status.INCOMPLETE)
        self.assertFalse(Audit.objects.filter(action="schedule.missed").exists())

    def test_absent_catalog_is_an_observed_blocker_and_late_admission_keeps_cadence(self):
        schedule = recurring()
        control = get_control()
        control.catalog = None
        control.save(update_fields=["catalog"])
        self.assertIsNone(dispatch_due(schedule.due_at))
        schedule.refresh_from_db()
        self.assertEqual(schedule.blocked_reason, "catalog_unavailable")
        self.assertEqual(schedule.last_resolved, 0)
        control.catalog = self.catalog
        control.save(update_fields=["catalog"])
        new = dispatch_due(schedule.due_at + timedelta(minutes=10))
        self.assertEqual(new.scheduled_for, schedule.due_at)

    def test_24_hour_cutoff_and_exact_expiry_are_exclusive(self):
        schedule = recurring(
            interval_minutes=2880, expiry_date=date(2030, 1, 4), expiry_time=time(12),
        )
        self.assertIsNone(dispatch_due(schedule.expires_at))
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, Schedule.Status.EXPIRED)
        self.assertEqual(schedule.last_resolved, 1)
        self.assertEqual(Audit.objects.filter(action="schedule.expired").count(), 1)
        self.assertIsNone(dispatch_due(schedule.expires_at))
        self.assertEqual(Audit.objects.filter(action="schedule.expired").count(), 1)
        self.assertEqual(get_control().mode, "automatic")

        later = recurring(
            interval_minutes=2880, expiry_date=date(2030, 1, 6), expiry_time=time(12),
        )
        self.assertIsNone(dispatch_due(later.due_at + timedelta(hours=24)))
        later.refresh_from_db()
        self.assertEqual(later.last_resolved, 1)
        self.assertEqual(later.status, Schedule.Status.PENDING)
        self.assertFalse(Run.objects.filter(schedule=later).exists())

    def test_long_outage_writes_one_generic_range_and_at_most_one_run(self):
        schedule = recurring(interval_minutes=1, expiry_date=date(2031, 1, 1))
        latest = schedule.due_at + timedelta(minutes=100_000)
        run = dispatch_due(latest)
        self.assertEqual(run.scheduled_for, latest)
        self.assertEqual(Run.objects.filter(schedule=schedule).count(), 1)
        missed = Audit.objects.get(action="schedule.missed")
        self.assertEqual(missed.detail["count"], 100_000)
        self.assertEqual(missed.detail["first_index"], 1)
        self.assertEqual(missed.detail["last_index"], 100_000)
        self.assertEqual(missed.detail["last_planned"], (latest - timedelta(minutes=1)).isoformat())
        self.assertEqual(missed.detail["reason"], "admission_window_elapsed")
        self.assertIsNone(dispatch_due(latest))

    def test_manual_switch_accounts_for_closed_slots_and_supersedes_future_slots(self):
        schedule = recurring(interval_minutes=60)
        run = dispatch_due(schedule.due_at)
        cutoff = schedule.due_at + timedelta(hours=3, minutes=1)
        set_manual("operator", now=cutoff)
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, Schedule.Status.SUPERSEDED)
        self.assertEqual(schedule.last_resolved, 3)
        self.assertEqual(Audit.objects.get(action="schedule.missed").detail["count"], 2)
        self.assertTrue(Audit.objects.filter(action="schedule.superseded").exists())
        self.assertIsNone(dispatch_due(cutoff))
        run.refresh_from_db()
        self.assertEqual(run.status, Run.Status.RUNNING)

    def test_save_requires_future_first_due_and_valid_interval_and_expiry(self):
        with self.assertRaises(ValidationError):
            recurring(interval_minutes=0)
        with self.assertRaises(ValidationError):
            recurring(interval_minutes=12_000_000_000)
        with self.assertRaises(ValidationError):
            recurring(expiry_date=date(2030, 1, 2), expiry_time=time(23, 50))
        with self.assertRaises(ValidationError):
            recurring(now=datetime(2030, 1, 2, 20, 21, tzinfo=UTC))
        revision = recurring(now=datetime(2030, 1, 2, 20, 20, tzinfo=UTC))
        self.assertEqual(revision.due_at, datetime(2030, 1, 2, 20, 20, tzinfo=UTC))

    def test_each_dst_bound_is_validated_and_elapsed_due_shifts_local_hour(self):
        with self.assertRaises(ValidationError):
            recurring(activation_date=date(2030, 3, 10), activation_time=time(2, 30),
                      expiry_date=date(2030, 3, 14), zone="America/New_York")
        with self.assertRaises(ValidationError):
            recurring(activation_date=date(2030, 3, 7), expiry_date=date(2030, 3, 10),
                      expiry_time=time(2, 30), zone="America/New_York")
        with self.assertRaises(ValidationError):
            recurring(activation_date=date(2030, 11, 3), activation_time=time(1, 30),
                      expiry_date=date(2030, 11, 5), zone="America/New_York")
        with self.assertRaises(ValidationError):
            recurring(activation_date=date(2030, 11, 1), expiry_date=date(2030, 11, 3),
                      expiry_time=time(1, 30), zone="America/New_York")
        fold = recurring(activation_date=date(2030, 11, 1), expiry_date=date(2030, 11, 3),
                         expiry_time=time(1, 30), activation_time=time(0), expiry_offset="-05:00",
                         zone="America/New_York")
        self.assertEqual(fold.expires_at, datetime(2030, 11, 3, 6, 30, tzinfo=UTC))
        schedule = recurring(activation_date=date(2030, 3, 9), activation_time=time(8),
                             expiry_date=date(2030, 3, 12), zone="America/New_York")
        self.assertEqual(schedule.due_at - schedule.activation_at, timedelta(hours=24))
        self.assertEqual(schedule.due_at.astimezone(ZoneInfo(schedule.zone)).hour, 9)

    def test_expiry_that_overflows_utc_is_a_field_validation_error(self):
        with self.assertRaises(ValidationError) as caught:
            recurring(expiry_date=date.max, expiry_time=time(23, 59), zone="America/New_York")
        self.assertIn("expiry_time", caught.exception.message_dict)

    def test_failed_artifact_intent_write_rolls_back_admission_and_cursor(self):
        schedule = recurring()
        with patch.object(Artifact.objects, "bulk_create", side_effect=RuntimeError("fixture write failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture write failure"):
                dispatch_due(schedule.due_at)
        schedule.refresh_from_db()
        self.assertEqual(schedule.last_resolved, 0)
        self.assertFalse(Run.objects.exists())
        self.assertFalse(Audit.objects.filter(action="schedule.dispatched").exists())
        self.assertIsNotNone(dispatch_due(schedule.due_at))

    def test_database_rejects_another_run_for_same_occurrence_with_a_new_request_key(self):
        schedule = recurring()
        first = dispatch_due(schedule.due_at)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Run.objects.create(
                origin="automatic", request_key="duplicate-occurrence-different-request",
                schedule=schedule, scheduled_for=first.scheduled_for, catalog=self.catalog,
                zone="Asia/Tehran", created_at=first.created_at, local_date=first.local_date,
            )


class RecurrenceConcurrencyTests(TransactionTestCase):
    def setUp(self):
        install_catalog()

    @staticmethod
    def poll(now, barrier):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            run = dispatch_due(now)
            return run.pk if run else None
        finally:
            connection.close()

    def test_concurrent_postgresql_polls_admit_one_run(self):
        schedule = recurring()
        barrier = Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.poll, schedule.due_at, barrier) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(Run.objects.filter(schedule=schedule).count(), 1)
        self.assertEqual(Audit.objects.filter(action="schedule.dispatched").count(), 1)

    def test_manual_and_edit_are_serialized_against_a_concurrent_poll(self):
        for edit in (False, True):
            with self.subTest(edit=edit):
                first = recurring()
                barrier = Barrier(2)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    with transaction.atomic():
                        lock_control()
                        future = pool.submit(self.poll, first.due_at, barrier)
                        barrier.wait(timeout=10)
                        if edit:
                            recurring(activation_date=date(2030, 1, 3), now=first.due_at)
                        else:
                            set_manual("operator", now=first.due_at)
                    self.assertIsNone(future.result(timeout=15))
                self.assertFalse(Run.objects.filter(schedule=first).exists())
                first.refresh_from_db()
                self.assertEqual(first.status, Schedule.Status.SUPERSEDED)
