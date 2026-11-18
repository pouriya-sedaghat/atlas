from datetime import UTC, date, datetime, time, timedelta

from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings

from atlas_intake.control import (
    dispatch_due, get_control, launch_manual, resolve_wall, save_schedule,
    set_manual, set_selection,
)
from atlas_intake.models import Artifact, Audit, CatalogRevision, Run, Schedule


def install_catalog():
    regions = [
        dict(id="asia", name="Asia", parent=None, path="asia",
             pbf_url="https://download.geofabrik.de/asia-latest.osm.pbf",
             poly_url="https://download.geofabrik.de/asia.poly"),
        dict(id="iran", name="Iran", parent="asia", path="asia/iran",
             pbf_url="https://download.geofabrik.de/asia/iran-latest.osm.pbf",
             poly_url="https://download.geofabrik.de/asia/iran.poly"),
        dict(id="monaco", name="Monaco", parent=None, path="monaco",
             pbf_url="https://download.geofabrik.de/europe/monaco-latest.osm.pbf",
             poly_url="https://download.geofabrik.de/europe/monaco.poly"),
    ]
    catalog = CatalogRevision.objects.create(pk="1" * 64, regions=regions)
    control = get_control()
    control.catalog = catalog
    control.save(update_fields=["catalog"])
    return catalog


class ControlTests(TestCase):
    def setUp(self):
        self.catalog = install_catalog()

    def test_manual_idempotency_and_explicit_pbf_selection(self):
        set_selection(["asia"], "operator")
        first = launch_manual("same-key", "operator")
        second = launch_manual("same-key", "operator")
        third = launch_manual("new-key", "operator")
        self.assertEqual(first.pk, second.pk)
        self.assertNotEqual(first.pk, third.pk)
        self.assertEqual(first.artifacts.filter(kind="poly").count(), 3)
        self.assertEqual(list(first.artifacts.filter(kind="pbf").values_list("region_id", flat=True)), ["asia"])
        self.assertEqual(first.catalog_id, self.catalog.pk)
        self.assertEqual(first.local_date, third.local_date)
        self.assertNotEqual(first.artifacts.get(kind="pbf").relative_path, third.artifacts.get(kind="pbf").relative_path)

    def test_disappeared_id_is_a_blocker(self):
        control = get_control()
        control.selection = ["gone"]
        control.save(update_fields=["selection"])
        run = launch_manual("missing", "operator")
        artifact = run.artifacts.get(kind="pbf")
        self.assertEqual(artifact.region_id, "gone")
        self.assertEqual(artifact.status, Artifact.Status.UNAVAILABLE)

    def test_replaced_and_manual_schedule_are_superseded(self):
        one = save_schedule(date(2030, 1, 1), time(4), "Asia/Tehran", "", "operator")
        two = save_schedule(date(2030, 1, 2), time(4), "Asia/Tehran", "", "operator")
        one.refresh_from_db()
        self.assertEqual(one.status, Schedule.Status.SUPERSEDED)
        set_manual("operator")
        two.refresh_from_db()
        self.assertEqual(two.status, Schedule.Status.SUPERSEDED)
        self.assertIsNone(dispatch_due(two.due_at))

    @override_settings(ATLAS_ZONE="Asia/Tehran")
    def test_dispatch_once_with_local_creation_date_and_frozen_selection(self):
        set_selection(["iran"], "operator")
        schedule = save_schedule(date(2030, 1, 1), time(23, 50), "Asia/Tehran", "", "operator")
        set_selection(["monaco"], "operator")
        now = schedule.due_at + timedelta(minutes=30)
        run = dispatch_due(now)
        self.assertEqual(run.local_date, date(2030, 1, 2))
        self.assertEqual(run.selection, ["iran"])
        self.assertEqual(run.schedule_id, schedule.pk)
        self.assertIsNone(dispatch_due(now))
        self.assertEqual(Run.objects.count(), 1)

    def test_grace_period_excludes_exactly_24_hours(self):
        schedule = save_schedule(date(2030, 1, 1), time(4), "Asia/Tehran", "", "operator")
        self.assertIsNone(dispatch_due(schedule.due_at + timedelta(hours=24)))
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, Schedule.Status.MISSED)
        self.assertTrue(Audit.objects.filter(action="schedule.missed").exists())

    def test_dst_gap_fold_and_explicit_offset(self):
        with self.assertRaises(ValidationError):
            resolve_wall(date(2026, 3, 8), time(2, 30), "America/New_York")
        with self.assertRaises(ValidationError):
            resolve_wall(date(2026, 11, 1), time(1, 30), "America/New_York")
        self.assertEqual(
            resolve_wall(date(2026, 11, 1), time(1, 30), "America/New_York", "-05:00"),
            datetime(2026, 11, 1, 6, 30, tzinfo=UTC),
        )
