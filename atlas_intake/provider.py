"""Read-only access to Geofabrik's public catalog and extract files."""

from concurrent.futures import Future
from contextlib import contextmanager
from datetime import date
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
from http.client import HTTPException, IncompleteRead
import json
import math
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


HOST = "download.geofabrik.de"
BASE_URL = f"https://{HOST}"
INDEX_PATH = "/index-v1-nogeom.json"
LATEST_SUFFIX = "-latest.osm.pbf"
OVERRIDES_PATH = Path(__file__).with_name("geofabrik_overrides.json")
PUBLIC_PATH = re.compile(r"/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*")
DATED_PBF = re.compile(r"(.+)-([0-9]{6})\.osm\.pbf")
ETAG = re.compile(r'(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"')
CHUNK_SIZE = 2**20
MAX_REGION_ID_LENGTH = 200  # Matches Artifact.region_id.
MAX_REDIRECTS = 4
SOCKET_TIMEOUT = 12
LOOKUP_LIMITS = {"catalog": 4 * CHUNK_SIZE, "page": 2 * CHUNK_SIZE, "sidecar": 4096}


class ProviderError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _dated_stem(path):
    match = DATED_PBF.fullmatch(path)
    if match:
        stamp = match[2]
        try:
            date(2000 + int(stamp[:2]), int(stamp[2:4]), int(stamp[4:]))
        except ValueError:
            return None
        return match[1]
    return None


def _url(value, kind):
    error = ProviderError("disallowed_url", "Geofabrik URL violated the public source allowlist.")
    if (
        not isinstance(value, str)
        or not value.isascii()
        or any(ord(char) <= 32 or ord(char) >= 127 for char in value)
        or any(char in value for char in "\\%?#")
    ):
        raise error
    try:
        parts = urlsplit(value)
    except ValueError:
        raise error from None
    if parts.scheme != "https" or parts.netloc.lower() not in {HOST, f"{HOST}:443"}:
        raise error
    path = parts.path
    if kind == "updates" and path.endswith("/"):
        path = path[:-1]
    if not PUBLIC_PATH.fullmatch(path):
        raise error
    valid = {
        "catalog": lambda: path == INDEX_PATH,
        "page": lambda: path.endswith(".html"),
        "latest": lambda: path.endswith(LATEST_SUFFIX),
        "pbf": lambda: path.endswith(LATEST_SUFFIX) or _dated_stem(path) is not None,
        "dated": lambda: _dated_stem(path) is not None,
        "updates": lambda: path.endswith("-updates") or (
            path.endswith("/updates") and path.count("/") >= 2
        ),
        "poly": lambda: path.endswith(".poly"),
        "sidecar": lambda: path.endswith(".poly.md5") or (
            path.endswith(".md5") and _dated_stem(path[:-4]) is not None
        ),
    }
    if not valid[kind]():
        raise error
    return BASE_URL + path


def _relative_url(base, reference, kind):
    if not reference or any(
        ord(char) <= 32 or ord(char) >= 127 or char in "\\%?#" for char in reference
    ):
        raise ProviderError("disallowed_url", "Geofabrik link violated the public source allowlist.")
    try:
        parts = urlsplit(reference)
        if (
            reference.startswith("///")
            or (parts.scheme and not parts.netloc)
            or "//" in parts.path
            or any(segment in {".", ".."} for segment in parts.path.split("/"))
        ):
            raise ValueError
        target = urljoin(base, reference)
    except ValueError:
        raise ProviderError("disallowed_url", "Geofabrik link violated the public source allowlist.") from None
    return _url(target, kind)


class _NoRedirect(HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        # Leave every Location untouched for the caller's allowlist check.
        return None

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


class _PolygonLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = set()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for attribute, value in attrs:
                if attribute == "href" and value:
                    path = value.split("?", 1)[0].split("#", 1)[0]
                    if path.endswith((".poly", ".poly.md5")):
                        self.hrefs.add(value)


def _header(response, name):
    values = response.headers.get_all(name, [])
    if len(values) > 1:
        raise ProviderError("invalid_metadata", "Geofabrik returned conflicting HTTP metadata.")
    return values[0].strip() if values else ""


def _length(response):
    value = _header(response, "Content-Length")
    if not value:
        return None
    if not re.fullmatch(r"[0-9]{1,19}", value) or int(value) > 2**63 - 1:
        raise ProviderError("invalid_metadata", "Geofabrik returned an invalid byte length.")
    if _header(response, "Transfer-Encoding"):
        raise ProviderError("invalid_metadata", "Geofabrik returned conflicting length metadata.")
    return int(value)


def _metadata(response, url):
    etag = _header(response, "ETag")
    if etag and (len(etag) > 255 or not ETAG.fullmatch(etag)):
        raise ProviderError("invalid_metadata", "Geofabrik returned an invalid ETag.")
    modified = _header(response, "Last-Modified")
    if modified:
        try:
            if len(modified) > 80 or not modified.isascii() or not modified.isprintable():
                raise ValueError
            parsedate_to_datetime(modified)
        except (ValueError, OverflowError):
            raise ProviderError("invalid_metadata", "Geofabrik returned an invalid Last-Modified.") from None
    return {"url": url, "length": _length(response), "etag": etag, "last_modified": modified}


def _read(response, amount, deadline):
    if monotonic() >= deadline:
        raise ProviderError("timeout", "Geofabrik response exceeded the time limit.", retryable=True)
    try:
        data = response.read1(amount)
    except IncompleteRead:
        raise ProviderError("length_mismatch", "Geofabrik response ended early.", retryable=True) from None
    except (URLError, OSError, HTTPException):
        raise ProviderError("network_failure", "Geofabrik response was interrupted.", retryable=True) from None
    if monotonic() >= deadline:
        raise ProviderError("timeout", "Geofabrik response exceeded the time limit.", retryable=True)
    return data


def _local_segment(region_id):
    encoded = "".join(
        chr(byte) if byte in b"abcdefghijklmnopqrstuvwxyz0123456789_-" else f"~{byte:02x}"
        for byte in region_id.encode("utf-8")
    )
    if len(encoded) > 200:
        return "~sha256-" + hashlib.sha256(region_id.encode("utf-8")).hexdigest()
    return encoded


def _catalog_rows(body):
    invalid = ProviderError("invalid_catalog", "Geofabrik returned an invalid region catalog.")
    try:
        catalog = json.loads(body)
    except (UnicodeError, ValueError, RecursionError):
        raise invalid from None
    if not isinstance(catalog, dict) or catalog.get("type") != "FeatureCollection":
        raise invalid
    features = catalog.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= 10000:
        raise invalid

    regions = {}
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise invalid
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise invalid
        region_id, name, parent = (properties.get(key) for key in ("id", "name", "parent"))
        if (
            not isinstance(region_id, str)
            or not 1 <= len(region_id) <= MAX_REGION_ID_LENGTH
            or not region_id.isprintable()
            or not region_id.strip()
            or region_id in regions
            or not isinstance(name, str)
            or not 1 <= len(name) <= 255
            or not name.isprintable()
            or not name.strip()
            or (parent is not None and not isinstance(parent, str))
        ):
            raise invalid
        urls = properties.get("urls", {})
        if not isinstance(urls, dict):
            raise invalid
        pbf_url = urls.get("pbf")
        updates_url = urls.get("updates")
        regions[region_id] = {
            "id": region_id,
            "name": name,
            "parent": parent,
            "pbf_url": "" if pbf_url in (None, "") else _url(pbf_url, "latest"),
            "updates_url": "" if updates_url in (None, "") else _url(updates_url, "updates"),
        }

    paths = set()
    for region in regions.values():
        chain = {}
        ancestor = region
        while ancestor is not None and "path" not in ancestor:
            ancestor_id = ancestor["id"]
            if ancestor_id in chain:
                raise invalid
            chain[ancestor_id] = ancestor
            parent = ancestor["parent"]
            if parent is not None and parent not in regions:
                raise invalid
            ancestor = regions.get(parent)
        path = ancestor["path"] if ancestor is not None else ""
        for member in reversed(chain.values()):
            segment = _local_segment(member["id"])
            path = f"{path}/{segment}" if path else segment
            if len(path) > 2048 or path in paths:
                raise invalid
            member["path"] = path
            paths.add(path)
    return regions


def _apply_overrides(regions, overrides, source_digest):
    invalid = ProviderError("invalid_overrides", "The reviewed Geofabrik overrides are invalid.")
    if not isinstance(overrides, dict) or overrides.keys() - {"mappings", "exceptions"}:
        raise invalid
    applied = {"mappings": [], "exceptions": []}
    for group, key in (("mappings", "poly_mapping"), ("exceptions", "poly_exception")):
        entries = overrides.get(group, [])
        if not isinstance(entries, list):
            raise invalid
        entry_ids = set()
        for entry in entries:
            fields = ["entry_id", "region_id", "catalog_sha256"]
            if group == "mappings":
                fields.append("page_url")
            else:
                fields.extend(["reason", "evidence", "approved_by"])
            if not isinstance(entry, dict) or any(
                not isinstance(entry.get(field), str) or not entry[field].strip() for field in fields
            ):
                raise invalid
            if entry["entry_id"] in entry_ids or not re.fullmatch(r"[0-9a-f]{64}", entry["catalog_sha256"]):
                raise invalid
            entry_ids.add(entry["entry_id"])
            if entry["catalog_sha256"] != source_digest:
                continue
            region = regions.get(entry["region_id"])
            if region is None or key in region:
                raise invalid
            if group == "mappings":
                _url(entry["page_url"], "page")
                if "poly_url" in entry:
                    _url(entry["poly_url"], "poly")
                if "sidecar_url" in entry:
                    _url(entry["sidecar_url"], "sidecar")
            region[key] = entry.copy()
            applied[group].append(entry)
    return applied


def _validate_poly(content):
    invalid = ProviderError("invalid_poly", "Geofabrik POLY is malformed or incomplete.", retryable=True)
    try:
        lines = [line.strip() for line in content.decode("utf-8").splitlines() if line.strip()]
    except UnicodeError:
        raise invalid from None
    if len(lines) < 8 or lines[-1] != "END" or not lines[0].isprintable():
        raise invalid
    in_ring = False
    has_outer = False
    for line in lines[1:-1]:
        if not in_ring:
            if line in {"END", "!"} or not line.isprintable():
                raise invalid
            has_outer |= not line.startswith("!")
            count = 0
            in_ring = True
        elif line == "END":
            if count < 4 or first != point:
                raise invalid
            in_ring = False
        else:
            try:
                x, y = line.split()
                point = float(x), float(y)
            except ValueError:
                raise invalid from None
            if not all(math.isfinite(value) for value in point) or "_" in line:
                raise invalid
            if count == 0:
                first = point
            count += 1
    if in_ring or not has_outer:
        raise invalid


class Client:
    def __init__(self, *, opener=None, overrides=None):
        self.opener = opener if opener is not None else build_opener(ProxyHandler({}), _NoRedirect())
        self.overrides = overrides
        self._revision = None
        self._pages = {}
        self._page_lock = Lock()

    @contextmanager
    def _request(self, url, kind, *, method="GET", headers=None, redirect_allowed=None, missing="target_missing"):
        url = _url(url, kind)
        request_headers = {"User-Agent": "Atlas-Geofabrik-Intake/1.0", "Accept-Encoding": "identity"}
        if method == "HEAD" or kind in {"catalog", "sidecar"}:
            request_headers["Cache-Control"] = "no-cache"
        request_headers.update(headers or {})
        for hop in range(MAX_REDIRECTS + 1):
            request = Request(url, headers=request_headers, method=method)
            try:
                response = self.opener.open(request, timeout=SOCKET_TIMEOUT)
            except HTTPError as error:
                response = error
            except (URLError, OSError, HTTPException):
                raise ProviderError("network_failure", "Geofabrik could not be reached.", retryable=True) from None
            with response:
                status = response.status
                if status in {301, 302, 303, 307, 308}:
                    if hop == MAX_REDIRECTS:
                        raise ProviderError("redirect_limit", "Geofabrik redirect limit exceeded.")
                    target = _relative_url(url, _header(response, "Location"), kind)
                    allowed = redirect_allowed(target) if redirect_allowed else target == url
                    if not allowed:
                        raise ProviderError("unexpected_redirect", "Geofabrik redirected to a different source artifact.")
                    url = target
                    continue
                if status in {404, 410}:
                    message = {
                        "sidecar_missing": "Geofabrik did not provide the exact checksum sidecar.",
                        "target_missing": "The frozen Geofabrik target is no longer available.",
                        "page_missing": "The Geofabrik region page is unavailable.",
                        "catalog_missing": "The Geofabrik catalog is unavailable.",
                    }[missing]
                    retired_page = missing == "page_missing" and status == 410
                    raise ProviderError(missing, message, retryable=missing != "target_missing" and not retired_page)
                if status == 412:
                    raise ProviderError("validator_changed", "Geofabrik rejected the pinned HTTP validator.")
                if status != 200:
                    retryable = status in {408, 425, 429} or 500 <= status <= 599
                    raise ProviderError(
                        "unexpected_status", f"Geofabrik returned HTTP {status}.", retryable=retryable,
                    )
                if _header(response, "Content-Encoding").lower() not in {"", "identity"}:
                    raise ProviderError("invalid_metadata", "Geofabrik returned an unexpected content encoding.")
                yield response, url
                return

    def _payload(self, url, kind, missing):
        limit = LOOKUP_LIMITS[kind]
        with self._request(url, kind, missing=missing) as (response, resolved):
            length = _length(response)
            if length is not None and length > limit:
                raise ProviderError("size_limit", "Geofabrik lookup exceeds the byte limit.")
            data = bytearray()
            deadline = monotonic() + 25
            while block := _read(response, min(CHUNK_SIZE, limit + 1 - len(data)), deadline):
                data.extend(block)
                if len(data) > limit:
                    raise ProviderError("size_limit", "Geofabrik lookup exceeds the byte limit.")
            if length is not None and length != len(data):
                raise ProviderError("length_mismatch", "Geofabrik lookup has an unexpected byte length.", retryable=True)
            return data, resolved

    def catalog(self):
        body, _ = self._payload(BASE_URL + INDEX_PATH, "catalog", "catalog_missing")
        regions = _catalog_rows(body)
        fields = ("id", "name", "parent", "pbf_url", "updates_url")
        ordered = [{key: regions[region_id][key] for key in fields} for region_id in sorted(regions)]
        canonical = json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode()
        source_digest = hashlib.sha256(canonical).hexdigest()
        overrides = self.overrides
        if overrides is None:
            try:
                overrides = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, ValueError, RecursionError):
                raise ProviderError("invalid_overrides", "The reviewed Geofabrik overrides could not be read.") from None
        applied = _apply_overrides(regions, overrides, source_digest)
        revision = source_digest
        if any(applied.values()):
            # A reviewed intent change needs a new cache and revision even if the provider feed is unchanged.
            reviewed = json.dumps(applied, sort_keys=True, separators=(",", ":")).encode()
            revision = hashlib.sha256(canonical + b"\0" + reviewed).hexdigest()
        with self._page_lock:
            if revision != self._revision:
                self._pages.clear()
                self._revision = revision
        return revision, list(regions.values())

    def _page_links(self, page_url):
        with self._page_lock:
            lookup = self._pages.get(page_url)
            first = lookup is None
            if first:
                lookup = Future()
                self._pages[page_url] = lookup
        if first:
            try:
                html, resolved = self._payload(page_url, "page", "page_missing")
                parser = _PolygonLinks()
                parser.feed(html.decode("utf-8", errors="replace"))
                parser.close()
                links = {(_relative_url(resolved, href, "sidecar" if href.endswith(".md5") else "poly"))
                         for href in parser.hrefs}
                lookup.set_result(links)
            except Exception as error:
                # Do not cache temporary errors as proof that a boundary is unavailable.
                lookup.set_exception(error)
                with self._page_lock:
                    if self._pages.get(page_url) is lookup:
                        del self._pages[page_url]
        return lookup.result()

    def discover_poly(self, region):
        mapping = region.get("poly_mapping", {})
        if mapping:
            page = _url(mapping["page_url"], "page")
        elif region.get("pbf_url"):
            pbf = _url(region["pbf_url"], "latest")
            page = _url(pbf.removesuffix(LATEST_SUFFIX) + ".html", "page")
        else:
            raise ProviderError("poly_unresolved", "Geofabrik region has no public page mapping.")

        links = self._page_links(page)
        candidates = {link for link in links if link.endswith(".poly")}
        configured = mapping.get("poly_url")
        if configured:
            poly = _url(configured, "poly")
            if poly not in candidates:
                raise ProviderError("poly_unresolved", "The reviewed POLY URL is no longer listed on its Geofabrik page.")
        elif len(candidates) == 1:
            poly, = candidates
        elif not candidates:
            raise ProviderError("poly_unresolved", "The Geofabrik region page does not list a POLY link.")
        else:
            raise ProviderError("poly_ambiguous", "The Geofabrik region page lists multiple POLY candidates.")
        sidecar = mapping.get("sidecar_url") or (poly + ".md5" if poly + ".md5" in links else "")
        if sidecar:
            sidecar = self._poly_sidecar(poly, sidecar)
        return poly, sidecar

    def resolve_pbf(self, url):
        url = _url(url, "latest")
        stem = url.removeprefix(BASE_URL).removesuffix(LATEST_SUFFIX)

        def matches_region(target):
            return target == url or _dated_stem(target.removeprefix(BASE_URL)) == stem

        with self._request(url, "pbf", method="HEAD", redirect_allowed=matches_region) as (response, resolved):
            _url(resolved, "dated")
            return _metadata(response, resolved)

    def _checksum(self, sidecar, artifact_url):
        content, _ = self._payload(sidecar, "sidecar", "sidecar_missing")
        filename = artifact_url.rsplit("/", 1)[1]
        pattern = rb"([0-9a-fA-F]{32}) [ *]" + re.escape(filename.encode("ascii")) + rb"\r?\n?"
        match = re.fullmatch(pattern, content)
        if match is None:
            raise ProviderError("invalid_sidecar", "Geofabrik checksum sidecar does not name exactly the pinned file.")
        return match[1].decode("ascii").lower()

    def pbf_pin(self, resolved_url):
        with self._request(resolved_url, "dated", method="HEAD") as (response, url):
            pin = _metadata(response, url)
        if not pin["length"]:
            raise ProviderError("invalid_metadata", "The dated Geofabrik PBF lacks a positive byte length.")
        pin["md5"] = self._checksum(url + ".md5", url)
        return pin

    @staticmethod
    def _poly_sidecar(url, sidecar):
        sidecar = _url(sidecar, "sidecar")
        if sidecar.rsplit("/", 1)[1] != url.rsplit("/", 1)[1] + ".md5":
            raise ProviderError("invalid_sidecar", "The POLY checksum URL does not match the frozen filename.")
        return sidecar

    def poly_pin(self, url, optional_sidecar_url=""):
        with self._request(url, "poly", method="HEAD") as (response, url):
            pin = _metadata(response, url)
        pin["md5"] = ""
        if optional_sidecar_url:
            sidecar = self._poly_sidecar(url, optional_sidecar_url)
            try:
                pin["md5"] = self._checksum(sidecar, url)
            except ProviderError as error:
                if error.code != "sidecar_missing":
                    raise
        return pin

    def download(self, pin, kind, file, limit, progress):
        url_kind = {"pbf": "dated", "poly": "poly"}[kind]
        size_error = ProviderError("size_limit", "Geofabrik artifact exceeds the byte limit.")
        length_error = ProviderError("length_mismatch", "Geofabrik artifact has an unexpected byte length.", retryable=True)
        expected_length = pin.get("length")
        expected_md5 = pin.get("md5") or ""
        if expected_length is not None and expected_length > limit:
            raise size_error
        if kind == "pbf" and (not expected_length or not re.fullmatch(r"[0-9a-f]{32}", expected_md5)):
            raise ProviderError("invalid_pin", "The dated PBF is missing its length or MD5 pin.")

        etag = pin.get("etag") or ""
        if etag and (len(etag) > 255 or not ETAG.fullmatch(etag)):
            raise ProviderError("invalid_pin", "The frozen HTTP ETag is invalid.")
        # Geofabrik proxies can hold different versions of a mutable URL.
        conditional = {"Cache-Control": "no-cache"}
        if etag.startswith('"'):
            conditional["If-Match"] = etag
        with self._request(pin["url"], url_kind, headers=conditional) as (response, url):
            actual = _metadata(response, url)
            for validator in ("etag", "last_modified"):
                if pin.get(validator) and pin[validator] != actual[validator]:
                    raise ProviderError("validator_changed", "Geofabrik HTTP validators changed after pinning.")
            response_length = actual["length"]
            if response_length is not None and response_length > limit:
                raise size_error
            if expected_length is not None and response_length is not None and expected_length != response_length:
                raise length_error

            md5 = hashlib.md5(usedforsecurity=False)
            sha256 = hashlib.sha256()
            received = 0
            reported = 0
            polygon = bytearray() if kind == "poly" else None
            reported_at = monotonic()
            deadline = reported_at + 1800
            lengths = [length for length in (expected_length, response_length) if length is not None]
            while block := _read(response, min(CHUNK_SIZE, limit + 1 - received), deadline):
                received += len(block)
                if received > limit:
                    raise size_error
                if any(received > length for length in lengths):
                    raise length_error
                md5.update(block)
                sha256.update(block)
                file.write(block)
                if polygon is not None:
                    polygon.extend(block)
                if progress is not None:
                    now = monotonic()
                    if received - reported >= CHUNK_SIZE or now - reported_at >= 2:
                        progress(received)
                        reported = received
                        reported_at = now

        if any(received != length for length in lengths):
            raise length_error
        digest = md5.hexdigest()
        if expected_md5 and digest != expected_md5:
            raise ProviderError("checksum_mismatch", "Geofabrik artifact does not match the pinned MD5.", retryable=True)
        if polygon is not None:
            _validate_poly(polygon)
        if progress is not None and received != reported:
            progress(received)
        return {
            "length": received,
            "sha256": sha256.hexdigest(),
            "md5": digest,
            "etag": actual["etag"],
            "last_modified": actual["last_modified"],
        }
