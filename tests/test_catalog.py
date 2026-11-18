from django.test import TestCase

from atlas_intake.catalog import due_refresh, refresh_catalog
from atlas_intake.control import get_control
from atlas_intake.models import Audit, CatalogRevision
from atlas_intake.provider import ProviderError
from tests.test_control import install_catalog


class CatalogTests(TestCase):
    def test_refresh_failure_preserves_previous_revision(self):
        previous = install_catalog()

        class Invalid:
            def catalog(self):
                raise ProviderError("invalid_catalog", "Invalid fixture response.")

        self.assertIsNone(refresh_catalog(Invalid()))
        control = get_control()
        self.assertEqual(control.catalog_id, previous.pk)
        self.assertEqual(control.catalog_error, "Invalid fixture response.")

    def test_death_before_refresh_result_keeps_request_pending(self):
        self.assertTrue(due_refresh())
        self.assertTrue(due_refresh())
        self.assertTrue(get_control().catalog_refresh_requested)

    def test_operator_refresh_rediscovers_changed_poly_links(self):
        previous = install_catalog()
        previous.source_digest = "fixture"
        previous.save(update_fields=["source_digest"])

        class NewLinks:
            def catalog(self):
                return "fixture", previous.regions

            def discover_poly(self, region):
                return f"https://download.geofabrik.de/updated/{region['id']}.poly", ""

        revision = refresh_catalog(NewLinks())
        self.assertNotEqual(revision.pk, previous.pk)
        self.assertTrue(all("/updated/" in region["poly_url"] for region in revision.regions))
        self.assertFalse(get_control().catalog_refresh_requested)

    def test_transient_poly_discovery_failure_keeps_last_known_good_catalog(self):
        previous = install_catalog()

        class TransientFailure:
            def catalog(self):
                return "new-upstream-digest", previous.regions

            def discover_poly(self, region):
                if region["id"] == "iran":
                    raise ProviderError("timeout", "Geofabrik response timed out.", retryable=True)
                return region["poly_url"], ""

        self.assertIsNone(refresh_catalog(TransientFailure()))
        control = get_control()
        self.assertEqual(control.catalog_id, previous.pk)
        self.assertIn("iran", control.catalog_error)
        self.assertIn("Geofabrik response timed out.", control.catalog_error)
        self.assertIsNotNone(control.catalog_checked_at)
        self.assertFalse(control.catalog_refresh_requested)
        self.assertEqual(CatalogRevision.objects.count(), 1)
        failure = Audit.objects.get(action="catalog.failed")
        self.assertEqual(failure.detail["region"], "iran")
        self.assertEqual(failure.detail["code"], "timeout")

    def test_confirmed_unresolved_poly_is_recorded_in_new_revision(self):
        previous = install_catalog()

        class MissingLink:
            def catalog(self):
                return "new-upstream-digest", previous.regions

            def discover_poly(self, region):
                if region["id"] == "iran":
                    raise ProviderError("poly_unresolved", "The region page has no POLY link.")
                return region["poly_url"], ""

        revision = refresh_catalog(MissingLink())
        self.assertNotEqual(revision.pk, previous.pk)
        self.assertEqual(get_control().catalog_id, revision.pk)
        iran = next(region for region in revision.regions if region["id"] == "iran")
        self.assertEqual(iran["poly_error_code"], "poly_unresolved")
        self.assertEqual(get_control().catalog_error, "")

    def test_automatic_retry_rediscovers_links_after_same_digest_discovery_failure(self):
        previous = install_catalog()
        previous.source_digest = "same-upstream-digest"
        previous.save(update_fields=["source_digest"])

        class Source:
            unavailable = True

            def catalog(self):
                return previous.source_digest, previous.regions

            def discover_poly(self, region):
                if region["id"] == "iran":
                    if self.unavailable:
                        raise ProviderError("timeout", "Geofabrik timed out.", retryable=True)
                    return "https://download.geofabrik.de/asia/iran-new.poly", ""
                return region["poly_url"], ""

        client = Source()
        self.assertIsNone(refresh_catalog(client))
        self.assertFalse(get_control().catalog_refresh_requested)
        client.unavailable = False
        revision = refresh_catalog(client)
        self.assertEqual(get_control().catalog_error, "")
        iran = next(region for region in revision.regions if region["id"] == "iran")
        self.assertEqual(iran["poly_url"], "https://download.geofabrik.de/asia/iran-new.poly")
