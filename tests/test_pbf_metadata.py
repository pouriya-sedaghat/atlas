import io
import ssl
import unittest
from collections import deque
from urllib.error import URLError

from atlas_intake.provider import Client, ProviderError
from tests.test_provider import BASE, LATEST, DATED, PBF, PBF_MD5, MODIFIED, Reply


class HeadersOnly(Reply):
    def read(self, *args):
        raise AssertionError("Metadata must not read response content")

    read1 = read
    readinto = read
    readline = read
    readlines = read


class ScriptedHTTP:
    def __init__(self, steps):
        self.steps = deque(steps)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        expected_method, expected_path, result = self.steps.popleft()
        if (request.get_method(), request.full_url) != (expected_method, BASE + expected_path):
            raise AssertionError(f"Unexpected metadata request: {request.get_method()} {request.full_url}")
        if timeout != 12:
            raise AssertionError("Socket timeout changed")
        if isinstance(result, BaseException):
            raise result
        return result


def meta(**headers):
    return HeadersOnly(Content_Length=len(PBF), ETag='"valid"', Last_Modified=MODIFIED, **headers)


class MetadataClientTests(unittest.TestCase):
    def test_successful_head_does_not_issue_get(self):
        response = meta()
        http = ScriptedHTTP([("HEAD", DATED, response)])
        # Pin metadata is tested with its mandatory exact checksum, not an invented pin.
        http.steps.append(("GET", DATED + ".md5", Reply(body=(PBF_MD5 + "  iran-261117.osm.pbf\n").encode())))
        pin = Client(opener=http).pbf_pin(BASE + DATED)
        self.assertEqual(pin["md5"], PBF_MD5)
        self.assertTrue(response.closed)
        self.assertEqual([r.get_method() for r in http.requests], ["HEAD", "GET"])

    def test_typed_timeout_and_method_status_switch_once_without_body_reads(self):
        for error in (TimeoutError("untrusted raw detail"), URLError(TimeoutError()),
                      URLError(URLError(TimeoutError())), HeadersOnly(405), HeadersOnly(501)):
            with self.subTest(error=type(error).__name__):
                response = meta()
                http = ScriptedHTTP([("HEAD", LATEST, error), ("GET", LATEST, HeadersOnly(307, Location=DATED)),
                                     ("GET", DATED, response)])
                result = Client(opener=http).resolve_pbf(BASE + LATEST)
                self.assertEqual(result["url"], BASE + DATED)
                self.assertEqual(result["length"], len(PBF))
                self.assertTrue(response.closed)
                for request in http.requests:
                    self.assertEqual(request.get_header("Cache-control"), "no-cache")
                    self.assertEqual(request.get_header("Accept-encoding"), "identity")
                    self.assertFalse(request.has_header("Range"))

    def test_fallback_continues_at_observed_dated_target_not_latest(self):
        response = meta()
        http = ScriptedHTTP([("HEAD", LATEST, HeadersOnly(307, Location=DATED)),
                             ("HEAD", DATED, TimeoutError()), ("GET", DATED, response)])
        self.assertEqual(Client(opener=http).resolve_pbf(BASE + LATEST)["url"], BASE + DATED)
        self.assertEqual([r.full_url for r in http.requests].count(BASE + LATEST), 1)

    def test_dated_fallback_cannot_select_another_date(self):
        response = HeadersOnly(307, Location="/asia/iran-261118.osm.pbf")
        http = ScriptedHTTP([("HEAD", LATEST, HeadersOnly(307, Location=DATED)),
                             ("HEAD", DATED, TimeoutError()), ("GET", DATED, response)])
        with self.assertRaises(ProviderError) as error:
            Client(opener=http).resolve_pbf(BASE + LATEST)
        self.assertEqual(error.exception.code, "unexpected_redirect")
        self.assertTrue(response.closed)
        self.assertEqual(len(http.requests), 3)

    def test_excluded_failures_do_not_trigger_get(self):
        errors = [URLError("timed out"), ConnectionResetError(), ssl.SSLCertVerificationError(),
                  URLError(ssl.SSLCertVerificationError())]
        errors += [HeadersOnly(status) for status in [401, 403, 404, 408, 410, 412, 429, 500, 504]]
        for response in errors:
            with self.subTest(response=type(response).__name__, status=getattr(response, "status", None)):
                http = ScriptedHTTP([("HEAD", LATEST, response)])
                with self.assertRaises(ProviderError):
                    Client(opener=http).resolve_pbf(BASE + LATEST)
                self.assertEqual(len(http.requests), 1)

    def test_failed_get_never_falls_back_again(self):
        http = ScriptedHTTP([("HEAD", LATEST, TimeoutError()), ("GET", LATEST, TimeoutError())])
        with self.assertRaises(ProviderError) as error:
            Client(opener=http).resolve_pbf(BASE + LATEST)
        self.assertEqual(error.exception.code, "network_failure")
        self.assertEqual(len(http.requests), 2)
        self.assertEqual(error.exception.context["method"], "GET")
        self.assertEqual(error.exception.context["reason"], "timeout")

    def test_shared_four_redirect_budget_survives_method_switch(self):
        http = ScriptedHTTP([("HEAD", LATEST, HeadersOnly(307, Location=DATED))] +
                             [("HEAD", DATED, HeadersOnly(307, Location=DATED)) for _ in range(3)] +
                             [("HEAD", DATED, TimeoutError()), ("GET", DATED, HeadersOnly(307, Location=DATED))])
        with self.assertRaises(ProviderError) as error:
            Client(opener=http).resolve_pbf(BASE + LATEST)
        self.assertEqual(error.exception.code, "redirect_limit")
        self.assertEqual(len(http.requests), 6)

    def test_rejected_metadata_gets_close_and_do_not_read(self):
        cases = [HeadersOnly(206, Content_Length=1), HeadersOnly(), HeadersOnly(Content_Length=0),
                 HeadersOnly(Content_Length="x"), HeadersOnly(Content_Length=2, Transfer_Encoding="chunked"),
                 HeadersOnly(Content_Length=2, Content_Encoding="gzip"), HeadersOnly(Content_Length=2, ETag="invalid")]
        duplicate = HeadersOnly(Content_Length=2)
        duplicate.headers.add_header("Content-Length", "3")
        cases.append(duplicate)
        for response in cases:
            with self.subTest(headers=list(response.headers.items()), status=response.status):
                http = ScriptedHTTP([("HEAD", LATEST, TimeoutError()), ("GET", LATEST, HeadersOnly(307, Location=DATED)),
                                     ("GET", DATED, response)])
                with self.assertRaises(ProviderError):
                    Client(opener=http).resolve_pbf(BASE + LATEST)
                self.assertTrue(response.closed)

    def test_get_redirect_allowlist_rejects_before_contact(self):
        for target in ["http://download.geofabrik.de"+DATED, "https://evil.invalid"+DATED,
                       BASE+"/europe/iran-261117.osm.pbf", BASE+"/asia/other-261117.osm.pbf",
                       BASE+"/asia/iran.poly", BASE+"/asia/%69ran-261117.osm.pbf",
                       BASE+DATED+"?token=secret"]:
            with self.subTest(target=target):
                http = ScriptedHTTP([("HEAD", LATEST, TimeoutError()),
                                     ("GET", LATEST, HeadersOnly(307, Location=target))])
                with self.assertRaises(ProviderError):
                    Client(opener=http).resolve_pbf(BASE+LATEST)
                self.assertEqual(len(http.requests), 2)

    def test_pin_fallback_and_mandatory_sidecar_are_observed_separately(self):
        events = []
        response = meta()
        http = ScriptedHTTP([("HEAD", DATED, TimeoutError()), ("GET", DATED, response),
                             ("GET", DATED+".md5", Reply(body=(PBF_MD5+"  iran-261117.osm.pbf\n").encode()))])
        pin = Client(opener=http).pbf_pin(BASE+DATED, observer=events.append)
        self.assertEqual(pin["md5"], PBF_MD5)
        self.assertTrue(response.closed)
        self.assertTrue(any(e.get("stage") == "sidecar" for e in events))
        self.assertTrue(any(e.get("trigger") == "timeout" and e["method"] == "GET" for e in events))
        self.assertFalse(any("untrusted raw" in str(e) for e in events))

    def test_observer_stops_work_before_next_network_step(self):
        class LostClaim(Exception):
            pass
        events=[]
        def observe(event):
            events.append(event)
            if event["event"] == "request_end":
                raise LostClaim
        response = meta()
        http = ScriptedHTTP([("HEAD", DATED, response)])
        with self.assertRaises(LostClaim):
            Client(opener=http).pbf_pin(BASE+DATED, observer=observe)
        self.assertTrue(response.closed)
        self.assertEqual(len(http.requests), 1)

    def test_wrapping_is_bounded_and_message_text_is_not_timeout_evidence(self):
        wrapped=TimeoutError()
        for _ in range(6):
            wrapped=URLError(wrapped)
        cyclic=URLError("placeholder")
        cyclic.reason=cyclic
        for error in [wrapped,cyclic,URLError("The read operation timed out")]:
            http=ScriptedHTTP([("HEAD",LATEST,error)])
            with self.assertRaises(ProviderError):
                Client(opener=http).resolve_pbf(BASE+LATEST)
            self.assertEqual(len(http.requests),1)

    def test_weak_validator_is_retained_by_metadata_fallback(self):
        response=HeadersOnly(Content_Length=len(PBF),ETag='W/"weak"',Last_Modified=MODIFIED)
        http=ScriptedHTTP([("HEAD",LATEST,TimeoutError()),("GET",LATEST,HeadersOnly(307,Location=DATED)),
                          ("GET",DATED,response)])
        metadata=Client(opener=http).resolve_pbf(BASE+LATEST)
        self.assertEqual(metadata["etag"],'W/"weak"')
        self.assertEqual(metadata["last_modified"],MODIFIED)
        self.assertTrue(response.closed)

    def test_observed_dated_target_cannot_be_erased_by_redirect_to_latest(self):
        other="/asia/iran-261118.osm.pbf"
        http=ScriptedHTTP([("HEAD",LATEST,HeadersOnly(307,Location=DATED)),
                          ("HEAD",DATED,HeadersOnly(307,Location=LATEST)),
                          ("HEAD",LATEST,TimeoutError()),("GET",LATEST,HeadersOnly(307,Location=other)),
                          ("GET",other,meta())])
        with self.assertRaises(ProviderError) as error:
            Client(opener=http).resolve_pbf(BASE+LATEST)
        self.assertEqual(error.exception.code,"unexpected_redirect")
        self.assertEqual(len(http.requests),2)

    def test_200_metadata_get_with_content_range_is_not_full_representation(self):
        response=HeadersOnly(Content_Length=1,Content_Range="bytes 0-0/5000")
        http=ScriptedHTTP([("HEAD",LATEST,TimeoutError()),("GET",LATEST,HeadersOnly(307,Location=DATED)),
                          ("GET",DATED,response)])
        with self.assertRaises(ProviderError) as error:
            Client(opener=http).resolve_pbf(BASE+LATEST)
        self.assertEqual(error.exception.code,"invalid_metadata")
        self.assertTrue(response.closed)

    def test_checksum_read_retains_typed_reason_without_a_method_fallback(self):
        for failure,reason in [(TimeoutError("sensitive detail"),"timeout"),
                               (URLError(TimeoutError("sensitive detail")),"timeout"),
                               (ssl.SSLCertVerificationError("sensitive detail"),"tls_error")]:
            with self.subTest(reason=reason):
                class Interrupted(Reply):
                    def read1(self,size):raise failure
                events=[]
                response=Interrupted(body=b"")
                http=ScriptedHTTP([("HEAD",DATED,meta()),("GET",DATED+".md5",response)])
                with self.assertRaises(ProviderError) as error:
                    Client(opener=http).pbf_pin(BASE+DATED,observer=events.append)
                self.assertEqual(error.exception.code,"network_failure")
                self.assertEqual(len(http.requests),2)
                self.assertTrue(response.closed)
                outcomes=[e for e in events if e["event"]=="request_end" and e["stage"]=="sidecar"]
                self.assertEqual(outcomes[-1]["reason"],reason)
                self.assertNotIn("sensitive detail",str(events))
