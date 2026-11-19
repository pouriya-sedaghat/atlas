from datetime import date
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from atlas_intake.models import Artifact, CatalogRevision, Run
from atlas_verification.control import canonical, frozen_inputs, input_fingerprint
from atlas_verification.models import VerificationAttempt


class VerificationPanelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.operator = get_user_model().objects.create_user(username="verifier")
        cls.operator.user_permissions.add(Permission.objects.get(codename="operate"))
        cls.staff = get_user_model().objects.create_user(username="staff", is_staff=True)
        cls.catalog = CatalogRevision.objects.create(
            pk="d" * 64,
            regions=[{"id": "asia/iran", "name": "Iran"}, {"id": "monaco", "name": "Monaco"}],
        )

    def setUp(self):
        self.client.force_login(self.operator)
        self.run = self.sealed_run()

    def sealed_run(self):
        run = Run.objects.create(
            request_key=str(uuid4()), origin="manual", actor="verifier", catalog=self.catalog,
            selection=["asia/iran"], zone="Asia/Tehran", created_at=timezone.now(),
            local_date=date(2026, 11, 18), status=Run.Status.SEALED, sealed_at=timezone.now(),
        )
        for region_id, kind in [("asia/iran", "pbf"), ("asia/iran", "poly"), ("monaco", "poly")]:
            Artifact.objects.create(
                run=run, region_id=region_id, region_name=region_id, kind=kind,
                status=Artifact.Status.COMPLETE, relative_path=f"{run.pk}/{region_id}.{kind}",
                actual_length=4, sha256=sha256(b"data").hexdigest(), checksum_status="verified",
            )
        return run

    def attempt(self, **values):
        snapshot = frozen_inputs(self.run)
        return VerificationAttempt.objects.create(
            run=self.run, requested_by="verifier", request_key=str(uuid4()), snapshot=snapshot,
            input_fingerprint=input_fingerprint(snapshot), **values,
        )

    def batch_manifest(self, attempt, regions=None):
        return {"schema_version": 1, "policy_version": "atlas-input-v1",
                "run_id": str(self.run.pk), "verification_id": str(attempt.pk),
                "catalog_digest": self.catalog.pk, "input_fingerprint": attempt.input_fingerprint,
                "status": "verified", "build_eligible": attempt.build_eligible,
                "regions": regions or [], "frozen_inputs": attempt.snapshot, "tools": {}}

    def test_anonymous_and_staff_cannot_read_or_request(self):
        self.client.logout()
        url = reverse("verification:index")
        self.assertRedirects(self.client.get(url), f"{reverse('atlas_intake:login')}?next={url}")
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(url).status_code, 403)
        self.assertEqual(self.client.post(reverse("verification:request", args=[self.run.pk])).status_code, 403)
        self.assertFalse(VerificationAttempt.objects.exists())

    def test_actions_require_post_and_csrf(self):
        attempt = self.attempt(status="operational_failed")
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.operator)
        for url in [reverse("verification:request", args=[self.run.pk]), reverse("verification:retry", args=[attempt.pk])]:
            self.assertEqual(client.get(url).status_code, 405)
            self.assertEqual(client.post(url).status_code, 403)

    def test_exact_runs_with_the_same_date_remain_distinct(self):
        second = self.sealed_run()
        response = self.client.get(reverse("verification:index"))
        self.assertContains(response, str(self.run.pk))
        self.assertContains(response, str(second.pk))
        detail = self.client.get(reverse("verification:run_detail", args=[self.run.pk]))
        self.assertContains(detail, str(self.run.pk))
        self.assertNotContains(detail, str(second.pk))
        self.assertContains(detail, self.catalog.pk)
        self.assertContains(detail, "Boundary-only regions")
        self.assertContains(detail, "monaco")
        self.assertContains(detail, "Sealed")

    def test_request_key_replays_and_distinct_key_creates_new_attempt(self):
        url = reverse("verification:request", args=[self.run.pk])
        key = str(uuid4())
        response = self.client.post(url, {"request_key": key})
        self.assertEqual(response.status_code, 302)
        first = VerificationAttempt.objects.get()
        self.assertRedirects(response, reverse("verification:attempt_detail", args=[first.pk]))
        Run.objects.filter(pk=self.run.pk).update(status=Run.Status.INTEGRITY_FAILED)
        self.assertEqual(self.client.post(url, {"request_key": key})["Location"], response["Location"])
        self.assertEqual(self.client.post(url, {"request_key": str(uuid4())}).status_code, 400)
        self.assertEqual(VerificationAttempt.objects.count(), 1)
        Run.objects.filter(pk=self.run.pk).update(status=Run.Status.SEALED)
        self.assertEqual(self.client.post(url, {"request_key": str(uuid4())}).status_code, 302)
        self.assertEqual(VerificationAttempt.objects.count(), 2)

    def test_operational_retry_retains_snapshot_and_input_failure_cannot_retry(self):
        attempt = self.attempt(status="operational_failed", generation=1, summary={"completed_checks": ["hash"]})
        before = attempt.snapshot
        url = reverse("verification:retry", args=[attempt.pk])
        self.assertRedirects(self.client.post(url), reverse("verification:attempt_detail", args=[attempt.pk]))
        attempt.refresh_from_db()
        self.assertEqual(attempt.snapshot, before)
        self.assertEqual(attempt.generation, 1)
        self.assertEqual(attempt.status, "queued")
        VerificationAttempt.objects.filter(pk=attempt.pk).update(status="input_invalid")
        self.assertEqual(self.client.post(url).status_code, 400)

    def test_attempt_displays_original_snapshot_and_progress_after_source_change(self):
        attempt = self.attempt(progress={"phase": "references", "objects": "123"}, summary={"reason": "disk cap"})
        original = attempt.snapshot["artifacts"][0]["sha256"]
        Artifact.objects.filter(run=self.run).update(sha256="e" * 64)
        response = self.client.get(reverse("verification:attempt_detail", args=[attempt.pk]))
        self.assertContains(response, original)
        self.assertContains(response, "references")
        self.assertContains(response, "disk cap")
        self.assertContains(response, attempt.input_fingerprint)

    def test_manifest_is_authenticated_digest_checked_and_revoked_with_source(self):
        attempt = self.attempt(status="verified", successful=True, build_eligible=True)
        payload = canonical(self.batch_manifest(attempt))
        with TemporaryDirectory() as directory, override_settings(ATLAS_VERIFICATION_ROOT=Path(directory)):
            path = Path(directory) / "manifest.json"
            path.write_bytes(payload)
            attempt.manifest_path = "manifest.json"
            attempt.manifest_sha256 = sha256(payload).hexdigest()
            attempt.save()
            url = reverse("verification:manifest", args=[attempt.pk])
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(sha256(response.content).hexdigest(), attempt.manifest_sha256)
            path.write_bytes(b"{}")
            self.assertEqual(self.client.get(url).status_code, 409)
            attempt.manifest_sha256 = sha256(b"{}").hexdigest()
            attempt.save()
            self.assertEqual(self.client.get(url).status_code, 409)
            attempt.manifest_sha256 = sha256(payload).hexdigest()
            attempt.save()
            path.write_bytes(payload)
            Run.objects.filter(pk=self.run.pk).update(status=Run.Status.INTEGRITY_FAILED)
            self.assertEqual(self.client.get(url).status_code, 409)
            self.client.force_login(self.staff)
            self.assertEqual(self.client.get(url).status_code, 403)

    def test_regional_manifest_checks_registered_path_digest_identity_and_permission(self):
        attempt = self.attempt(status="verified", successful=True)
        key = sha256(b"asia/iran").hexdigest()
        regional = canonical({"schema_version": 1, "policy_version": "atlas-input-v1", "region_id": "asia/iran", "input_fingerprint": attempt.input_fingerprint, "inputs": [], "outputs": [], "checks": {"poly": {"status": "verified"}}})
        payload = canonical(self.batch_manifest(attempt, [{"region_id": "asia/iran", "path": f"regions/{key}/manifest.json", "sha256": sha256(regional).hexdigest(), "size": len(regional)}]))
        with TemporaryDirectory() as directory, override_settings(ATLAS_VERIFICATION_ROOT=Path(directory)):
            path = Path(directory) / "regions" / key
            path.mkdir(parents=True)
            (path / "manifest.json").write_bytes(regional)
            (Path(directory) / "manifest.json").write_bytes(payload)
            attempt.manifest_path = "manifest.json"
            attempt.manifest_sha256 = sha256(payload).hexdigest()
            attempt.save()
            url = reverse("verification:region_manifest", args=[attempt.pk, key])
            self.assertContains(self.client.get(url), "poly · verified")
            self.assertEqual(self.client.get(reverse("verification:region_manifest", args=[attempt.pk, "e" * 64])).status_code, 404)
            (path / "manifest.json").write_bytes(b"{}")
            self.assertEqual(self.client.get(url).status_code, 409)
            self.client.force_login(self.staff)
            self.assertEqual(self.client.get(url).status_code, 403)
