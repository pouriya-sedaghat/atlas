from django.test import TestCase

from atlas_intake.catalog import due_refresh, refresh_catalog
from atlas_intake.control import get_control
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
