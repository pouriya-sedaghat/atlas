from datetime import UTC, date, datetime, time, timedelta
from tempfile import TemporaryDirectory

from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from atlas_intake.control import dispatch_due
from atlas_intake.models import Artifact, CatalogRevision, Control, Run, Schedule
from atlas_intake.worker import Worker


class ScheduleMigrationTests(TransactionTestCase):
    baseline = [("atlas_intake", "0002_artifact_publication_failures_alter_artifact_status")]
    due = datetime(2030, 1, 2, 20, 20, tzinfo=UTC)

    def migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def setUp(self):
        latest = MigrationExecutor(connection).loader.graph.leaf_nodes()
        self.addCleanup(self.migrate, latest)
        old_apps = self.migrate(self.baseline)
        OldArtifact = old_apps.get_model("atlas_intake", "Artifact")
        OldCatalog = old_apps.get_model("atlas_intake", "CatalogRevision")
        OldControl = old_apps.get_model("atlas_intake", "Control")
        OldRun = old_apps.get_model("atlas_intake", "Run")
        OldSchedule = old_apps.get_model("atlas_intake", "Schedule")
        catalog = OldCatalog.objects.create(
            pk="a" * 64,
            regions=[{
                "id": "iran", "name": "Iran", "path": "asia/iran",
                "pbf_url": "https://download.geofabrik.de/asia/iran-latest.osm.pbf",
                "poly_url": "https://download.geofabrik.de/asia/iran.poly",
            }],
        )
        wall = {"wall_time": time(23, 50), "zone": "Asia/Tehran", "offset": "+03:30", "selection": ["iran"]}
        historical_due = self.due - timedelta(days=1)
        historical_schedule = OldSchedule.objects.create(
            wall_date=date(2030, 1, 1), due_at=historical_due, status="dispatched", **wall,
        )
        missed = OldSchedule.objects.create(
            wall_date=date(2029, 12, 31), due_at=self.due - timedelta(days=2), status="missed", **wall,
        )
        historical = OldRun.objects.create(
            request_key=f"schedule:{historical_schedule.pk}", origin="automatic", actor="scheduler",
            catalog=catalog, schedule=historical_schedule, selection=["iran"], zone="Asia/Tehran",
            created_at=historical_due + timedelta(minutes=15), local_date=date(2030, 1, 2),
            status="sealed", sealed_at=historical_due + timedelta(minutes=20),
        )
        historical_artifact = OldArtifact.objects.create(
            run=historical, region_id="iran", region_name="Iran", kind="pbf", status="complete",
            relative_path=f"asia/iran/2030-01-02/{historical.pk}/iran.osm.pbf", sha256="a" * 64,
        )
        queued = OldRun.objects.create(
            request_key="manual:existing", origin="manual", actor="operator",
            catalog=catalog, zone="Asia/Tehran", created_at=self.due - timedelta(minutes=5),
            local_date=date(2030, 1, 2), status="queued",
        )
        queued_artifact = OldArtifact.objects.create(
            run=queued, region_id="iran", region_name="Iran", kind="poly", status="pending",
            relative_path=f"asia/iran/2030-01-02/{queued.pk}/iran.poly",
        )
        pending = OldSchedule.objects.create(wall_date=date(2030, 1, 2), due_at=self.due, **wall)
        OldControl.objects.create(pk=1, mode="automatic", catalog=catalog, schedule=pending)

        self.history = historical
        self.historical_schedule = historical_schedule
        self.historical_artifact = historical_artifact
        self.missed_id = missed.pk
        self.queued = queued
        self.queued_artifact = queued_artifact
        self.pending = pending
        self.catalog_id = catalog.pk
        self.migrate(latest)

    def test_upgrade_preserves_history_and_queued_work(self):
        historical = Run.objects.get(pk=self.history.pk)
        self.assertEqual(historical.scheduled_for, self.historical_schedule.due_at)
        self.assertEqual(historical.schedule_id, self.historical_schedule.pk)
        self.assertEqual(historical.catalog_id, self.catalog_id)
        self.assertEqual(historical.status, self.history.status)
        self.assertEqual(historical.request_key, self.history.request_key)
        self.assertEqual(historical.created_at, self.history.created_at)
        self.assertEqual(historical.local_date, self.history.local_date)
        self.assertEqual(historical.sealed_at, self.history.sealed_at)
        self.assertEqual(historical.schedule.kind, Schedule.Kind.LEGACY)
        self.assertEqual(historical.schedule.status, self.historical_schedule.status)
        self.assertEqual(historical.schedule.last_resolved, 1)
        missed = Schedule.objects.get(pk=self.missed_id)
        self.assertEqual(missed.status, Schedule.Status.MISSED)
        self.assertEqual(missed.last_resolved, 1)

        artifact = Artifact.objects.get(pk=self.historical_artifact.pk)
        self.assertEqual(artifact.run_id, self.history.pk)
        self.assertEqual(artifact.relative_path, self.historical_artifact.relative_path)
        self.assertEqual(artifact.status, self.historical_artifact.status)
        self.assertEqual(artifact.sha256, self.historical_artifact.sha256)

        queued = Run.objects.get(pk=self.queued.pk)
        self.assertEqual(queued.request_key, self.queued.request_key)
        self.assertEqual(queued.catalog_id, self.catalog_id)
        self.assertEqual(queued.status, Run.Status.QUEUED)
        self.assertIsNone(queued.schedule_id)
        self.assertIsNone(queued.scheduled_for)
        queued_artifact = queued.artifacts.get(pk=self.queued_artifact.pk)
        self.assertEqual(queued_artifact.relative_path, self.queued_artifact.relative_path)
        self.assertEqual(queued_artifact.status, Artifact.Status.PENDING)

        control = Control.objects.get(pk=1)
        pending = control.schedule
        self.assertEqual(control.mode, Control.Mode.AUTOMATIC)
        self.assertEqual(control.catalog_id, self.catalog_id)
        self.assertEqual(pending.pk, self.pending.pk)
        self.assertEqual(pending.kind, Schedule.Kind.LEGACY)
        self.assertEqual(pending.status, Schedule.Status.PENDING)
        self.assertEqual(pending.last_resolved, 0)
        self.assertEqual(pending.due_at, self.due)
        self.assertEqual(pending.wall_date, self.pending.wall_date)
        self.assertEqual(pending.wall_time, self.pending.wall_time)
        self.assertEqual(pending.zone, self.pending.zone)
        self.assertEqual(pending.offset, self.pending.offset)
        self.assertEqual(pending.selection, self.pending.selection)

    def test_migrated_one_off_waits_for_queue_then_admits_once(self):
        self.assertIsNone(dispatch_due(now=self.due))
        self.assertEqual(Schedule.objects.get(pk=self.pending.pk).status, Schedule.Status.PENDING)

        with TemporaryDirectory() as inbox:
            worker = Worker(root=inbox)
            queued = worker.active_run()
            self.assertEqual(queued.pk, self.queued.pk)
            self.assertIsNone(dispatch_due(now=self.due))
            Artifact.objects.filter(pk=self.queued_artifact.pk).update(status=Artifact.Status.COMPLETE)
            worker.settle(queued)

        now = self.due + timedelta(minutes=15)
        run = dispatch_due(now=now)
        self.assertIsNotNone(run)
        self.assertEqual(run.status, Run.Status.RUNNING)
        self.assertEqual(run.schedule_id, self.pending.pk)
        self.assertEqual(run.scheduled_for, self.due)
        self.assertEqual(run.created_at, now)
        self.assertEqual(run.local_date, date(2030, 1, 3))
        self.assertEqual(run.selection, ["iran"])
        self.assertEqual(run.catalog_id, self.catalog_id)
        self.assertEqual(run.artifacts.count(), 2)
        self.assertEqual(Schedule.objects.get(pk=self.pending.pk).status, Schedule.Status.DISPATCHED)
        self.assertIsNone(dispatch_due(now=now + timedelta(minutes=1)))
        self.assertEqual(Run.objects.filter(schedule_id=self.pending.pk).count(), 1)

    def test_migrated_one_off_excludes_exact_window_end(self):
        end = self.due + timedelta(hours=24)
        self.assertIsNone(dispatch_due(now=end - timedelta(microseconds=1)))
        self.assertEqual(Schedule.objects.get(pk=self.pending.pk).status, Schedule.Status.PENDING)
        self.assertIsNone(dispatch_due(now=end))
        self.assertEqual(Schedule.objects.get(pk=self.pending.pk).status, Schedule.Status.MISSED)
        self.assertFalse(Run.objects.filter(schedule_id=self.pending.pk).exists())
        self.assertEqual(Run.objects.get(pk=self.queued.pk).status, Run.Status.QUEUED)

    def test_only_the_same_schedule_and_planned_instant_are_unique(self):
        activation = self.due - timedelta(hours=24)
        schedule = Schedule.objects.create(
            kind=Schedule.Kind.RECURRING,
            wall_date=activation.date(), wall_time=activation.time(), zone="UTC",
            expiry_date=date(2030, 1, 5), expiry_time=time(20, 20),
            activation_at=activation, due_at=self.due, expires_at=self.due + timedelta(days=3),
            interval_minutes=1440,
        )
        fields = {
            "catalog": CatalogRevision.objects.get(pk=self.catalog_id),
            "schedule": schedule, "origin": Control.Mode.AUTOMATIC, "actor": "scheduler",
            "zone": "UTC", "created_at": self.due, "local_date": self.due.date(),
        }
        first = Run.objects.create(request_key="first", scheduled_for=self.due, **fields)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Run.objects.create(request_key="duplicate", scheduled_for=self.due, **fields)
        second = Run.objects.create(request_key="second", scheduled_for=self.due + timedelta(days=1), **fields)
        self.assertCountEqual(schedule.runs.values_list("pk", flat=True), [first.pk, second.pk])
