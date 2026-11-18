import re
from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from atlas_intake.control import dispatch_due
from atlas_intake.models import Artifact, Audit, CatalogRevision, Control, Run, Schedule


def region(region_id, name, parent=None, pbf=True):
    return {
        "id": region_id,
        "name": name,
        "parent": parent,
        "path": region_id,
        "pbf_url": f"https://download.geofabrik.de/{region_id}-latest.osm.pbf" if pbf else "",
        "poly_url": f"https://download.geofabrik.de/{region_id}.poly",
        "poly_error": "",
        "exception": {},
    }


@override_settings(ATLAS_ZONE="Asia/Tehran")
class OperatorPanelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.operator = get_user_model().objects.create_user(username="operator")
        cls.operator.user_permissions.add(Permission.objects.get(codename="operate"))
        cls.staff = get_user_model().objects.create_user(username="staff", is_staff=True)
        cls.catalog = CatalogRevision.objects.create(
            pk="a" * 64,
            regions=[
                region("asia", "Asia"),
                region("asia/iran", "Iran", "asia"),
                region("monaco", "Monaco", pbf=False),
            ],
        )
        Control.objects.update_or_create(pk=1, defaults={"catalog": cls.catalog, "selection": []})

    def dashboard(self, *, at=None):
        url = reverse("atlas_intake:dashboard")
        if at is None:
            return self.client.get(url)
        with patch("atlas_intake.views.timezone") as clock:
            clock.now.return_value = at
            return self.client.get(url)

    def save_selection(self, selected=(), remove=()):
        snapshot = self.dashboard().context["selection_form"]["selection_token"].value()
        return self.client.post(
            reverse("atlas_intake:save_selection"),
            {"selection_token": snapshot, "pbf_ids": selected, "remove_unavailable": remove},
        )

    def launch_run(self):
        response = self.client.post(reverse("atlas_intake:launch"), {"request_key": uuid4()})
        self.assertEqual(response.status_code, 302)
        return Run.objects.get(pk=response["Location"].rstrip("/").rsplit("/", 1)[-1])

    def post_schedule(self, **values):
        form = {
            "activation_date": "2030-11-04",
            "activation_time": "02:30",
            "expiry_date": "2030-11-08",
            "expiry_time": "02:30",
            "zone": "Asia/Tehran",
            "interval_minutes": "1440",
        }
        with patch("atlas_intake.control.timezone") as clock:
            clock.now.return_value = datetime(2030, 1, 1, tzinfo=UTC)
            return self.client.post(reverse("atlas_intake:schedule"), {**form, **values})

    def test_panel_redirects_anonymous_visitors(self):
        self.assertRedirects(
            self.dashboard(),
            f"{reverse('atlas_intake:login')}?next={reverse('atlas_intake:dashboard')}",
        )

    def test_staff_without_operate_permission_cannot_read_or_launch(self):
        self.client.force_login(self.staff)
        self.assertEqual(self.dashboard().status_code, 403)
        self.assertEqual(self.client.post(reverse("atlas_intake:launch")).status_code, 403)
        self.assertFalse(Run.objects.exists())

    def test_mutations_require_post_and_csrf(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.operator)
        for name in ("save_selection", "schedule", "manual_mode", "launch", "refresh_catalog"):
            with self.subTest(name=name):
                url = reverse(f"atlas_intake:{name}")
                self.assertEqual(client.get(url).status_code, 405)
                self.assertEqual(client.post(url).status_code, 403)
        self.assertFalse(Run.objects.exists())

    def test_parent_selection_does_not_select_descendants(self):
        self.client.force_login(self.operator)
        self.assertRedirects(self.save_selection(["asia"]), reverse("atlas_intake:dashboard"))
        self.assertEqual(Control.objects.get(pk=1).selection, ["asia"])
        response = self.dashboard()
        self.assertContains(response, 'name="pbf_ids" value="asia/iran"')
        self.assertContains(response, "POLY only")

    def test_catalog_keeps_distinct_slash_ids_with_the_same_name(self):
        regions = [region("world", "World")]
        regions.extend(region(f"world/area-{index}", "Area", "world") for index in range(553))
        large = CatalogRevision.objects.create(pk="c" * 64, regions=regions)
        Control.objects.filter(pk=1).update(catalog=large)
        self.client.force_login(self.operator)
        response = self.dashboard()
        self.assertContains(response, 'name="pbf_ids"', count=554)
        self.assertContains(response, "World Area world/area-552")
        self.assertEqual(self.save_selection(["world/area-2", "world/area-552"]).status_code, 302)
        self.assertEqual(Control.objects.get(pk=1).selection, ["world/area-2", "world/area-552"])

    def test_unavailable_saved_region_requires_explicit_removal(self):
        Control.objects.filter(pk=1).update(selection=["removed/region"])
        self.client.force_login(self.operator)
        self.assertContains(self.dashboard(), "removed/region")
        self.assertEqual(self.save_selection(["asia/iran"]).status_code, 302)
        self.assertCountEqual(Control.objects.get(pk=1).selection, ["asia/iran", "removed/region"])
        self.assertEqual(self.save_selection(["asia/iran"], ["removed/region"]).status_code, 302)
        self.assertEqual(Control.objects.get(pk=1).selection, ["asia/iran"])

    def test_selection_rejects_poly_only_region(self):
        self.client.force_login(self.operator)
        self.assertEqual(self.save_selection(["monaco"]).status_code, 400)
        self.assertEqual(Control.objects.get(pk=1).selection, [])

    def test_catalog_changed_since_form_was_loaded_preserves_selection(self):
        Control.objects.filter(pk=1).update(selection=["asia/iran"])
        self.client.force_login(self.operator)
        snapshot = self.dashboard().context["selection_form"]["selection_token"].value()
        updated = CatalogRevision.objects.create(pk="b" * 64, regions=[region("monaco", "Monaco", pbf=False)])
        Control.objects.filter(pk=1).update(catalog=updated)
        response = self.client.post(reverse("atlas_intake:save_selection"), {"selection_token": snapshot})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Control.objects.get(pk=1).selection, ["asia/iran"])

    def test_duplicate_manual_form_submission_opens_same_run(self):
        self.client.force_login(self.operator)
        token = re.search(r'name="request_key" value="([a-f0-9-]+)"', self.dashboard().content.decode())[1]
        url = reverse("atlas_intake:launch")
        first = self.client.post(url, {"request_key": token})
        duplicate = self.client.post(url, {"request_key": token})
        self.assertEqual(Run.objects.count(), 1)
        run = Run.objects.get()
        self.assertRedirects(first, reverse("atlas_intake:run_detail", args=[run.pk]))
        self.assertEqual(first["Location"], duplicate["Location"])
        self.assertEqual(run.artifacts.filter(kind="pbf").count(), 0)
        self.assertEqual(run.artifacts.filter(kind="poly").count(), 3)
        intentional_second = self.launch_run()
        self.assertNotEqual(run.pk, intentional_second.pk)

    def test_schedule_form_uses_the_configured_zone_and_daily_interval(self):
        self.client.force_login(self.operator)
        form = self.dashboard().context["schedule_form"]
        self.assertEqual(form["zone"].value(), "Asia/Tehran")
        self.assertEqual(form["interval_minutes"].value(), 1440)

    def test_schedule_form_rejects_a_nonexistent_activation_or_expiry(self):
        self.client.force_login(self.operator)
        for bound, other in (("activation", "expiry"), ("expiry", "activation")):
            with self.subTest(bound=bound):
                response = self.post_schedule(
                    zone="America/New_York",
                    **{f"{bound}_date": "2030-03-10", f"{bound}_time": "02:30", f"{other}_date": "2030-03-09"},
                )
                self.assertContains(response, "does not exist", status_code=400)
        self.assertEqual(Control.objects.get(pk=1).mode, "manual")

    def test_schedule_requires_chosen_offset_for_each_ambiguous_bound(self):
        self.client.force_login(self.operator)
        form = {
            "activation_date": "2030-11-03",
            "activation_time": "01:30",
            "expiry_date": "2030-11-03",
            "expiry_time": "01:30",
            "zone": "America/New_York",
            "interval_minutes": "30",
        }
        self.assertContains(self.post_schedule(**form), "UTC offset", status_code=400)
        self.assertContains(self.post_schedule(**form, activation_offset="-04:00"), "UTC offset", status_code=400)
        self.assertRedirects(
            self.post_schedule(**form, activation_offset="-04:00", expiry_offset="-05:00"),
            reverse("atlas_intake:dashboard"),
        )
        schedule = Control.objects.select_related("schedule").get(pk=1).schedule
        self.assertEqual(schedule.activation_at.isoformat(), "2030-11-03T05:30:00+00:00")
        self.assertEqual(schedule.due_at.isoformat(), "2030-11-03T06:00:00+00:00")
        self.assertEqual(schedule.expires_at.isoformat(), "2030-11-03T06:30:00+00:00")
        response = self.dashboard(at=datetime(2030, 11, 3, 4, tzinfo=UTC))
        self.assertContains(response, "America/New_York")
        self.assertContains(response, "Next planned occurrence")

    def test_schedule_rejects_nonpositive_and_fractional_intervals(self):
        self.client.force_login(self.operator)
        for interval in ("0", "-1", "1.5"):
            with self.subTest(interval=interval):
                self.assertEqual(self.post_schedule(interval_minutes=interval).status_code, 400)
        self.assertFalse(Schedule.objects.exists())

    def test_dashboard_shows_expiry_at_the_exact_instant_without_worker_poll(self):
        self.client.force_login(self.operator)
        self.assertEqual(self.post_schedule(zone="UTC").status_code, 302)
        schedule = Control.objects.get(pk=1).schedule
        response = self.dashboard(at=datetime(2030, 11, 3, 2, 30, tzinfo=UTC))
        self.assertContains(response, "Waiting for activation")
        self.assertContains(response, "2030-11-05 02:30")
        self.assertEqual(response.context["schedule_preview"]["next_due_at"], schedule.due_at)
        response = self.dashboard(at=schedule.expires_at)
        self.assertContains(response, "Automatic mode")
        self.assertContains(response, "Expired")
        self.assertIsNone(response.context["schedule_preview"]["next_due_at"])
        schedule.refresh_from_db()
        self.assertEqual(schedule.status, Schedule.Status.PENDING)
        self.assertFalse(Audit.objects.filter(action="schedule.expired").exists())

    def test_dashboard_distinguishes_a_blocked_occurrence_from_the_next_planned_slot(self):
        self.client.force_login(self.operator)
        self.launch_run()  # Accepted manual work has priority over Automatic admission.
        self.assertEqual(self.post_schedule(zone="UTC").status_code, 302)
        schedule = Control.objects.get(pk=1).schedule
        self.assertIsNone(dispatch_due(now=schedule.due_at))
        response = self.dashboard(at=schedule.due_at)
        self.assertContains(response, "Waiting occurrence")
        self.assertContains(response, "The retrieval slot is busy.")
        self.assertEqual(response.context["schedule_preview"]["waiting_at"], schedule.due_at)
        self.assertEqual(response.context["schedule_preview"]["next_due_at"], schedule.due_at + timedelta(days=1))

    def test_current_revision_history_shows_outcomes_and_per_run_local_times(self):
        self.client.force_login(self.operator)
        self.assertEqual(self.post_schedule(activation_time="00:30", expiry_time="00:30").status_code, 302)
        revision = Control.objects.get(pk=1).schedule
        scheduled_for = datetime(2030, 11, 5, 21, tzinfo=UTC)
        admitted_at = datetime(2030, 11, 5, 21, 10, tzinfo=UTC)
        run = Run.objects.create(
            request_key="second-occurrence",
            origin=Control.Mode.AUTOMATIC,
            actor="scheduler",
            catalog=self.catalog,
            schedule=revision,
            scheduled_for=scheduled_for,
            zone="Asia/Tehran",
            created_at=admitted_at,
            local_date=date(2030, 11, 6),
        )
        Audit.objects.create(action="schedule.dispatched", actor="scheduler", run=run, detail={"schedule": str(revision.pk)})
        Audit.objects.create(
            action="schedule.missed",
            actor="scheduler",
            detail={
                "schedule": str(revision.pk),
                "first_planned": "2030-11-04T21:00:00+00:00",
                "last_planned": "2030-11-04T21:00:00+00:00",
                "count": 1,
                "reason": "retrieval_slot_busy",
                "first_index": 1,
                "last_index": 1,
            },
        )
        response = self.dashboard()
        self.assertContains(response, "Admitted")
        self.assertContains(response, "Missed")
        self.assertContains(response, "The retrieval slot is busy.")
        self.assertContains(response, "November 6, 2030")
        detail = self.client.get(reverse("atlas_intake:run_detail", args=[run.pk]))
        self.assertContains(detail, "Planned occurrence")
        self.assertContains(detail, "Actual admission")
        self.assertContains(detail, "2030-11-06 00:30:00")
        self.assertContains(detail, "2030-11-06 00:40:00")

    def test_legacy_supersession_history_without_range_data_is_visible(self):
        self.client.force_login(self.operator)
        legacy = Schedule.objects.create(
            kind="legacy",
            wall_date=date(2030, 11, 5),
            wall_time=time(12),
            zone="UTC",
            due_at=datetime(2030, 11, 5, 12, tzinfo=UTC),
            status=Schedule.Status.SUPERSEDED,
        )
        Audit.objects.create(
            action="schedule.superseded", actor="operator", detail={"schedule": str(legacy.pk)}
        )
        self.assertEqual(self.post_schedule().status_code, 302)
        response = self.client.get(reverse("atlas_intake:dashboard"), {"revision": legacy.pk})
        self.assertContains(response, "Legacy one-off")
        self.assertContains(response, "Superseded")
        self.assertContains(response, "2030-11-05 12:00:00")

    def test_retry_requeues_the_artifact_once_and_records_operator(self):
        self.client.force_login(self.operator)
        run = self.launch_run()
        run.status = Run.Status.INCOMPLETE
        run.save(update_fields=["status"])
        artifact = run.artifacts.get(region_id="asia/iran", kind=Artifact.Kind.POLY)
        artifact.status = Artifact.Status.FAILED
        artifact.error = "Provider unavailable"
        artifact.retryable = True
        artifact.save(update_fields=["status", "error", "retryable"])
        url = reverse("atlas_intake:retry", args=[run.pk, artifact.pk])
        detail_url = reverse("atlas_intake:run_detail", args=[run.pk])
        self.assertContains(self.client.get(detail_url), "Retry file")

        for _ in range(2):
            self.assertRedirects(self.client.post(url), detail_url)

        artifact.refresh_from_db()
        run.refresh_from_db()
        self.assertEqual(artifact.status, Artifact.Status.PENDING)
        self.assertEqual(run.status, Run.Status.QUEUED)
        self.assertEqual(Audit.objects.get(run=run, action="artifact.retry_requested").actor, "operator")

    def test_stale_boundary_displays_last_retrieval_without_counting_as_complete(self):
        self.client.force_login(self.operator)
        original = self.launch_run()
        previous = original.artifacts.get(region_id="asia/iran", kind=Artifact.Kind.POLY)
        previous.status = Artifact.Status.COMPLETE
        previous.finished_at = datetime(2025, 7, 9, 23, tzinfo=UTC)
        previous.save(update_fields=["status", "finished_at"])
        current = self.launch_run()
        current_url = reverse("atlas_intake:run_detail", args=[current.pk])
        response = self.client.get(current_url)
        self.assertContains(response, "Last successful boundary retrieval 2025-07-10 Asia/Tehran")
        self.assertContains(response, reverse("atlas_intake:boundary", args=[original.pk, previous.pk]))
        self.assertContains(response, "0 of 3")

    def test_polygon_preview_checks_the_stored_fingerprint(self):
        self.client.force_login(self.operator)
        run = self.launch_run()
        artifact = run.artifacts.get(region_id="monaco", kind=Artifact.Kind.POLY)
        content = b"Monaco\n1\n 7 43\n 7.5 43\n 7.5 43.5\n 7 43\nEND\nEND\n"
        artifact.status = Artifact.Status.COMPLETE
        artifact.actual_length = len(content)
        artifact.sha256 = sha256(content).hexdigest()
        artifact.save(update_fields=["status", "actual_length", "sha256"])
        url = reverse("atlas_intake:boundary", args=[run.pk, artifact.pk])

        with TemporaryDirectory() as inbox, override_settings(ATLAS_INBOX=Path(inbox)):
            path = Path(inbox) / artifact.relative_path
            path.parent.mkdir(parents=True)
            path.write_bytes(content)
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"rings": [[[7, 43], [7.5, 43], [7.5, 43.5], [7, 43]]]})
            path.write_bytes(content.replace(b"7.5", b"7.6"))
            self.assertEqual(self.client.get(url).status_code, 409)

        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_automatic_mode_rejects_new_manual_post_but_returns_existing_run(self):
        self.client.force_login(self.operator)
        url = reverse("atlas_intake:launch")
        original_key = uuid4()
        first = self.client.post(url, {"request_key": original_key})
        self.assertEqual(first.status_code, 302)
        schedule = self.post_schedule()
        self.assertEqual(schedule.status_code, 302)
        replay = self.client.post(url, {"request_key": original_key})
        self.assertEqual(replay.status_code, 302)
        self.assertEqual(replay["Location"], first["Location"])
        new_key = uuid4()
        rejected = self.client.post(url, {"request_key": new_key})
        self.assertContains(rejected, "Switch to Manual mode", status_code=400)
        self.assertNotContains(self.dashboard(), 'name="request_key"')
        self.assertEqual(Run.objects.count(), 1)

        self.client.post(reverse("atlas_intake:manual_mode"))
        self.assertEqual(self.client.post(url, {"request_key": new_key}).status_code, 302)
        self.assertEqual(Run.objects.count(), 2)

    def test_publication_pause_offers_resume_via_the_operator_panel(self):
        self.client.force_login(self.operator)
        run = self.launch_run()
        Run.objects.filter(pk=run.pk).update(status=Run.Status.INCOMPLETE)
        file = run.artifacts.first()
        Artifact.objects.filter(pk=file.pk).update(
            status=Artifact.Status.PUBLICATION_PAUSED, retryable=True, publication_failures=3,
        )
        detail = reverse("atlas_intake:run_detail", args=[run.pk])
        self.assertContains(self.client.get(detail), "Resume publication")
        action = reverse("atlas_intake:retry", args=[run.pk, file.pk])
        self.assertRedirects(self.client.post(action), detail)
        file.refresh_from_db()
        run.refresh_from_db()
        self.assertEqual(file.status, Artifact.Status.PREPARED)
        self.assertEqual(file.publication_failures, 0)
        self.assertEqual(run.status, Run.Status.INCOMPLETE)
        self.assertEqual(Audit.objects.get(run=run, action="artifact.publication_resumed").actor, "operator")

    def test_catalog_refresh_error_is_visible_with_the_saved_catalog(self):
        self.client.force_login(self.operator)
        Control.objects.filter(pk=1).update(catalog_error="POLY discovery failed for Iran: timed out")
        response = self.dashboard()
        self.assertContains(response, "POLY discovery failed for Iran: timed out")
        self.assertContains(response, 'value="asia/iran"')
