import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuditTests(unittest.TestCase):
    def run_audit(self, objects):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "fixture.osm"
            source.write_text('<osm version="0.6">' + objects + '</osm>', encoding="utf8")
            return module.audit(source)

    def test_preserves_untagged_and_ordered_references(self):
        report = self.run_audit('''
          <node id="1" lat="35.1" lon="51.2" version="1" timestamp="2026-10-25T00:00:00Z"/>
          <node id="2" lat="35.2" lon="51.3" version="2"><tag k="name:fa" v="آزمون"/></node>
          <way id="3" version="1"><nd ref="2"/><nd ref="1"/></way>
          <relation id="4" version="1"><member type="way" ref="3" role="outer"/></relation>''')
        self.assertEqual(report["counts"], {"node": 2, "way": 1, "relation": 1})
        self.assertEqual(report["untagged"]["node"], 1)
        self.assertEqual(report["structural_status"], "passed")
        self.assertEqual(report["references"]["counts"]["way_to_node"], 2)
        self.assertEqual(report['metadata_coverage']['timestamp'], {'present':1,'absent':3})

    def test_missing_way_node_blocks_and_missing_relation_requires_review(self):
        report = self.run_audit('''<node id="1" lat="0" lon="0"/>
          <way id="2"><nd ref="1"/><nd ref="9"/></way>
          <relation id="3"><member type="relation" ref="99" role="subarea"/></relation>''')
        self.assertIn("missing_way_nodes", report["blockers"])
        self.assertIn("incomplete_relation_members", report["review_reasons"])

    def test_duplicate_snapshot_object_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.run_audit('<node id="1" lat="0" lon="0"/><node id="1" lat="0" lon="0"/>')

    def test_reference_order_changes_semantic_digest(self):
        nodes = '<node id="1" lat="0" lon="0"/><node id="2" lat="1" lon="1"/>'
        a = self.run_audit(nodes + '<way id="3"><nd ref="1"/><nd ref="2"/></way>')
        b = self.run_audit(nodes + '<way id="3"><nd ref="2"/><nd ref="1"/></way>')
        self.assertNotEqual(a["semantic_digest"]["way"], b["semantic_digest"]["way"])

    def test_rejects_jsonb_loss_and_lua_reference_rounding(self):
        with self.assertRaisesRegex(ValueError, 'duplicate tag'):
            self.run_audit('<node id="1" lat="0" lon="0"><tag k="name" v="a"/><tag k="name" v="b"/></node>')
        with self.assertRaisesRegex(ValueError, 'reference ID'):
            self.run_audit('<node id="1" lat="0" lon="0"/><way id="2"><nd ref="9007199254740993"/></way>')


if __name__ == "__main__":
    unittest.main()
