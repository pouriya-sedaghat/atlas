from django.core.exceptions import ValidationError
from django.test import TestCase

from atlas_intake.control import launch_manual
from atlas_intake.models import Artifact, Audit, Run
from atlas_verification.control import request_verification, retry_verification, frozen_inputs, input_fingerprint
from atlas_verification.models import VerificationAttempt
from tests.test_control import install_catalog


def sealed_fixture(key="sealed"):
    run = launch_manual(key, "operator")
    run.artifacts.update(status=Artifact.Status.COMPLETE, actual_length=10, sha256="a"*64)
    Run.objects.filter(pk=run.pk).update(status=Run.Status.SEALED)
    run.refresh_from_db()
    return run


class VerificationControlTests(TestCase):
    def setUp(self):
        install_catalog()

    def test_request_replay_after_invalidation_returns_original_snapshot(self):
        run = sealed_fixture()
        first = request_verification(run.pk, "same", "operator")
        first_snapshot = first.snapshot
        Run.objects.filter(pk=run.pk).update(status=Run.Status.INTEGRITY_FAILED)
        self.assertEqual(request_verification(run.pk, "same", "operator").pk, first.pk)
        first.refresh_from_db()
        self.assertEqual(first.snapshot, first_snapshot)
        with self.assertRaises(ValidationError):
            request_verification(run.pk, "different", "operator")

    def test_intentional_reverification_has_same_input_fingerprint(self):
        run = sealed_fixture()
        first = request_verification(run.pk, "one", "operator")
        second = request_verification(run.pk, "two", "operator")
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(first.input_fingerprint, second.input_fingerprint)
        self.assertEqual(first.snapshot, second.snapshot)
        self.assertTrue(Audit.objects.filter(action="verification.requested", actor="operator").exists())

    def test_unsealed_and_mismatched_expected_set_are_rejected(self):
        run = launch_manual("unsealed", "operator")
        with self.assertRaises(ValidationError):
            request_verification(run.pk, "one", "operator")
        Run.objects.filter(pk=run.pk).update(status=Run.Status.SEALED)
        with self.assertRaises(ValidationError):
            request_verification(run.pk, "two", "operator")

    def test_retry_keeps_snapshot_and_only_operational_failure_is_eligible(self):
        run = sealed_fixture()
        attempt = request_verification(run.pk, "one", "operator")
        with self.assertRaises(ValidationError):
            VerificationAttempt.objects.filter(pk=attempt.pk).update(status="input_invalid")
            retry_verification(attempt.pk, "operator")
        VerificationAttempt.objects.filter(pk=attempt.pk).update(status="operational_failed")
        retry_verification(attempt.pk, "operator")
        retry_verification(attempt.pk, "operator")
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, "queued")
        self.assertEqual(attempt.input_fingerprint, input_fingerprint(frozen_inputs(run)))
