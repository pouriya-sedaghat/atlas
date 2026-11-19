"""Tiny exactness fixtures; no real provider data belongs in the repository."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

import zstandard

from atlas_verification.proto import fileformat_pb2 as ff, osmformat_pb2 as osm


def frame(kind, message, compression="raw"):
    raw = message.SerializeToString() if hasattr(message, "SerializeToString") else message
    blob = ff.Blob(raw=raw) if compression == "raw" else ff.Blob(zlib_data=zlib.compress(raw), raw_size=len(raw))
    payload = blob.SerializeToString()
    header = ff.BlobHeader(type=kind, datasize=len(payload)).SerializeToString()
    return struct.pack(">I", len(header)) + header + payload


def pbf(*blocks, required=("OsmSchema-V0.6", "DenseNodes"), optional=(), compression="raw"):
    header = osm.HeaderBlock(required_features=required, optional_features=optional)
    return frame("OSMHeader", header, compression) + b"".join(frame("OSMData", block, compression) for block in blocks)


def block():
    result = osm.PrimitiveBlock()
    result.stringtable.s.extend([b"", b"name", "\u0646\u0627\u0645".encode(), b"outer", b"user"])
    return result


class DecoderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def scan(self, data):
        self.assertIsNotNone(importlib.util.find_spec("atlas_verification.decoder"), "exact decoder is implemented")
        from atlas_verification.decoder import scan_pbf
        source = self.directory / "input.pbf"
        source.write_bytes(data)
        output = self.directory / "out"
        output.mkdir(exist_ok=True)
        self.progress = []
        return scan_pbf(source, output, self.progress.append)

    def records(self):
        path = self.directory / "out" / "objects.jsonl.zst"
        with path.open("rb") as stream, zstandard.ZstdDecompressor().stream_reader(stream) as decoded:
            return [json.loads(line) for line in io.TextIOWrapper(decoded, encoding="utf-8")]

    def test_full_width_exact_metadata_tag_order_and_precision(self):
        b = block()
        b.granularity = 7
        b.date_granularity = 13
        b.lat_offset = -51
        b.lon_offset = 83
        n = b.primitivegroup.add().nodes.add(id=9007199254740993, lat=123, lon=-456)
        n.keys.extend([1, 1])
        n.vals.extend([2, 0])
        n.info.version = 1
        n.info.changeset = 0
        n.info.uid = 0
        n.info.user_sid = 0
        n.info.timestamp = 9007199254740993
        result = self.scan(pbf(b, compression="zlib"))
        self.assertEqual(result["status"], "verified")
        record = self.records()[0]
        self.assertEqual(record["id"], "9007199254740993")
        self.assertEqual(record["lat_nanodegrees"], "810")
        self.assertEqual(record["lon_nanodegrees"], "-3109")
        self.assertEqual(record["tags"], [["name", "\u0646\u0627\u0645"], ["name", ""]])
        self.assertEqual(record["metadata"]["changeset"], "0")
        self.assertEqual(record["metadata"]["uid"], "0")
        self.assertEqual(record["metadata"]["user"], "")
        self.assertEqual(record["metadata"]["timestamp_ticks"], "9007199254740993")
        self.assertEqual(record["metadata"]["timestamp_ms"], "117093590311632909")
        self.assertTrue(record["metadata"]["present"])
        self.assertNotIn("uid", record["metadata"]["missing"])
        self.assertEqual(result["tags"]["nodes"], 2)
        self.assertTrue(self.progress)
        descriptor = result["outputs"][0]
        encoded = (self.directory / "out" / descriptor["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), descriptor["sha256"])
        self.assertEqual(result["reread"]["counts"], result["counts"])

    def test_dense_absent_info_and_empty_present_info_differ(self):
        b = block()
        first = b.primitivegroup.add().dense
        first.id.extend([2, 3]); first.lat.extend([0, 1]); first.lon.extend([0, 1])
        second = b.primitivegroup.add().dense
        second.id.extend([7]); second.lat.extend([0]); second.lon.extend([0]); second.denseinfo.SetInParent()
        third = b.primitivegroup.add().dense
        third.id.extend([8, 1]); third.lat.extend([0, 0]); third.lon.extend([0, 0])
        third.denseinfo.uid.extend([0, 4]); third.denseinfo.user_sid.extend([0, 4])
        third.denseinfo.timestamp.extend([10, -3]); third.denseinfo.version.extend([1, 2])
        result = self.scan(pbf(b))
        self.assertEqual(result["status"], "verified")
        records = self.records()
        self.assertFalse(records[0]["metadata"]["present"])
        self.assertTrue(records[2]["metadata"]["present"])
        self.assertEqual(records[3]["metadata"]["uid"], "0")
        self.assertEqual(records[4]["metadata"]["timestamp_ticks"], "7")

    def test_way_locations_and_member_order_and_all_reference_metrics(self):
        b = block()
        b.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        w = b.primitivegroup.add().ways.add(id=10)
        w.refs.extend([1, 1, 0]); w.lat.extend([0, 1, 0]); w.lon.extend([0, 2, 0])
        relation = b.primitivegroup.add().relations.add(id=20)
        relation.memids.extend([2, 0, 97, 0, -19, 20])
        relation.types.extend([0, 0, 1, 1, 2, 2]); relation.roles_sid.extend([3, 0, 0, 3, 0, 0])
        result = self.scan(pbf(b, optional=("LocationsOnWays", "FutureInformationalName")))
        self.assertEqual(result["status"], "input_invalid")
        self.assertEqual(result["references"]["way_node"]["total"], 3)
        self.assertEqual(result["references"]["way_node"]["missing_occurrences"], 2)
        self.assertEqual(result["references"]["way_node"]["distinct_targets"], 1)
        self.assertEqual(result["references"]["way_node"]["affected_sources"], 1)
        for kind in ("relation_node", "relation_way"):
            self.assertEqual(result["references"][kind]["missing_occurrences"], 2)
            self.assertEqual(result["references"][kind]["distinct_targets"], 1)
        self.assertEqual(result["references"]["relation_relation"]["missing_occurrences"], 2)
        self.assertEqual(result["references"]["relation_relation"]["distinct_targets"], 2)
        records = self.records()
        self.assertEqual(records[1]["refs"], ["1", "2", "2"])
        self.assertEqual(records[1]["locations"][1], {"lat_nanodegrees": "100", "lon_nanodegrees": "200"})
        self.assertEqual(records[2]["members"][0], {"type": "node", "id": "2", "role": "outer"})

    def test_relation_gaps_warn_and_valid_empty_is_verified(self):
        b = block(); r = b.primitivegroup.add().relations.add(id=1)
        r.memids.extend([999]); r.types.extend([osm.Relation.WAY]); r.roles_sid.extend([0])
        result = self.scan(pbf(b))
        self.assertEqual(result["status"], "verified_with_warnings")
        self.assertFalse(result["empty"])
        self.assertFalse((self.directory / "out" / "identities.sqlite3").exists())
        result = self.scan(pbf())
        self.assertEqual(result["status"], "verified")
        self.assertTrue(result["empty"])

    def test_malformed_profiles_are_classified(self):
        b = block(); b.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        cases = [(pbf(b, required=("OsmSchema-V0.6", "HistoricalInformation")), "unsupported_profile"),
                 (pbf(b)[:-1], "input_invalid"), (b"", "input_invalid")]
        b2 = block(); b2.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        b2.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        cases.append((pbf(b2), "input_invalid"))
        b3 = block(); b3.primitivegroup.add().nodes.add(id=1, lat=900000001, lon=0)
        cases.append((pbf(b3), "input_invalid"))
        b4 = block(); d=b4.primitivegroup.add().dense; d.id.extend([1, 1]); d.lat.extend([0]); d.lon.extend([0, 0])
        cases.append((pbf(b4), "input_invalid"))
        b5 = block(); n=b5.primitivegroup.add().nodes.add(id=1, lat=0, lon=0); n.keys.append(1)
        cases.append((pbf(b5), "input_invalid"))
        b6 = block(); d=b6.primitivegroup.add().dense; d.id.extend([1]); d.lat.extend([0]); d.lon.extend([0]); d.keys_vals.extend([1, 2])
        cases.append((pbf(b6), "input_invalid"))
        b7 = block(); d=b7.primitivegroup.add().dense; d.id.extend([1, 1]); d.lat.extend([0,0]); d.lon.extend([0,0]); d.denseinfo.uid.extend([1])
        cases.append((pbf(b7), "input_invalid"))
        b8 = block(); b8.stringtable.s.append(b"\xff")
        cases.append((pbf(b8), "input_invalid"))
        for data, status in cases:
            with self.subTest(status=status, digest=hashlib.sha256(data).hexdigest()[:8]):
                self.assertEqual(self.scan(data)["status"], status)

    def test_zlib_termination_unknown_fields_and_history_shapes(self):
        b = block(); n=b.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        raw=b.SerializeToString(); blob=ff.Blob(zlib_data=zlib.compress(raw)+b"trailing", raw_size=len(raw)).SerializeToString()
        hdr=ff.BlobHeader(type="OSMData", datasize=len(blob)).SerializeToString()
        data=pbf()+struct.pack(">I",len(hdr))+hdr+blob
        self.assertEqual(self.scan(data)["status"], "input_invalid")
        n.info.visible=True
        self.assertEqual(self.scan(pbf(b))["status"], "unsupported_profile")
        self.assertEqual(self.scan(pbf()+frame("OSMData", raw+b"\xa0\x06\x01"))["status"], "unsupported_profile")

    def test_schema_validation_determinism_and_opaque_block_metadata(self):
        import jsonschema
        b = block(); n=b.primitivegroup.add().nodes.add(id=9223372036854775807, lat=0, lon=0)
        n.info.SetInParent()
        first = self.scan(pbf(b))
        payload=(self.directory / "out" / "objects.jsonl.zst").read_bytes()
        record=self.records()[0]
        schema=json.loads((Path(__file__).resolve().parent.parent / "atlas_verification" / "schemas" / "object-v1.json").read_text())
        jsonschema.Draft202012Validator(schema).validate(record)
        self.assertTrue(record["metadata"]["present"])
        self.assertIn("uid", record["metadata"]["missing"])
        self.assertNotIn("uid", record["metadata"])
        second=self.scan(pbf(b))
        self.assertEqual(payload, (self.directory / "out" / "objects.jsonl.zst").read_bytes())
        self.assertEqual(first["outputs"], second["outputs"])

    def test_wire_overhead_is_bounded_before_protobuf_object_expansion(self):
        from unittest.mock import patch
        from atlas_verification import decoder
        b = block(); b.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        with patch.object(decoder, "MAX_PROTO_FIELDS", 2):
            result=self.scan(pbf(b))
        self.assertEqual(result["status"], "operational_failed")
        self.assertEqual(result["reasons"][0]["code"], "protobuf_overhead_budget")

    def test_all_absent_and_explicit_zero_source_values_round_trip(self):
        b=block(); n=b.primitivegroup.add().nodes.add(id=1, lat=0, lon=0)
        n.info.timestamp=0; n.info.changeset=0; n.info.uid=0; n.info.user_sid=0
        result=self.scan(pbf(b, optional=("FutureName",)))
        self.assertEqual(result["status"], "verified")
        metadata=self.records()[0]["metadata"]
        self.assertEqual(metadata["timestamp_ms"], "0")
        self.assertEqual(metadata["user"], "")
        self.assertEqual(metadata["missing"], ["version", "visible"])

    def test_missing_counts_are_independent_for_multiple_sources_and_targets(self):
        b=block()
        for identity, targets in ((10,[5,0,1]), (11,[5,2])):
            w=b.primitivegroup.add().ways.add(id=identity); w.refs.extend(targets)
        result=self.scan(pbf(b))
        self.assertEqual(result["references"]["way_node"]["total"], 5)
        self.assertEqual(result["references"]["way_node"]["missing_occurrences"], 5)
        self.assertEqual(result["references"]["way_node"]["distinct_targets"], 3)
        self.assertEqual(result["references"]["way_node"]["affected_sources"], 2)

    def test_independent_reader_rejects_missing_zstd_checksum_and_trailing_frames(self):
        from atlas_verification.records import inspect_object_stream
        b=block(); b.primitivegroup.add().nodes.add(id=1,lat=0,lon=0)
        self.scan(pbf(b))
        path=self.directory / "out" / "objects.jsonl.zst"
        encoded=path.read_bytes()
        for altered in (encoded[:-1], encoded+encoded, encoded+b"trailer"):
            with self.subTest(size=len(altered)):
                path.write_bytes(altered)
                with self.assertRaises((ValueError,zstandard.ZstdError)):
                    inspect_object_stream(path)

    def test_encoding_ceiling_returns_an_explicit_resource_failure(self):
        from unittest.mock import patch
        from atlas_verification import records
        b=block(); n=b.primitivegroup.add().nodes.add(id=1,lat=0,lon=0)
        n.keys.extend([1]*20); n.vals.extend([2]*20)
        with patch.object(records,"MAX_RECORD_BYTES",512):
            result=self.scan(pbf(b))
        self.assertEqual(result["status"],"operational_failed")
        self.assertFalse(result["outputs"])

    def test_wire_scalar_overflows_cannot_silently_truncate_into_valid_values(self):
        # Generated protobuf decoders truncate uint32 and over-wide varints;
        # raw wire validation must reject them before source values are lost.
        table=b"\x0a\x02\x0a\x00"
        malformed_nodes=(b"\x08\x02\x12\x05\x80\x80\x80\x80\x10\x1a\x01\x00\x40\x00\x48\x00",
                         b"\x08\x02\x40"+b"\x80"*9+b"\x02\x48\x00")
        for node in malformed_nodes:
            group=b"\x0a"+bytes([len(node)])+node
            primitive=table+b"\x12"+bytes([len(group)])+group
            self.assertEqual(self.scan(pbf()+frame("OSMData",primitive))["status"],"input_invalid")

    def test_selected_tag_and_relation_type_summaries_are_bounded(self):
        b=block(); b.stringtable.s.extend([b"highway",b"primary",b"type",b"multipolygon"])
        n=b.primitivegroup.add().nodes.add(id=1,lat=0,lon=0); n.keys.extend([5]); n.vals.extend([6])
        r=b.primitivegroup.add().relations.add(id=2); r.keys.extend([7,7]); r.vals.extend([8,8])
        result=self.scan(pbf(b))
        self.assertEqual(result["tag_summary"]["selected_keys"]["highway"]["values"],{"primary":1})
        self.assertEqual(result["tag_summary"]["selected_keys"]["type"]["occurrences"],2)
        self.assertEqual(result["relation_summary"]["types"]["values"],{"multipolygon":2})
        self.assertEqual(result["decoder_provenance"]["schema_git_blobs"]["osmformat.proto"],"311e8cef6d25db5883e35eff0c729cb73a9a38f0")

    def test_per_type_samples_reconcile_exact_hashes_and_bounded_previews(self):
        b=block(); b.stringtable.s.extend([("\u0646"*500).encode()])
        nodes=b.primitivegroup.add()
        for identity in range(1,6):
            node=nodes.nodes.add(id=identity,lat=identity,lon=-identity)
            if identity==1:
                node.info.uid=0; node.info.user_sid=5
                node.keys.extend([1]*6); node.vals.extend([5]*6)
        way=b.primitivegroup.add().ways.add(id=10); way.refs.extend([1,1,1,1,1])
        relation=b.primitivegroup.add().relations.add(id=20)
        relation.memids.extend([10,0,0,0,0]); relation.types.extend([1]*5); relation.roles_sid.extend([5]*5)
        result=self.scan(pbf(b))
        samples=result["source_samples"]
        self.assertEqual([sample["type"] for sample in samples],["node","way","relation"])
        self.assertEqual(samples,result["reread"]["samples"])
        self.assertEqual(samples[0]["preview"]["metadata"]["uid"],"0")
        self.assertEqual(samples[0]["preview"]["lat_nanodegrees"],"100")
        self.assertEqual(len(samples[0]["preview"]["tags"]),4)
        self.assertTrue(samples[0]["preview"]["tags"][0][1]["truncated"])
        self.assertEqual(samples[0]["preview"]["metadata"]["user"]["characters"],500)
        self.assertEqual(samples[1]["preview"]["refs"],["1","2","3","4"])
        self.assertEqual(len(samples[2]["preview"]["members"]),4)
        self.assertLess(len(json.dumps(samples)),10000)
        records=self.records()
        for sample in samples:
            data=(json.dumps(records[sample["ordinal"]-1],ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n").encode()
            self.assertEqual(sample["record_sha256"],hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    unittest.main()
