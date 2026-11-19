"""Small synthetic POLYs exercise the approved provider-plane policy."""

import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from django.contrib.gis.geos import GEOSGeometry, Point

from atlas_verification.geometry import verify_poly


def poly(*sections, header="Synthetic boundary"):
    lines = [header]
    for label, points in sections:
        lines.append(label)
        lines.extend(f"  {x} {y}" for x, y in points)
        lines.append("END")
    return ("\n".join([*lines, "END", ""]).encode("utf-8"))


SQUARE = [(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)]


class GeometryVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def check_poly(self, source):
        source_path = self.root / "source.poly"
        source_path.write_bytes(source)
        output = self.root / f"output-{len(list(self.root.glob('output-*')))}"
        output.mkdir()
        self.output = output
        progress = []
        result = verify_poly(source_path, output, progress.append)
        self.assertEqual(source_path.read_bytes(), source)
        return result, progress

    def sidecar(self, result):
        output = result["outputs"][0]
        self.assertEqual(Path(output["path"]).name, output["path"])
        data = (self.output / output["path"]).read_bytes()
        self.assertEqual(len(data), output["size"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), output["sha256"])
        return json.loads(data)

    def coverage(self, result):
        return GEOSGeometry(memoryview(bytes.fromhex(
            self.sidecar(result)["derived_coverage_wkb_hex"]
        )))

    def codes(self, result):
        return {reason["code"] for reason in result["reasons"]}

    def test_explicit_closure_preserves_source_tokens_labels_and_header(self):
        source = b"  Provider header \r\n  part-A \r\n +0.000 -0\r\n 4.0 0e0\r\n 4 4\r\n 0 4\r\n +0.000 -0\r\nEND\r\nEND\r\n"
        result, progress = self.check_poly(source)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["summary"]["area"], 16.0)
        self.assertEqual(result["summary"]["implicit_closure_count"], 0)
        sidecar = self.sidecar(result)
        self.assertEqual(sidecar["header"], "  Provider header ")
        self.assertEqual(sidecar["sections"][0]["label"], "  part-A ")
        self.assertEqual(sidecar["sections"][0]["coordinates"][0], ["+0.000", "-0"])
        self.assertEqual(sidecar["sections"][0]["coordinates"][1], ["4.0", "0e0"])
        self.assertTrue(sidecar["sections"][0]["encoded_closure"])
        self.assertTrue(progress)

    def test_implicit_closure_is_derived_without_adding_a_source_coordinate(self):
        result, _ = self.check_poly(poly(("1", SQUARE[:-1])))
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["summary"]["implicit_closure_count"], 1)
        section = self.sidecar(result)["sections"][0]
        self.assertEqual(len(section["coordinates"]), 4)
        self.assertFalse(section["encoded_closure"])
        self.assertTrue(self.coverage(result).covers(Point(2, 2)))

    def test_repeated_consecutive_coordinate_is_retained_and_warns(self):
        result, _ = self.check_poly(poly(("1", [SQUARE[0], *SQUARE])))
        self.assertEqual(result["status"], "verified_with_warnings")
        self.assertEqual(result["summary"]["repeated_consecutive_count"], 1)
        self.assertIn("poly_repeated_consecutive", self.codes(result))
        self.assertEqual(len(self.sidecar(result)["sections"][0]["coordinates"]), 6)
        self.assertEqual(self.coverage(result).area, 16.0)

    def test_orientation_is_informational_for_both_directions(self):
        for points, expected in [(SQUARE, "counterclockwise"), (list(reversed(SQUARE)), "clockwise")]:
            with self.subTest(expected=expected):
                result, _ = self.check_poly(poly(("1", points)))
                self.assertEqual(result["status"], "verified")
                self.assertEqual(self.sidecar(result)["sections"][0]["orientation"], expected)
                self.assertEqual(self.coverage(result).area, 16.0)

    def test_orientation_of_tiny_valid_ring_avoids_large_coordinate_cancellation(self):
        points = [("120", "30"), ("120.000000001", "30"),
                  ("120.000000001", "30.000000001"),
                  ("120", "30.000000001"), ("120", "30")]
        result, _ = self.check_poly(poly(("tiny", points)))
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self.sidecar(result)["sections"][0]["orientation"], "counterclockwise")

    def test_overlapping_valid_inclusions_are_recorded_unions(self):
        other = [(2, 0), (6, 0), (6, 4), (2, 4), (2, 0)]
        result, _ = self.check_poly(poly(("1", SQUARE), ("2", other)))
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["summary"]["union_count"], 1)
        self.assertEqual(result["summary"]["overlapping_inclusion_count"], 1)
        self.assertEqual(self.coverage(result).area, 24.0)

    def test_south_africa_shaped_exclusion_preserves_role_and_hole(self):
        hole = [(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)]
        result, _ = self.check_poly(poly(("South Africa", SQUARE), ("!Lesotho", hole)))
        self.assertEqual(result["status"], "verified")
        area = self.coverage(result)
        self.assertEqual(area.area, 15.0)
        self.assertTrue(area.covers(Point(3, 3)))
        self.assertFalse(area.covers(Point(1.5, 1.5)))
        self.assertEqual([s["role"] for s in self.sidecar(result)["sections"]], ["include", "exclude"])

    def test_subtraction_is_checked_against_coverage_available_at_that_point(self):
        hole = [(5, 1), (6, 1), (6, 2), (5, 2), (5, 1)]
        later = [(4, 0), (8, 0), (8, 4), (4, 4), (4, 0)]
        result, _ = self.check_poly(poly(("1", SQUARE), ("!hole", hole), ("later", later)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_exclusion_outside_coverage", self.codes(result))

    def test_later_inclusion_can_fill_a_previously_subtracted_hole(self):
        hole = [(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)]
        result, _ = self.check_poly(poly(("1", SQUARE), ("!hole", hole), ("fill", hole)))
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self.coverage(result).area, 16.0)

    def test_repeated_exclusion_cannot_subtract_area_already_removed(self):
        hole = [(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)]
        result, _ = self.check_poly(poly(("1", SQUARE), ("!first", hole), ("!again", hole)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_exclusion_outside_coverage", self.codes(result))

    def test_fiji_russia_and_alaska_split_sections_do_not_cross_the_globe(self):
        for label, latitude in [("Fiji", -20), ("Russia", 65), ("US Alaska", 55)]:
            with self.subTest(region=label):
                west = [(-180, latitude), (-175, latitude), (-175, latitude + 3), (-180, latitude + 3), (-180, latitude)]
                east = [(175, latitude), (180, latitude), (180, latitude + 3), (175, latitude + 3), (175, latitude)]
                result, _ = self.check_poly(poly(("west", west), ("east", east), header=label))
                self.assertEqual(result["status"], "verified")
                self.assertEqual(result["summary"]["component_count"], 2)
                area = self.coverage(result)
                self.assertTrue(area.covers(Point(-179, latitude + 1)))
                self.assertTrue(area.covers(Point(179, latitude + 1)))
                self.assertFalse(area.covers(Point(0, latitude + 1)))
                self.assertEqual(area.area, 30.0)

    def test_antarctica_full_longitude_band_is_not_unwrapped(self):
        band = [(-180, -90), (180, -90), (180, -60), (-180, -60), (-180, -90)]
        result, _ = self.check_poly(poly(("1", band), header="Antarctica"))
        self.assertEqual(result["status"], "verified")
        area = self.coverage(result)
        self.assertEqual(area.area, 10800.0)
        for x in [-179, -90, 0, 90, 179]:
            self.assertTrue(area.covers(Point(x, -75)))
            self.assertFalse(area.covers(Point(x, -59)))

    def test_invalid_ring_cannot_be_hidden_by_union_with_valid_inclusion(self):
        bowtie = [(1, 1), (3, 3), (1, 3), (3, 1), (1, 1)]
        result, _ = self.check_poly(poly(("valid", SQUARE), ("bowtie", bowtie)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_invalid_ring", self.codes(result))
        self.assertFalse(self.sidecar(result)["sections"][1]["ring_valid"])
        self.assertIsNone(self.sidecar(result)["derived_coverage_wkb_hex"])

    def test_invalid_hole_is_rejected_before_difference(self):
        bowtie = [(1, 1), (3, 3), (1, 3), (3, 1), (1, 1)]
        result, _ = self.check_poly(poly(("1", SQUARE), ("!hole", bowtie)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_invalid_ring", self.codes(result))

    def test_exclusion_before_inclusion_is_invalid(self):
        result, _ = self.check_poly(poly(("!first", SQUARE), ("later", SQUARE)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_exclusion_outside_coverage", self.codes(result))

    def test_empty_result_is_invalid(self):
        result, _ = self.check_poly(poly(("1", SQUARE), ("!all", SQUARE)))
        self.assertEqual(result["status"], "input_invalid")
        self.assertIn("poly_empty_coverage", self.codes(result))

    def test_malformed_coordinates_syntax_and_framing_are_invalid(self):
        examples = [
            b"", b"header\nEND\n", b"header\n1\n0 0\nEND\nEND\n",
            poly(("1", [(0, 0), (1, 1), (2, 2), (0, 0)])),
            poly(("1", SQUARE)).replace(b"4 4", b"4 4 5"),
            poly(("1", SQUARE)).replace(b"4 4", b"NaN 4"),
            poly(("1", SQUARE)).replace(b"4 4", b"Infinity 4"),
            poly(("1", SQUARE)).replace(b"4 4", b"1_0 4"),
            poly(("1", SQUARE)).replace(b"4 4", b"181 4"),
            poly(("1", SQUARE)).replace(b"4 4", b"4 -91"),
            poly(("1", SQUARE))[:-5],
            poly(("1", SQUARE)) + b"unexpected\n",
            poly(("1", SQUARE)).replace(b"Synthetic", b"\xff"),
            poly(("!", SQUARE)),
        ]
        for source in examples:
            with self.subTest(source=source[:80]):
                result, _ = self.check_poly(source)
                self.assertEqual(result["status"], "input_invalid")
                self.assertTrue(result["reasons"])

    def test_byte_and_vertex_profiles_stop_before_unbounded_geometry_work(self):
        source = poly(("1", SQUARE))
        with patch("atlas_verification.geometry.MAX_POLY_BYTES", len(source) - 1):
            result, _ = self.check_poly(source)
        self.assertEqual(result["status"], "unsupported_profile")
        self.assertIn("poly_profile_byte_limit", self.codes(result))
        with patch("atlas_verification.geometry.MAX_POLY_VERTICES", 4):
            result, _ = self.check_poly(source)
        self.assertEqual(result["status"], "unsupported_profile")
        self.assertIn("poly_profile_vertex_limit", self.codes(result))

    def test_error_samples_and_manifest_section_samples_are_bounded(self):
        sections = [(f"bad-{i}", [(0, 0), (1, 1), (2, 2), (0, 0)]) for i in range(80)]
        result, _ = self.check_poly(poly(*sections))
        self.assertEqual(result["status"], "input_invalid")
        self.assertEqual(result["summary"]["invalid_ring_count"], 80)
        self.assertLessEqual(len(result["reasons"]), 32)
        self.assertLessEqual(len(result["summary"]["section_samples"]), 16)
        self.assertTrue(all(len(reason["message"]) <= 512 for reason in result["reasons"]))

    def test_same_source_produces_identical_sidecar_bytes(self):
        source = poly(("1", SQUARE))
        first, _ = self.check_poly(source)
        first_bytes = (self.output / first["outputs"][0]["path"]).read_bytes()
        second, _ = self.check_poly(source)
        self.assertEqual(first["outputs"], second["outputs"])
        self.assertEqual((self.output / second["outputs"][0]["path"]).read_bytes(), first_bytes)
