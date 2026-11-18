import hashlib
import io
import json
import unittest
from email.message import Message
from unittest.mock import patch

from atlas_intake.provider import Client, ProviderError


BASE = "https://download.geofabrik.de"
INDEX = "/index-v1-nogeom.json"
LATEST = "/asia/iran-latest.osm.pbf"
DATED = "/asia/iran-261117.osm.pbf"
POLY = b"iran\n1\n  1 2\n  2 2\n  2 3\n  1 2\nEND\nEND\n"
PBF = b"small synthetic transfer"
PBF_MD5 = hashlib.md5(PBF, usedforsecurity=False).hexdigest()
MODIFIED = "Wed, 18 Nov 2026 00:04:18 GMT"


class Reply(io.BytesIO):
    def __init__(self, status=200, body=b"", **headers):
        super().__init__(body)
        self.status = status
        self.headers = Message()
        for key, val in headers.items():
            self.headers[key.replace("_", "-")] = str(val)


class FixtureHTTP:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        method = request.get_method()
        self_url = request.full_url
        if not self_url.startswith(BASE + "/"):
            raise AssertionError(f"Made a request outside the fixture: {self_url}")
        route = (method, self_url.removeprefix(BASE))
        if route not in self.routes:
            raise AssertionError(f"Unexpected fixture request: {route}")
        return self.routes[route]


def feature(id, *, name="Repeated Name", parent=None, pbf=None):
    properties = {"id": id, "name": name}
    if parent is not None:
        properties["parent"] = parent
    if pbf is not None:
        properties["urls"] = {"pbf": pbf}
    return {"type": "Feature", "properties": properties}


def catalog(features):
    return json.dumps({"type": "FeatureCollection", "features": features}).encode()


def source_revision(payload):
    opener = FixtureHTTP({("GET", INDEX): Reply(body=payload)})
    return Client(opener=opener, overrides={}).catalog()[0]


class CatalogTests(unittest.TestCase):
    def test_identity_and_hierarchy_allow_slash_ids_and_duplicate_names(self):
        payload = catalog([
            feature("us/alabama", parent="north-america",
                    pbf=BASE + "/north-america/us/alabama-latest.osm.pbf"),
            feature("north-america"),
            feature("us~2falabama", parent="north-america"),
            feature("alabama", parent="us/alabama"),
        ])
        revision, regions = Client(opener=FixtureHTTP({("GET", INDEX): Reply(body=payload)})).catalog()
        self.assertEqual(len(revision), 64)
        by_id = {region["id"]: region for region in regions}
        self.assertEqual(by_id["us/alabama"]["path"], "north-america/us~2falabama")
        self.assertEqual(by_id["alabama"]["path"], "north-america/us~2falabama/alabama")
        self.assertEqual(by_id["north-america"]["pbf_url"], "")
        self.assertIsNone(by_id["north-america"]["parent"])
        self.assertEqual(len({region["path"] for region in regions}), 4)

    def test_catalog_digest_ignores_equivalent_serialization_and_feature_order(self):
        entries = [feature("a"), feature("b", parent="a")]
        payload = catalog(entries)
        reversed_and_formatted = json.dumps(
            {"features": list(reversed(entries)), "type": "FeatureCollection"}, indent=4,
        ).encode()
        self.assertEqual(source_revision(payload), source_revision(reversed_and_formatted))
        self.assertNotEqual(source_revision(payload), source_revision(catalog([feature("a")])))

    def test_ids_fit_the_persistent_artifact_identifier(self):
        accepted = catalog([feature("a" * 200)])
        opener = FixtureHTTP({("GET", INDEX): Reply(body=accepted)})
        self.assertEqual(Client(opener=opener).catalog()[1][0]["id"], "a" * 200)
        oversized = catalog([feature("a" * 201)])
        opener = FixtureHTTP({("GET", INDEX): Reply(body=oversized)})
        with self.assertRaises(ProviderError) as error:
            Client(opener=opener).catalog()
        self.assertEqual(error.exception.code, "invalid_catalog")

    def test_rejects_invalid_catalog(self):
        cases = [
            [feature("a"), feature("a")],
            [feature("a", parent="b")],
            [feature("a", parent="b"), feature("b", parent="a")],
            [feature("a", pbf="https://osm-internal.download.geofabrik.de/a-latest.osm.pbf")],
            [feature("a", pbf=BASE + "/a.poly")],
        ]
        for entries in cases:
            with self.subTest(entries=entries):
                client = Client(opener=FixtureHTTP({("GET", INDEX): Reply(body=catalog(entries))}))
                with self.assertRaises(ProviderError):
                    client.catalog()

    def test_reviewed_mapping_binds_to_exact_catalog_and_selects_advertised_link(self):
        payload = catalog([feature("a")])
        entry = {
            "entry_id": "region-a",
            "region_id": "a",
            "catalog_sha256": source_revision(payload),
            "page_url": BASE + "/special.html",
            "poly_url": BASE + "/known.poly",
            "sidecar_url": BASE + "/known.poly.md5",
        }
        opener = FixtureHTTP({
            ("GET", INDEX): Reply(body=payload),
            ("GET", "/special.html"): Reply(body=b'<a href="other.poly"><a href="known.poly">'),
        })
        revision, regions = Client(opener=opener, overrides={"mappings": [entry]}).catalog()
        self.assertNotEqual(revision, entry["catalog_sha256"])
        self.assertEqual(regions[0]["poly_mapping"], entry)
        self.assertEqual(
            Client(opener=opener).discover_poly(regions[0]),
            (BASE + "/known.poly", BASE + "/known.poly.md5"),
        )

    def test_exceptions_bind_to_only_their_reviewed_catalog(self):
        payload = catalog([feature("a")])
        entry = {
            "entry_id": "a-2026-11-17",
            "region_id": "a",
            "catalog_sha256": source_revision(payload),
            "reason": "Provider documents unavailable clipping area",
            "evidence": BASE + "/a.html",
            "approved_by": "Atlas-maintainer",
        }

        def refreshed(body):
            opener = FixtureHTTP({("GET", INDEX): Reply(body=body)})
            return Client(opener=opener, overrides={"exceptions": [entry]}).catalog()[1][0]

        self.assertEqual(refreshed(payload)["poly_exception"], entry)
        self.assertEqual(refreshed(payload + b"\n")["poly_exception"], entry)
        self.assertNotIn("poly_exception", refreshed(catalog([feature("a", name="Changed")])))


class DiscoveryTests(unittest.TestCase):
    def test_retired_region_page_is_permanent_but_a_missing_page_is_retryable(self):
        for status, retryable in ((404, True), (410, False)):
            with self.subTest(status=status):
                opener = FixtureHTTP({("GET", "/asia/iran.html"): Reply(status)})
                client = Client(opener=opener)
                with self.assertRaises(ProviderError) as error:
                    client.discover_poly({"pbf_url": BASE + LATEST})
                self.assertEqual(error.exception.code, "page_missing")
                self.assertEqual(error.exception.retryable, retryable)

    def test_shared_page_reads_once_and_resolves_only_actual_links(self):
        html = b'<a href="iran.poly"><a href="/asia/iran.poly"><a href="iran.poly.md5">'
        opener = FixtureHTTP({("GET", "/asia/iran.html"): Reply(body=html)})
        client = Client(opener=opener)
        for id in ["iran", "same-page"]:
            self.assertEqual(
                client.discover_poly({"id": id, "pbf_url": BASE + LATEST}),
                (BASE + "/asia/iran.poly", BASE + "/asia/iran.poly.md5"),
            )
        self.assertEqual(len(opener.requests), 1)

    def test_ambiguous_page_requires_a_reviewed_mapping(self):
        html = b'<a href="iran.poly"><a href="other.poly">'
        client = Client(opener=FixtureHTTP({("GET", "/asia/iran.html"): Reply(body=html)}))
        with self.assertRaises(ProviderError) as error:
            client.discover_poly({"pbf_url": BASE + LATEST})
        self.assertEqual(error.exception.code, "poly_ambiguous")

    def test_outage_is_a_retryable_failure(self):
        client = Client(opener=FixtureHTTP({("GET", "/asia/iran.html"): Reply(503)}))
        with self.assertRaises(ProviderError) as error:
            client.discover_poly({"pbf_url": BASE + LATEST})
        self.assertTrue(error.exception.retryable)


class PinTests(unittest.TestCase):
    def test_resolves_latest_to_same_regions_dated_pbf_and_pins_exact_sidecar(self):
        md5 = (PBF_MD5 + "  iran-261117.osm.pbf\n").encode()
        opener = FixtureHTTP({
            ("HEAD", LATEST): Reply(307, Location="iran-261117.osm.pbf"),
            ("HEAD", DATED): Reply(Content_Length=len(PBF), ETag='"valid"', Last_Modified=MODIFIED),
            ("GET", DATED + ".md5"): Reply(body=md5),
        })
        client = Client(opener=opener)
        resolved = client.resolve_pbf(BASE + LATEST)
        self.assertEqual(resolved["url"], BASE + DATED)
        self.assertEqual(resolved["etag"], '"valid"')
        self.assertEqual(opener.requests[0].get_header("Cache-control"), "no-cache")
        self.assertEqual(opener.requests[1].get_header("Cache-control"), "no-cache")
        opener.routes[("HEAD", DATED)] = Reply(
            Content_Length=len(PBF), ETag='"valid"', Last_Modified=MODIFIED,
        )
        pin = client.pbf_pin(resolved["url"])
        self.assertEqual(pin, {
            "url": BASE + DATED, "length": len(PBF), "md5": PBF_MD5,
            "etag": '"valid"', "last_modified": MODIFIED,
        })

    def test_rejects_wrong_redirect_origin_port_path_and_file_type_before_requesting_it(self):
        for location in (
            "http://download.geofabrik.de" + DATED,
            "https://download.geofabrik.de:444" + DATED,
            "https://download.geofabrik.de.invalid" + DATED,
            "https://user:secret@download.geofabrik.de" + DATED,
            "https://osm-internal.download.geofabrik.de" + DATED,
            BASE + "/asia/%69ran-261117.osm.pbf",
            "https:iran-261117.osm.pbf",
            "///asia/iran-261117.osm.pbf",
            BASE + "/asia/../asia/iran-261117.osm.pbf",
            BASE + "/europe/iran-261117.osm.pbf",
            BASE + "/asia/iran-261131.osm.pbf",
            BASE + "/asia/monaco-261117.osm.pbf",
            BASE + "/asia/iran-261117.poly",
            BASE + DATED + "?token=secret",
        ):
            with self.subTest(location=location):
                opener = FixtureHTTP({("HEAD", LATEST): Reply(307, Location=location)})
                with self.assertRaises(ProviderError) as error:
                    Client(opener=opener).resolve_pbf(BASE + LATEST)
                self.assertNotIn("secret", str(error.exception))
                self.assertEqual(len(opener.requests), 1)

    def test_rejects_latest_response_that_does_not_pin_a_dated_name(self):
        opener = FixtureHTTP({("HEAD", LATEST): Reply(Content_Length=100)})
        with self.assertRaises(ProviderError):
            Client(opener=opener).resolve_pbf(BASE + LATEST)

    def test_missing_pbf_sidecar_is_retryable_without_repinning(self):
        opener = FixtureHTTP({
            ("HEAD", DATED): Reply(Content_Length=100),
            ("GET", DATED + ".md5"): Reply(404),
        })
        with self.assertRaises(ProviderError) as error:
            Client(opener=opener).pbf_pin(BASE + DATED)
        self.assertEqual(error.exception.code, "sidecar_missing")
        self.assertTrue(error.exception.retryable)

    def test_md5_requires_exactly_one_record_for_the_dated_name(self):
        for contents in (
            b"unparseable",
            (PBF_MD5 + "  iran-latest.osm.pbf\n").encode(),
            ((PBF_MD5 + "  iran-261117.osm.pbf\n") * 2).encode(),
        ):
            with self.subTest(contents=contents):
                opener = FixtureHTTP({
                    ("HEAD", DATED): Reply(Content_Length=100),
                    ("GET", DATED + ".md5"): Reply(body=contents),
                })
                with self.assertRaises(ProviderError) as error:
                    Client(opener=opener).pbf_pin(BASE + DATED)
                self.assertEqual(error.exception.code, "invalid_sidecar")

    def test_poly_pinning_allows_unavailable_advertised_sidecar(self):
        opener = FixtureHTTP({
            ("HEAD", "/asia/iran.poly"): Reply(Content_Length=len(POLY)),
            ("GET", "/asia/iran.poly.md5"): Reply(404),
        })
        pin = Client(opener=opener).poly_pin(BASE + "/asia/iran.poly", BASE + "/asia/iran.poly.md5")
        self.assertEqual(pin["md5"], "")
        self.assertEqual(pin["length"], len(POLY))


class DownloadTests(unittest.TestCase):
    def pbf_download(self, reply, *, pin=None, limit=1024):
        opener = FixtureHTTP({("GET", DATED): reply})
        stream = io.BytesIO()
        progress = []
        result = Client(opener=opener).download(
            pin or {"url": BASE + DATED, "length": len(PBF), "md5": PBF_MD5,
                    "etag": '"valid"', "last_modified": MODIFIED},
            "pbf", stream, limit, progress.append,
        )
        return result, stream.getvalue(), progress, opener.requests[0]

    def test_checks_body_and_reports_validators_progress_and_digests(self):
        reply = Reply(body=PBF, Content_Length=len(PBF), ETag='"valid"', Last_Modified=MODIFIED)
        result, body, progress, request = self.pbf_download(reply)
        self.assertEqual(body, PBF)
        self.assertEqual(progress, [len(PBF)])
        self.assertEqual(result["sha256"], hashlib.sha256(PBF).hexdigest())
        self.assertEqual(result["md5"], PBF_MD5)
        self.assertEqual(result["etag"], '"valid"')
        self.assertEqual(request.get_header("If-match"), '"valid"')
        self.assertEqual(request.get_header("Cache-control"), "no-cache")

    def test_reports_slow_progress_before_a_full_chunk_arrives(self):
        clock = [0]

        class SlowReply(Reply):
            def read1(self, size):
                clock[0] += 3
                return super().read1(min(size, 3))

        reply = SlowReply(body=PBF, ETag='"valid"', Last_Modified=MODIFIED)
        with patch("atlas_intake.provider.monotonic", side_effect=lambda: clock[0]):
            _, _, progress, _ = self.pbf_download(reply)
        self.assertEqual(progress[0], 3)
        self.assertEqual(progress[-1], len(PBF))

    def test_fails_on_validator_change_wrong_checksum_truncation_and_partial_status(self):
        cases = [
            (Reply(body=PBF, ETag='"changed"', Last_Modified=MODIFIED), "validator_changed"),
            (Reply(body=PBF, ETag='"valid"', Last_Modified="Tue, 17 Nov 2026 00:00:00 GMT"),
             "validator_changed"),
            (Reply(body=b"x" * len(PBF), ETag='"valid"', Last_Modified=MODIFIED),
             "checksum_mismatch"),
            (Reply(body=PBF[:-1], ETag='"valid"', Last_Modified=MODIFIED,
                   Content_Length=len(PBF)), "length_mismatch"),
            (Reply(206, body=PBF), "unexpected_status"),
            (Reply(410), "target_missing"),
        ]
        for reply, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(ProviderError) as error:
                    self.pbf_download(reply)
                self.assertEqual(error.exception.code, code)

    def test_known_oversized_pin_fails_without_a_network_request(self):
        with self.assertRaises(ProviderError) as error:
            Client(opener=FixtureHTTP({})).download(
                {"url": BASE + DATED, "length": 101}, "pbf", io.BytesIO(), 100, None,
            )
        self.assertEqual(error.exception.code, "size_limit")

    def test_weak_etag_is_compared_without_sending_an_if_match(self):
        result, _, _, request = self.pbf_download(
            Reply(body=PBF, ETag='W/"valid"'),
            pin={"url": BASE + DATED, "length": len(PBF), "md5": PBF_MD5,
                 "etag": 'W/"valid"', "last_modified": ""},
        )
        self.assertEqual(result["etag"], 'W/"valid"')
        self.assertIsNone(request.get_header("If-match"))

    def test_poly_without_known_length_requires_complete_format_and_obeys_stream_limit(self):
        path = "/asia/iran.poly"
        pin = {"url": BASE + path, "length": None, "md5": "", "etag": "", "last_modified": ""}
        for data, limit, code in (
            (POLY, 1024, None),
            (POLY, 16, "size_limit"),
            (POLY[:-4], 1024, "invalid_poly"),
            (POLY.replace(b"1 2\nEND", b"1 3\nEND"), 1024, "invalid_poly"),
            (POLY.replace(b"2 3", b"NaN 3"), 1024, "invalid_poly"),
            (b"<!DOCTYPE html><title>Not a polygon</title>", 1024, "invalid_poly"),
        ):
            opener = FixtureHTTP({("GET", path): Reply(body=data)})
            if code is None:
                result = Client(opener=opener).download(pin, "poly", io.BytesIO(), limit, None)
                self.assertEqual(result["sha256"], hashlib.sha256(POLY).hexdigest())
            else:
                with self.assertRaises(ProviderError) as error:
                    Client(opener=opener).download(pin, "poly", io.BytesIO(), limit, None)
                self.assertEqual(error.exception.code, code)
