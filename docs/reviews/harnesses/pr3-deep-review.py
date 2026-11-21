"""Read-only PR #3 review checks. Run against the exact reviewed source snapshot."""
import argparse
import ast
import hashlib
import json
import ssl
import sys
import unittest
from http.client import BadStatusLine, RemoteDisconnected
from pathlib import Path
from urllib.error import URLError

COMMIT = "1d40f0479faae127eff0f3c40f129b37cc2fedd4"
EXPECTED = {
    "atlas_intake/provider.py": "ed1b6ffa90f5976fb2e6bca7274cc203c6c320d4",
    "atlas_intake/metadata.py": "0a459217176a1f51a16187fec1191f746374712a",
    "atlas_intake/worker.py": "9f1e86cf6855e1970c285b2763db8fe729b78baf",
    "atlas_intake/catalog.py": "75136d0998b9632c909fb20006d8f87e19e84b9e",
    "tests/test_provider.py": "05ba2752741bd9ad5f4337c9783ec60cb85e7c4c",
    "tests/test_pbf_metadata.py": "6532ef941705367e6f248c33ffd32c0d89afdb73",
    "tests/test_explicit_poly.py": "d31014887a4a1aefc44943b77edf2a3ed92d41c8",
    "tests/test_metadata_worker.py": "6a2fb87931cfbb3af682f2cc93a80e568cbaa523",
    "tests/test_verification_worker.py": "3db6f1d6bf3b8788d5a9e1d82f60988fafc4c1dd"
}

def verify_source(root):
    for name, expected in EXPECTED.items():
        body = (root / name).read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()
        if actual != expected:
            raise RuntimeError("Source differs from reviewed candidate: " + name)

def standard_tests(root):
    from atlas_intake.provider import Client, ProviderError
    from tests.test_provider import BASE, INDEX, FixtureHTTP, Reply, catalog, feature, source_revision
    path = root / "tests/test_explicit_poly.py"
    parsed = ast.parse(path.read_text())
    selected = [
        node for node in parsed.body
        if isinstance(node, (ast.Assign, ast.FunctionDef))
        or isinstance(node, ast.ClassDef) and node.name == "ExplicitProviderTests"
    ]
    scope = dict(globals(), Client=Client, ProviderError=ProviderError, BASE=BASE, INDEX=INDEX,
                 FixtureHTTP=FixtureHTTP, Reply=Reply, catalog=catalog, feature=feature,
                 source_revision=source_revision)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), scope)
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite([
        loader.loadTestsFromName("tests.test_provider"),
        loader.loadTestsFromName("tests.test_pbf_metadata"),
        loader.loadTestsFromTestCase(scope["ExplicitProviderTests"]),
    ])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if not result.wasSuccessful():
        raise RuntimeError("Candidate pure tests failed")
    return result.testsRun

def protocol_scenarios():
    from atlas_intake.provider import Client, ProviderError
    from tests.test_pbf_metadata import ScriptedHTTP, HeadersOnly, meta
    from tests.test_provider import BASE, LATEST, DATED, PBF_MD5, Reply
    count = 0
    for phase in ("resolve", "pin"):
        triggers = []
        for depth in range(7):
            error = TimeoutError("untrusted")
            for _ in range(depth):
                error = URLError(error)
            triggers.append((error, depth <= 3))
        for error in (URLError("TimeoutError: timed out"), ssl.SSLError("timed out"),
                      URLError(ssl.SSLCertVerificationError()), ConnectionResetError(),
                      BadStatusLine("timeout"), RemoteDisconnected("timeout")):
            triggers.append((error, False))
        for status in (201, 204, 206, 304, 400, 401, 403, 404, 405, 408,
                       410, 412, 425, 429, 500, 501, 502, 503, 504, 599):
            triggers.append((HeadersOnly(status), status in (405, 501)))
        for trigger, allowed in triggers:
            responses = []
            steps = []
            if phase == "resolve":
                response = HeadersOnly(307, Location=DATED)
                responses.append(response)
                steps.append(("HEAD", LATEST, response))
            steps.append(("HEAD", DATED, trigger))
            if hasattr(trigger, "closed"):
                responses.append(trigger)
            if allowed:
                response = meta()
                responses.append(response)
                steps.append(("GET", DATED, response))
                if phase == "pin":
                    steps.append(("GET", DATED + ".md5", Reply(
                        body=(PBF_MD5 + "  iran-261117.osm.pbf\n").encode())))
            http = ScriptedHTTP(steps)
            events = []
            client = Client(opener=http)
            error = None
            try:
                result = (client.resolve_pbf(BASE + LATEST, observer=events.append) if phase == "resolve"
                          else client.pbf_pin(BASE + DATED, observer=events.append))
            except ProviderError as caught:
                error = caught
            assert (error is None) == allowed, (phase, trigger, error)
            assert not http.steps, (phase, trigger, "unexpected request sequence")
            assert all(response.closed for response in responses), (phase, "unclosed response")
            if allowed:
                assert result["url"] == BASE + DATED
            assert not any("untrusted" in str(event) for event in events)
            count += 1

    for phase in ("resolve", "pin"):
        initial = 1 if phase == "resolve" else 0
        for before in range(5 - initial):
            for after in range(7):
                steps = []
                if initial:
                    steps.append(("HEAD", LATEST, HeadersOnly(307, Location=DATED)))
                steps.extend(("HEAD", DATED, HeadersOnly(307, Location=DATED)) for _ in range(before))
                steps.append(("HEAD", DATED, TimeoutError()))
                steps.extend(("GET", DATED, HeadersOnly(307, Location=DATED)) for _ in range(after))
                steps.append(("GET", DATED, meta()))
                success = initial + before + after <= 4
                if phase == "pin" and success:
                    steps.append(("GET", DATED + ".md5", Reply(
                        body=(PBF_MD5 + "  iran-261117.osm.pbf\n").encode())))
                http = ScriptedHTTP(steps)
                client = Client(opener=http)
                error = None
                try:
                    if phase == "resolve":
                        client.resolve_pbf(BASE + LATEST)
                    else:
                        client.pbf_pin(BASE + DATED)
                except ProviderError as caught:
                    error = caught
                assert (error is None) == success, (phase, before, after, error)
                if error:
                    assert error.code == "redirect_limit"
                metadata_opens = [r for r in http.requests if not r.full_url.endswith(".md5")]
                assert len(metadata_opens) <= 6
                assert sum(r.full_url == BASE + LATEST for r in metadata_opens) == initial
                count += 1
    return count

class StopReview(Exception):
    pass

def observer_scenarios():
    from atlas_intake.provider import Client
    from tests.test_pbf_metadata import ScriptedHTTP, HeadersOnly, meta
    from tests.test_provider import BASE, LATEST, DATED, PBF_MD5, Reply

    def exercise(stop_at=None, error_type=StopReview):
        steps = [
            ("HEAD", LATEST, HeadersOnly(307, Location=DATED)),
            ("HEAD", DATED, TimeoutError()), ("GET", DATED, meta()),
            ("HEAD", DATED, TimeoutError()), ("GET", DATED, meta()),
            ("GET", DATED + ".md5", Reply(body=(PBF_MD5 + "  iran-261117.osm.pbf\n").encode())),
        ]
        http = ScriptedHTTP(steps)
        returned = []
        original = http.open
        def open_response(request, timeout):
            response = original(request, timeout)
            returned.append(response)
            return response
        http.open = open_response
        events = []
        stopped_at = []
        def observe(event):
            events.append(event)
            if len(events) == stop_at:
                stopped_at.append(len(http.requests))
                raise error_type("observer stopped this operation")
        client = Client(opener=http)
        stopped = False
        try:
            initial = client.resolve_pbf(BASE + LATEST, observer=observe)
            client.pbf_pin(initial["url"], observer=observe)
        except error_type:
            stopped = True
        if stop_at is not None:
            assert stopped, (stop_at, error_type)
            assert len(http.requests) == stopped_at[0], (stop_at, "I/O continued after observer failure")
        assert all(response.closed for response in returned), (stop_at, "unclosed response")
        return len(events)

    checkpoints = exercise()
    count = 0
    for error_type in (StopReview, TimeoutError, OSError):
        for event in range(1, checkpoints + 1):
            exercise(event, error_type)
            count += 1
    return count, checkpoints

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    args = parser.parse_args()
    root = args.source_root.resolve(strict=True)
    sys.dont_write_bytecode = True
    verify_source(root)
    sys.path.insert(0, str(root))
    tests = standard_tests(root)
    protocol = protocol_scenarios()
    observers, checkpoints = observer_scenarios()
    print(json.dumps({
        "commit": COMMIT, "verified_source_files": len(EXPECTED),
        "pure_tests_passed": tests, "protocol_scenarios_passed": protocol,
        "observer_scenarios_passed": observers, "observer_checkpoints": checkpoints,
        "postgresql_tests_rerun": False, "network_used": False,
    }, sort_keys=True))

if __name__ == "__main__":
    main()
