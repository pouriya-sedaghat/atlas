"""Bounded POLY verification in the provider longitude/latitude plane.

The caller owns source identity and private output storage. Source bytes stay in
the original artifact; this sidecar preserves tokens and the derived GEOS result.
No longitude unwrapping, snapping, buffering, or topology repair is performed.
"""

from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re

from django.contrib.gis.geos import GEOSException, LinearRing, Polygon, geos_version


POLY_POLICY = "atlas-poly-provider-plane-v1"
MAX_POLY_BYTES = 2 * 1024**2
MAX_POLY_VERTICES = 100_000
MAX_POLY_SECTIONS = 1024
MAX_LABEL_CHARACTERS = 256
MAX_HEADER_CHARACTERS = 1024
MAX_REASONS = 32
MAX_SECTION_SAMPLES = 16
MAX_SIDECAR_BYTES = 16 * 1024**2
DECIMAL_TOKEN = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z", re.ASCII)


class PolySyntaxError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class Findings:
    """Keep every count and severity while bounding human-readable samples."""

    def __init__(self):
        self.reasons = []
        self.count = 0
        self.invalid = False
        self.warning = False

    def add(self, code, message, *, warning=False):
        self.count += 1
        self.invalid |= not warning
        self.warning |= warning
        if len(self.reasons) < MAX_REASONS:
            self.reasons.append({"code": code, "message": str(message)[:512]})


def _parse(data, progress):
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeError:
        raise PolySyntaxError("poly_text_encoding", "POLY is not valid UTF-8.") from None
    lines = iter(enumerate(text.splitlines(), 1))
    header = None
    sections = []
    current = None
    vertex_count = 0
    ended = False
    for number, raw in lines:
        line = raw.strip()
        if not line:
            continue
        if ended:
            raise PolySyntaxError("poly_trailing_content", f"Content follows the final END at line {number}.")
        if header is None:
            if not raw.isprintable() or len(raw) > MAX_HEADER_CHARACTERS:
                raise PolySyntaxError("poly_header", "POLY header is not printable or exceeds the source profile.")
            header = raw
            continue
        if current is None:
            if line == "END":
                ended = True
                continue
            if not raw.isprintable() or line == "!" or len(raw) > MAX_LABEL_CHARACTERS:
                raise PolySyntaxError("poly_section_label", f"Invalid section label at line {number}.")
            if len(sections) >= MAX_POLY_SECTIONS:
                raise PolySyntaxError("poly_profile_section_limit", "POLY exceeds the 1024-section source profile.")
            current = {
                "ordinal": len(sections) + 1, "line": number, "label": raw,
                "identifier": line[1:] if line.startswith("!") else line,
                "role": "exclude" if line.startswith("!") else "include",
                "coordinates": [],
            }
            sections.append(current)
        elif line == "END":
            current = None
        else:
            tokens = line.split()
            if len(tokens) != 2 or any(not DECIMAL_TOKEN.fullmatch(token) for token in tokens):
                raise PolySyntaxError("poly_coordinate_syntax", f"Expected two decimal coordinate tokens at line {number}.")
            try:
                x, y = (Decimal(token) for token in tokens)
            except InvalidOperation:
                raise PolySyntaxError("poly_coordinate_syntax", f"Invalid decimal coordinate at line {number}.") from None
            if not x.is_finite() or not y.is_finite() or not -180 <= x <= 180 or not -90 <= y <= 90:
                raise PolySyntaxError("poly_coordinate_range", f"Coordinate outside finite longitude/latitude bounds at line {number}.")
            vertex_count += 1
            if vertex_count > MAX_POLY_VERTICES:
                raise PolySyntaxError("poly_profile_vertex_limit", "POLY exceeds the 100000-vertex source profile.")
            current["coordinates"].append(tokens)
            if vertex_count % 2048 == 0:
                progress({"phase": "poly_parse", "vertices": vertex_count, "sections": len(sections)})
    if header is None or current is not None or not ended or not sections:
        raise PolySyntaxError("poly_incomplete", "POLY must contain a header, completed sections, and a final END.")
    return header, sections, vertex_count


def _ring(section):
    exact = [tuple(Decimal(value) for value in point) for point in section["coordinates"]]
    encoded_closure = bool(exact) and exact[0] == exact[-1]
    repeated = sum(a == b for a, b in zip(exact, exact[1:]))
    section.update(encoded_closure=encoded_closure, repeated_consecutive_count=repeated,
                   ring_valid=False, orientation="degenerate", composition_checked=False)
    if len(set(exact)) < 3:
        section["validity_reason"] = "A ring requires at least three distinct coordinate pairs."
        return None
    points = [(float(x), float(y)) for x, y in exact]
    if not encoded_closure:
        points.append(points[0])
    try:
        ring = LinearRing(points)
        polygon = Polygon(ring)
        if polygon.area > 0:
            section["orientation"] = "counterclockwise" if ring.is_counterclockwise else "clockwise"
        # GEOSisValidReason diagnoses without emitting an unbounded notice per
        # invalid coordinate. Both the ring and its polygon are checked first.
        reason = polygon.valid_reason
        valid = ring.simple and reason == "Valid Geometry" and not polygon.empty and polygon.area > 0
    except (GEOSException, ValueError) as error:
        section["validity_reason"] = str(error)[:512]
        return None
    section.update(ring_valid=valid, validity_reason=reason if valid or reason != "Valid Geometry" else "Non-simple or zero-area ring.")
    return polygon if valid else None


def _write_sidecar(path, value):
    digest = hashlib.sha256()
    size = 0
    # Streaming also bounds the serializer's extra working memory. The source
    # profile bounds the token table and WKB before this hard output ceiling.
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    with path.open("xb") as output:
        for piece in encoder.iterencode(value):
            encoded = piece.encode("utf-8")
            size += len(encoded)
            if size > MAX_SIDECAR_BYTES:
                raise RuntimeError("POLY sidecar exceeds its 16 MiB resource ceiling.")
            output.write(encoded)
            digest.update(encoded)
        output.flush()
        os.fsync(output.fileno())
    return {"path": path.name, "encoding": "json", "schema_version": 1,
            "size": size, "sha256": digest.hexdigest()}


def verify_poly(path: Path, output_dir: Path, progress) -> dict:
    """Inspect one stable spool; invalid input never becomes a repaired area.

    The 2 MiB / 100000 encoded-vertex / 1024-section profile is explicit. I/O,
    missing runtime dependencies, memory and output-limit failures propagate to
    the caller as operational failures rather than a successful boundary check.
    """
    findings = Findings()
    summary = {
        "section_count": 0, "inclusion_count": 0, "exclusion_count": 0,
        "vertex_count": 0, "invalid_ring_count": 0, "implicit_closure_count": 0,
        "repeated_consecutive_count": 0, "union_count": 0,
        "overlapping_inclusion_count": 0, "subtraction_count": 0,
        "component_count": 0, "area": None, "extent": None, "section_samples": [],
    }
    report = {"status": "input_invalid", "policy": POLY_POLICY,
              "coordinate_plane": "provider_longitude_latitude",
              "validation_precision": "GEOS IEEE-754 binary64; original decimal tokens preserved",
              "source_profile": {"max_bytes": MAX_POLY_BYTES, "max_vertices": MAX_POLY_VERTICES,
                                 "max_sections": MAX_POLY_SECTIONS},
              "reasons": findings.reasons, "summary": summary, "outputs": [], "completed_checks": []}
    progress({"phase": "poly_parse", "vertices": 0})
    with Path(path).open("rb") as source:
        data = source.read(MAX_POLY_BYTES + 1)
    if len(data) > MAX_POLY_BYTES:
        report["status"] = "unsupported_profile"
        findings.add("poly_profile_byte_limit", "POLY exceeds the 2 MiB source profile.")
        return report
    try:
        header, sections, vertex_count = _parse(data, progress)
    except PolySyntaxError as error:
        if error.code.startswith("poly_profile_"):
            report["status"] = "unsupported_profile"
        findings.add(error.code, error)
        return report
    report["completed_checks"].append("poly_syntax")
    summary.update(section_count=len(sections), vertex_count=vertex_count,
                   inclusion_count=sum(s["role"] == "include" for s in sections),
                   exclusion_count=sum(s["role"] == "exclude" for s in sections))
    geometries = []
    for section in sections:
        progress({"phase": "poly_rings", "section": section["ordinal"], "sections": len(sections)})
        geometry = _ring(section)
        geometries.append(geometry)
        summary["implicit_closure_count"] += not section["encoded_closure"]
        summary["repeated_consecutive_count"] += section["repeated_consecutive_count"]
        if geometry is None:
            summary["invalid_ring_count"] += 1
            findings.add("poly_invalid_ring", f"Section {section['ordinal']} ({section['identifier']}): {section['validity_reason']}")
    report["completed_checks"].append("poly_rings")
    coverage = None
    if not findings.invalid:
        for section, geometry in zip(sections, geometries):
            progress({"phase": "poly_coverage", "section": section["ordinal"], "sections": len(sections)})
            try:
                if section["role"] == "exclude":
                    if coverage is None or not coverage.covers(geometry):
                        findings.add("poly_exclusion_outside_coverage", f"Exclusion section {section['ordinal']} ({section['identifier']}) is not covered by the area available at that point.")
                        break
                    coverage = coverage.difference(geometry)
                    section["operation"] = "difference"
                    summary["subtraction_count"] += 1
                elif coverage is None:
                    coverage = geometry
                    section["operation"] = "initial_inclusion"
                else:
                    section["overlaps_previous"] = coverage.intersection(geometry).area > 0
                    summary["overlapping_inclusion_count"] += section["overlaps_previous"]
                    coverage = coverage.union(geometry)
                    section["operation"] = "union"
                    summary["union_count"] += 1
                reason = coverage.valid_reason
                section["composition_checked"] = True
                section["composed_valid"] = reason == "Valid Geometry" and coverage.geom_type in {"Polygon", "MultiPolygon"}
                if not section["composed_valid"]:
                    findings.add("poly_invalid_coverage", f"Invalid composed area after section {section['ordinal']}: {reason}")
                    break
            except GEOSException as error:
                findings.add("poly_composition_failed", f"GEOS could not compose section {section['ordinal']}: {error}")
                break
        if not findings.invalid and (coverage is None or coverage.empty or coverage.area <= 0):
            findings.add("poly_empty_coverage", "The composed POLY contains no positive-area coverage.")
        report["completed_checks"].append("poly_coverage")
    if summary["repeated_consecutive_count"]:
        findings.add("poly_repeated_consecutive", f"Retained {summary['repeated_consecutive_count']} repeated consecutive coordinate pairs.", warning=True)
    if findings.invalid:
        coverage = None
    else:
        summary.update(area=coverage.area, extent=list(coverage.extent),
                       component_count=coverage.num_geom if coverage.geom_type == "MultiPolygon" else 1)
        report["status"] = "verified_with_warnings" if findings.warning else "verified"
    summary["section_samples"] = [{
        "ordinal": section["ordinal"], "identifier": section["identifier"], "role": section["role"],
        "ring_valid": section["ring_valid"], "orientation": section["orientation"],
        "encoded_closure": section["encoded_closure"], "composition_checked": section["composition_checked"],
    } for section in sections[:MAX_SECTION_SAMPLES]]
    summary["reason_count"] = findings.count
    summary["reason_samples_omitted"] = max(0, findings.count - len(findings.reasons))
    report["information"] = [{"code": "poly_orientation", "message": "Section orientation is informational; inclusion and exclusion roles follow source labels."}]
    if summary["implicit_closure_count"]:
        report["information"].append({"code": "poly_implicit_closure", "message": f"Derived closure for {summary['implicit_closure_count']} rings; encoded source coordinates are unchanged."})
    sidecar = {
        "schema_version": 1, "policy": POLY_POLICY, "header": header, "sections": sections,
        "source_sha256": hashlib.sha256(data).hexdigest(), "source_size": len(data),
        "coordinate_plane": "provider_longitude_latitude", "geos_version": geos_version().decode("ascii"),
        "derived_coverage_wkb_hex": bytes(coverage.wkb).hex() if coverage is not None else None,
        "raw_bytes": "Preserved in the original immutable POLY artifact identified by source_sha256.",
    }
    output = _write_sidecar(Path(output_dir) / "poly-source.json", sidecar)
    report["outputs"].append(output)
    progress({"phase": "poly_complete", "status": report["status"], "sections": len(sections), "vertices": vertex_count})
    return report
