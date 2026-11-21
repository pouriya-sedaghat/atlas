"""Explicit public POLY intent, source identity, overrides and frozen acquisition."""
import copy
import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import TestCase, override_settings

from atlas_intake.catalog import refresh_catalog
from atlas_intake.control import get_control, launch_manual, retry_artifact, set_selection
from atlas_intake.models import Artifact, CatalogRevision, Control, Run
from atlas_intake.provider import Client, ProviderError
from atlas_intake.worker import Worker
from django.utils import timezone
from tests.test_provider import POLY
from tests.test_control import install_catalog
from tests.test_provider import BASE, INDEX, FixtureHTTP, Reply, catalog, feature, source_revision
from tests.test_worker import FixtureProvider


DIRECT = BASE + "/a/a.poly"
ABSENT = object()


def entry(region="a", *, poly=DIRECT, pbf=BASE + "/a/a-latest.osm.pbf"):
    row = feature(region, pbf=pbf)
    if poly is not ABSENT:
        row["properties"].setdefault("urls", {})["poly"] = poly
    return row


def client_for(body, routes=None, overrides=None):
    opener = FixtureHTTP({("GET", INDEX): Reply(body=body), **(routes or {})})
    return Client(opener=opener, overrides={} if overrides is None else overrides)


def mapping(body, **fields):
    return {
        "entry_id": "reviewed-a", "region_id": "a", "catalog_sha256": source_revision(body),
        "page_url": BASE + "/obsolete.html", **fields,
    }


class ExplicitProviderTests(unittest.TestCase):
    def test_direct_and_boundary_only_rows_resolve_without_html(self):
        body = catalog([entry(), entry("boundary", pbf=None, poly=BASE + "/boundary/boundary.poly")])
        client = client_for(body)
        _, rows = client.catalog()
        self.assertEqual([client.discover_poly(row) for row in rows], [
            (DIRECT, ""), (BASE + "/boundary/boundary.poly", ""),
        ])
        self.assertEqual(rows[0]["advertised_poly_url"], DIRECT)
        self.assertNotIn("poly_url", rows[0])
        self.assertEqual(rows[1]["pbf_url"], "")
        self.assertEqual([r.full_url for r in client.opener.requests], [BASE + INDEX])

    def test_absent_values_keep_legacy_canonical_digest(self):
        for poly in (ABSENT, None, ""):
            with self.subTest(poly=poly):
                client = client_for(catalog([entry(poly=poly, pbf=None)]))
                digest, rows = client.catalog()
                self.assertEqual(digest, "1e806b4f38e1269001dbdb1f8f0847bddf9757283ce30e5ce98e2cfd7cb65657")
                self.assertNotIn("advertised_poly_url", rows[0])

    def test_mixed_rows_and_absent_values_use_existing_page_fallback(self):
        for poly in (ABSENT, None, ""):
            with self.subTest(poly=poly):
                body = catalog([entry(), entry("legacy", poly=poly, pbf=BASE + "/legacy-latest.osm.pbf")])
                client = client_for(body, {("GET", "/legacy.html"): Reply(
                    body=b'<a href="legacy.poly"><a href="legacy.poly"><a href="legacy.poly.md5">',
                )})
                _, rows = client.catalog()
                self.assertEqual(client.discover_poly(rows[0]), (DIRECT, ""))
                self.assertEqual(client.discover_poly(rows[1]), (BASE + "/legacy.poly", BASE + "/legacy.poly.md5"))
                self.assertEqual([r.full_url for r in client.opener.requests], [BASE + INDEX, BASE + "/legacy.html"])

    def test_only_advertised_url_changes_provider_digest(self):
        first = source_revision(catalog([entry()]))
        second = source_revision(catalog([entry(poly=BASE + "/a/new.poly")]))
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, source_revision(catalog([entry(poly=ABSENT)])))

    def test_matching_and_page_only_mapping_sidecars_need_no_page_request(self):
        body = catalog([entry()])
        for fields in ({}, {"poly_url": DIRECT}, {"sidecar_url": DIRECT + ".md5"},
                       {"poly_url": DIRECT, "sidecar_url": DIRECT + ".md5"}):
            with self.subTest(fields=fields):
                reviewed = mapping(body, **fields)
                client = client_for(body, overrides={"mappings": [reviewed]})
                digest, rows = client.catalog()
                self.assertNotEqual(digest, reviewed["catalog_sha256"])
                self.assertEqual(client.discover_poly(rows[0]), (DIRECT, fields.get("sidecar_url", "")))
                self.assertEqual(len(client.opener.requests), 1)

    def test_historical_digest_mapping_is_not_rebound(self):
        legacy = catalog([entry(poly=ABSENT)])
        reviewed = mapping(legacy, poly_url=BASE + "/old.poly")
        client = client_for(catalog([entry()]), overrides={"mappings": [reviewed]})
        digest, rows = client.catalog()
        self.assertNotEqual(digest, reviewed["catalog_sha256"])
        self.assertNotIn("poly_mapping", rows[0])
        self.assertEqual(client.discover_poly(rows[0]), (DIRECT, ""))


class ExplicitRefreshTests(TestCase):
    def test_empty_control_promotes_full_direct_rows_and_records_provenance(self):
        get_control()
        body = catalog([entry(), entry("boundary", pbf=None, poly=BASE + "/boundary.poly")])
        revision = refresh_catalog(client_for(body))
        self.assertIsNotNone(revision)
        self.assertEqual(get_control().catalog_id, revision.pk)
        self.assertEqual([r["poly_source"] for r in revision.regions], ["catalog", "catalog"])
        self.assertEqual([r["poly_url"] for r in revision.regions], [DIRECT, BASE + "/boundary.poly"])
        self.assertEqual(revision.regions[1]["advertised_poly_url"], BASE + "/boundary.poly")

    def test_unsafe_advertised_values_reject_refresh_and_keep_last_good(self):
        previous = install_catalog()
        original = copy.deepcopy(previous.regions)
        for value in (
            "http://download.geofabrik.de/a.poly", "https://evil.invalid/a.poly",
            "https://osm-internal.download.geofabrik.de/a.poly", "https://download.geofabrik.de:444/a.poly",
            "https://user:secret@download.geofabrik.de/a.poly", BASE + "/a/../a.poly",
            BASE + "/a/%61.poly", BASE + "/a.poly?x=1", BASE + "/a.poly#x",
            BASE + "/a.osm.pbf", BASE + "/a.poly/", 0, False, True, [], {}, ["a"], 1.5,
        ):
            with self.subTest(value=value):
                self.assertIsNone(refresh_catalog(client_for(catalog([entry(poly=value)]))))
                state = get_control()
                self.assertEqual(state.catalog_id, previous.pk)
                self.assertTrue(state.catalog_error)
                self.assertEqual(CatalogRevision.objects.count(), 1)
                previous.refresh_from_db()
                self.assertEqual(previous.regions, original)
                self.assertNotIn("secret", state.catalog_error)

    def test_override_conflict_rejects_whole_refresh_not_just_one_row(self):
        previous = install_catalog()
        body = catalog([entry(), entry("other", poly=BASE + "/other.poly")])
        reviewed = mapping(body, poly_url=BASE + "/different.poly")
        self.assertIsNone(refresh_catalog(client_for(body, overrides={"mappings": [reviewed]})))
        self.assertEqual(get_control().catalog_id, previous.pk)
        self.assertTrue(get_control().catalog_error)
        self.assertEqual(CatalogRevision.objects.count(), 1)

    def test_invalid_direct_mapping_sidecar_rejects_refresh(self):
        previous = install_catalog()
        body = catalog([entry()])
        reviewed = mapping(body, sidecar_url=BASE + "/a/another.poly.md5")
        self.assertIsNone(refresh_catalog(client_for(body, overrides={"mappings": [reviewed]})))
        self.assertEqual(get_control().catalog_id, previous.pk)
        self.assertEqual(CatalogRevision.objects.count(), 1)
        self.assertTrue(get_control().catalog_error)

    def test_changed_url_changes_stored_revision_and_preserves_old_row(self):
        get_control()
        first = refresh_catalog(client_for(catalog([entry()])))
        old_rows = copy.deepcopy(first.regions)
        second = refresh_catalog(client_for(catalog([entry(poly=BASE + "/a/new.poly")])))
        self.assertNotEqual(first.source_digest, second.source_digest)
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(second.regions[0]["poly_url"], BASE + "/a/new.poly")
        first.refresh_from_db()
        self.assertEqual(first.regions, old_rows)

    def test_cache_cannot_substitute_legacy_or_different_advertised_mapping(self):
        for old_advertised in (None, BASE + "/a/old.poly"):
            with self.subTest(old_advertised=old_advertised):
                body = catalog([entry()])
                digest, rows = client_for(body).catalog()
                stale = copy.deepcopy(rows)
                stale[0].pop("advertised_poly_url", None)
                if old_advertised:
                    stale[0]["advertised_poly_url"] = old_advertised
                stale[0].update(poly_url=BASE + "/stale.poly", sidecar_url="")
                old = CatalogRevision.objects.create(digest=hashlib.sha256(str(old_advertised).encode()).hexdigest(),
                                                     source_digest=digest, regions=stale)
                get_control()
                Control.objects.filter(pk=1).update(catalog=old, catalog_refresh_requested=False, catalog_error="")
                fresh = refresh_catalog(client_for(body))
                self.assertEqual(fresh.regions[0]["poly_url"], DIRECT)
                self.assertEqual(fresh.regions[0]["poly_source"], "catalog")

    def test_legacy_page_and_reviewed_mapping_provenance(self):
        get_control()
        body = catalog([entry(poly=ABSENT, pbf=BASE + "/a-latest.osm.pbf")])
        routes = {("GET", "/a.html"): Reply(body=b'<a href="a.poly">')}
        plain = refresh_catalog(client_for(body, routes))
        self.assertEqual(plain.regions[0]["poly_source"], "page")
        reviewed = mapping(body, poly_url=BASE + "/mapped.poly")
        mapped = refresh_catalog(client_for(body, {("GET", "/obsolete.html"): Reply(body=b'<a href="mapped.poly">')},
                                             {"mappings": [reviewed]}))
        self.assertEqual(mapped.regions[0]["poly_source"], "reviewed_mapping")

    def test_scoped_exception_precedes_direct_and_conflicting_mapping(self):
        get_control()
        body = catalog([entry()])
        exception = {"entry_id": "approved-a", "region_id": "a", "catalog_sha256": source_revision(body),
                     "reason": "Previously approved fixture scope", "evidence": BASE + "/a.html", "approved_by": "fixture"}
        reviewed = mapping(body, poly_url=BASE + "/old.poly")
        revision = refresh_catalog(client_for(body, overrides={"mappings": [reviewed], "exceptions": [exception]}))
        self.assertEqual(revision.regions[0]["exception"], exception)
        self.assertEqual(revision.regions[0]["poly_source"], "reviewed_exception")
        self.assertEqual(revision.regions[0]["poly_url"], "")
        changed_body = catalog([entry(poly=BASE + "/a/changed.poly")])
        changed = refresh_catalog(client_for(changed_body, overrides={"mappings": [reviewed], "exceptions": [exception]}))
        self.assertNotIn("exception", changed.regions[0])
        self.assertEqual(changed.regions[0]["poly_source"], "catalog")


class FrozenDirectFailureTests(TestCase):
    @override_settings(ATLAS_LIMITS={"pbf": 128, "poly": 128, "run": 1024, "inbox": 1024**2, "free": 1})
    def test_rejected_direct_target_keeps_frozen_intent_and_historical_bytes(self):
        previous = install_catalog()
        historical_rows = copy.deepcopy(previous.regions)
        set_selection(["iran"], "operator")
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_worker = Worker(FixtureProvider(), root)
            old_run = launch_manual("historical-direct-test", "operator")
            for _ in range(8):
                old_worker.work_tick(parallel=False)
            old_run.refresh_from_db()
            self.assertEqual(old_run.status, Run.Status.SEALED)
            old_artifacts = list(old_run.artifacts.order_by("pk").values(
                "pk", "requested_url", "resolved_url", "pin", "sha256", "relative_path",
            ))
            body = catalog([entry(pbf=None)])
            client = client_for(body, {("HEAD", "/a/a.poly"): Reply(404)})
            fresh_catalog = refresh_catalog(client)
            set_selection([], "operator")
            new_run = launch_manual("failed-direct-test", "operator")
            Worker(client, root).work_tick(parallel=False)
            new_run.refresh_from_db()
            self.assertEqual(new_run.status, Run.Status.INCOMPLETE)
            artifact = new_run.artifacts.get()
            self.assertEqual(artifact.status, Artifact.Status.FAILED)
            self.assertEqual(artifact.error_code, "target_missing")
            self.assertEqual(artifact.requested_url, DIRECT)
            self.assertEqual(artifact.pin, {})
            self.assertEqual([r.full_url for r in client.opener.requests], [BASE + INDEX, DIRECT])
            self.assertEqual(fresh_catalog.regions[0]["advertised_poly_url"], DIRECT)
            previous.refresh_from_db()
            self.assertEqual(previous.regions, historical_rows)
            self.assertEqual(list(old_run.artifacts.order_by("pk").values(
                "pk", "requested_url", "resolved_url", "pin", "sha256", "relative_path",
            )), old_artifacts)
            for row in old_artifacts:
                self.assertEqual(hashlib.sha256((root / row["relative_path"]).read_bytes()).hexdigest(), row["sha256"])

    @override_settings(ATLAS_LIMITS={"pbf": 128, "poly": 128, "run": 1024, "inbox": 1024**2, "free": 1})
    def test_rejected_direct_download_preserves_established_pin_without_fallback(self):
        get_control()
        body = catalog([entry(pbf=None)])
        client = client_for(body, {
            ("HEAD", "/a/a.poly"): Reply(Content_Length=50, ETag='"direct"'),
            ("GET", "/a/a.poly"): Reply(404),
        })
        refresh_catalog(client)
        run = launch_manual("rejected-direct-download", "operator")
        with TemporaryDirectory() as temporary:
            Worker(client, Path(temporary)).work_tick(parallel=False)
        run.refresh_from_db()
        artifact = run.artifacts.get()
        self.assertEqual(run.status, Run.Status.INCOMPLETE)
        self.assertEqual(artifact.error_code, "target_missing")
        self.assertEqual(artifact.status, Artifact.Status.FAILED)
        self.assertEqual(artifact.requested_url, DIRECT)
        self.assertEqual(artifact.resolved_url, DIRECT)
        self.assertEqual(artifact.pin["url"], DIRECT)
        self.assertEqual(artifact.pin["etag"], '"direct"')
        self.assertEqual([r.full_url for r in client.opener.requests], [BASE + INDEX, DIRECT, DIRECT])

    @override_settings(ATLAS_LIMITS={"pbf": 128, "poly": 128, "run": 1024, "inbox": 1024**2, "free": 1})
    def test_retryable_direct_download_retains_first_pin_for_all_retries(self):
        get_control()
        body = catalog([entry(pbf=None)])
        client = client_for(body, {
            ("HEAD", "/a/a.poly"): Reply(Content_Length=len(POLY), ETag='"first"'),
            ("GET", "/a/a.poly"): Reply(503),
        })
        refresh_catalog(client)
        run = launch_manual("direct-retries", "operator")
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = Worker(client, root)
            worker.work_tick(parallel=False)
            artifact = run.artifacts.get()
            original_pin = copy.deepcopy(artifact.pin)
            self.assertEqual(artifact.status, Artifact.Status.PENDING)
            client.opener.routes[("HEAD", "/a/a.poly")] = Reply(Content_Length=len(POLY), ETag='"replacement"')
            for _ in range(2):
                client.opener.routes[("GET", "/a/a.poly")] = Reply(503)
                Artifact.objects.filter(pk=artifact.pk).update(retry_at=timezone.now())
                worker.work_tick(parallel=False)
                artifact.refresh_from_db()
                self.assertEqual(artifact.pin, original_pin)
            run.refresh_from_db()
            self.assertEqual(run.status, Run.Status.INCOMPLETE)
            self.assertEqual(artifact.error_code, "unexpected_status")
            self.assertTrue(artifact.retryable)
            self.assertFalse((root / artifact.relative_path).exists())
            retry_artifact(run.pk, artifact.pk, "operator")
            client.opener.routes[("GET", "/a/a.poly")] = Reply(body=POLY, Content_Length=len(POLY), ETag='"replacement"')
            worker.work_tick(parallel=False)
            artifact.refresh_from_db()
            self.assertEqual(artifact.pin, original_pin)
            self.assertEqual(artifact.error_code, "validator_changed")
            self.assertEqual(artifact.requested_url, DIRECT)
            self.assertFalse((root / artifact.relative_path).exists())
            self.assertEqual([r.get_method() for r in client.opener.requests], ["GET", "HEAD", "GET", "GET", "GET", "GET"])
            self.assertEqual([r.get_header("If-match") for r in client.opener.requests if r.get_method() == "GET"][1:],
                             ['"first"', '"first"', '"first"', '"first"'])
