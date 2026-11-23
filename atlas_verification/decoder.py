"""Bounded official-proto2 OSM snapshot extraction and typed reference checks.

The caller owns a stable private spool, generation fencing, deadlines and total
disk accounting. ``progress`` is also the caller's lease/resource checkpoint.
No child tool runs alongside this pass. Mandatory Osmium reconciliation belongs
to the caller and must succeed before publishing a handoff.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import time
import zlib

import zstandard

from google.protobuf.message import DecodeError
from google.protobuf.descriptor import FieldDescriptor

from .proto import fileformat_pb2 as ff, osmformat_pb2 as osm
from .records import RecordWriter, canonical_line, inspect_object_stream, record_sample

MAX_BLOB = 32 * 1024 * 1024
MAX_SERIALIZED_BLOB = MAX_BLOB + 65536
MAX_PROTO_FIELDS = 1_000_000
INT64_MIN, INT64_MAX = -(1 << 63), (1 << 63) - 1
BATCH = 8192
REF_NAMES = ("way_node", "relation_node", "relation_way", "relation_relation")
REF_TARGET_TYPES = (0, 0, 1, 2)
REF_STRUCT = struct.Struct("<Bqq")
INFO_FIELDS = ("version", "timestamp", "changeset", "uid", "user_sid", "visible")
TYPE_NAMES = ("node", "way", "relation")
DECODER_PROVENANCE = {
    "upstream_revision": "9f01ad3ece9737503a059d58749e02c9008d5699",
    "schema_git_blobs": {"osmformat.proto": "311e8cef6d25db5883e35eff0c729cb73a9a38f0", "fileformat.proto": "7392143c46bf301a2452e06065e8ae8590bed163"},
    "schema_sha256": {"osmformat.proto": "5120dad564e717cf0b2bcf4b49d62c7180dc8b148084aa6b9f069a5e916027bc", "fileformat.proto": "eff8c3868b7fbf29a1ef9902933bd55a957c4e87ccfc490166fbe573ee173775"},
    "compiler": {"grpcio_tools": "1.78.0", "libprotoc": "31.1", "generated_python": "6.31.1"},
    "runtime_protobuf": "6.33.5", "record_schema_version": 1,
}


def _summary():
    return {"occurrences": 0, "values": {}, "omitted_value_occurrences": 0}


def _summarize(summary, value):
    summary["occurrences"] += 1
    values = summary["values"]
    if len(value) <= 128 and (value in values or len(values) < 64):
        values[value] = values.get(value, 0) + 1
    else:
        summary["omitted_value_occurrences"] += 1


class DecoderError(Exception):
    def __init__(self, code, message, category="input_invalid"):
        self.code, self.category = code, category
        super().__init__(message[:1000])


def require(condition, code, message, category="input_invalid"):
    if not condition:
        raise DecoderError(code, message, category)


def i64(value, what):
    require(INT64_MIN <= value <= INT64_MAX, "scalar_range", what + " exceeds signed 64-bit range")
    return value


def _wire_budget(raw, descriptor):
    """Bound message/string object overhead before allocating generated objects.

    Numeric packed arrays are bounded by the 32 MiB wire limit (at worst eight
    bytes of numeric storage per source byte). Message/string field counts are
    additionally capped to prevent tiny-message or empty-string amplification.
    The generated proto2 decoder remains the semantic source of truth.
    """
    view = memoryview(raw)
    remaining = MAX_PROTO_FIELDS

    def varint(position, end):
        value = 0
        for shift in range(0, 70, 7):
            require(position < end, "protobuf_malformed", "Truncated protobuf varint")
            byte = view[position]; position += 1
            require(shift != 63 or byte <= 1, "scalar_range", "Protobuf varint exceeds unsigned 64-bit range")
            value |= (byte & 127) << shift
            if not byte & 128:
                return value, position
        raise DecoderError("protobuf_malformed", "Oversized protobuf varint")

    def scalar(value, field):
        if field is None:
            return
        field_type = field.type
        if field_type in (FieldDescriptor.TYPE_UINT32, FieldDescriptor.TYPE_SINT32):
            require(value <= 4294967295, "scalar_range", "Protobuf uint32/sint32 value exceeds its source range")
        elif field_type in (FieldDescriptor.TYPE_INT32, FieldDescriptor.TYPE_ENUM):
            require(value <= 2147483647 or value >= 18446744071562067968, "scalar_range", "Protobuf int32 value exceeds its source range")
        elif field_type == FieldDescriptor.TYPE_BOOL:
            require(value in (0, 1), "scalar_range", "Protobuf boolean value is neither zero nor one")

    def inspect(start, end, desc, depth=0):
        nonlocal remaining
        require(depth <= 32, "protobuf_overhead_budget", "Protobuf nesting budget exhausted", "operational_failed")
        position = start
        fields = desc.fields_by_number
        while position < end:
            remaining -= 1
            require(remaining >= 0, "protobuf_overhead_budget", "Protobuf field/object overhead budget exhausted", "operational_failed")
            tag, position = varint(position, end)
            field, wire = tag >> 3, tag & 7
            known = fields.get(field)
            require(field > 0, "protobuf_malformed", "Zero protobuf field number")
            if wire == 0:
                value, position = varint(position, end)
                scalar(value, known)
            elif wire == 1:
                position += 8
            elif wire == 2:
                length, position = varint(position, end)
                finish = position + length
                require(finish <= end, "protobuf_malformed", "Protobuf field exceeds message length")
                if known is not None and known.message_type is not None:
                    inspect(position, finish, known.message_type, depth + 1)
                elif known is not None and known.is_repeated and known.type not in (FieldDescriptor.TYPE_STRING, FieldDescriptor.TYPE_BYTES):
                    packed_position = position
                    while packed_position < finish:
                        value, packed_position = varint(packed_position, finish)
                        scalar(value, known)
                position = finish
            elif wire == 5:
                position += 4
            elif wire in (3, 4):
                raise DecoderError("unknown_data_field", "Groups have no field in the supported OSM schema", "unsupported_profile")
            else:
                raise DecoderError("protobuf_malformed", "Invalid protobuf wire type")
            require(position <= end, "protobuf_malformed", "Protobuf scalar exceeds message length")

    inspect(0, len(raw), descriptor)


def _parse(raw, cls):
    _wire_budget(raw, cls.DESCRIPTOR)
    message = cls()
    try:
        message.ParseFromString(raw)
    except DecodeError as exc:
        raise DecoderError("protobuf_malformed", "Malformed " + cls.__name__) from exc
    require(message.IsInitialized(), "protobuf_required_field", "Missing required fields: " + ",".join(message.FindInitializationErrors())[:500])
    before = message.ByteSize()
    message.DiscardUnknownFields()
    require(message.ByteSize() == before, "unknown_data_field", "Unhandled data-bearing field in " + cls.__name__, "unsupported_profile")
    return message


def _exact(stream, size):
    data = stream.read(size)
    require(len(data) == size, "truncated_framing", "PBF framing ended before declared length")
    return data


def _blocks(path, progress):
    offset, expanded, block_number = 0, 0, 0
    with Path(path).open("rb") as stream:
        while True:
            prefix = stream.read(4)
            if not prefix:
                return
            require(len(prefix) == 4, "truncated_framing", "Truncated BlobHeader size")
            header_size = struct.unpack(">I", prefix)[0]
            require(0 < header_size < 65536, "blob_header_size", "BlobHeader must be below 64 KiB")
            header = _parse(_exact(stream, header_size), ff.BlobHeader)
            require(0 < header.datasize <= MAX_SERIALIZED_BLOB, "blob_serialized_size", "Serialized Blob exceeds bounded input size")
            blob = _parse(_exact(stream, header.datasize), ff.Blob)
            encoding = blob.WhichOneof("data")
            if encoding == "raw":
                raw = blob.raw
                require(not blob.HasField("raw_size") or blob.raw_size == len(raw), "raw_size_mismatch", "Raw size differs from declared raw_size")
            elif encoding == "zlib_data":
                require(blob.HasField("raw_size") and 0 <= blob.raw_size < MAX_BLOB, "raw_size_invalid", "Compressed Blob requires raw_size below 32 MiB")
                try:
                    decoder = zlib.decompressobj()
                    raw = decoder.decompress(blob.zlib_data, MAX_BLOB)
                    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, "zlib_termination", "Zlib stream must terminate exactly with no trailing data")
                except zlib.error as exc:
                    raise DecoderError("zlib_invalid", "Invalid zlib stream") from exc
                require(len(raw) == blob.raw_size, "raw_size_mismatch", "Expanded Blob differs from declared raw_size")
            else:
                raise DecoderError("unsupported_compression", "Unsupported Blob compression: " + str(encoding), "unsupported_profile")
            require(len(raw) < MAX_BLOB, "blob_raw_size", "Decompressed Blob must be below 32 MiB")
            block_number += 1
            expanded += len(raw)
            # A finite cumulative expansion guard also bounds pathological inputs
            # that contain millions of empty blocks; the worker has tighter disk
            # and execution caps and checks them through every progress callback.
            require(expanded <= 256 * 1024 ** 3 and block_number <= 4_000_000, "expansion_budget", "Cumulative PBF expansion budget exhausted", "operational_failed")
            progress({"phase": "decode", "input_bytes": offset, "expanded_bytes": expanded, "blocks": block_number})
            yield block_number, header, raw, encoding
            offset += 4 + header_size + header.datasize


class _Checkpoint:
    def __init__(self, callback):
        self.callback, self.last = callback, 0.0

    def __call__(self, update, force=False):
        now = time.monotonic()
        if force or now - self.last >= 1.0:
            self.last = now
            self.callback(update)


class _Index:
    def __init__(self, directory, progress):
        self.path = directory / "identities.sqlite3"
        self.refs_path = directory / "references.bin"
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA journal_mode=OFF")
        self.db.execute("PRAGMA synchronous=OFF")
        self.db.execute("PRAGMA cache_size=-32768")
        self.db.execute("PRAGMA temp_store=FILE")
        self.db.execute("CREATE TABLE identities(kind INTEGER, id INTEGER, PRIMARY KEY(kind,id)) WITHOUT ROWID")
        self.refs_file = self.refs_path.open("wb")
        self.pending, self.ref_buffer, self.progress = [], bytearray(), progress
        self.findings = {name: {"total": 0, "missing_occurrences": 0, "distinct_targets": 0, "affected_sources": 0, "samples": []} for name in REF_NAMES}

    def add(self, kind, identity):
        self.pending.append((kind, identity))
        if len(self.pending) >= BATCH:
            self.flush()

    def ref(self, kind, source, target):
        self.findings[REF_NAMES[kind]]["total"] += 1
        self.ref_buffer.extend(REF_STRUCT.pack(kind, source, target))
        if len(self.ref_buffer) >= BATCH * REF_STRUCT.size:
            self.refs_file.write(self.ref_buffer)
            self.ref_buffer.clear()

    def flush(self):
        if self.pending:
            try:
                self.db.executemany("INSERT INTO identities VALUES (?,?)", self.pending)
            except sqlite3.IntegrityError as exc:
                raise DecoderError("duplicate_typed_identity", "Duplicate typed identity in a snapshot") from exc
            self.pending.clear()
        self.db.commit()
        self.progress({"phase": "identity_index"})

    def check(self):
        self.flush()
        self.refs_file.write(self.ref_buffer); self.ref_buffer.clear(); self.refs_file.close()
        self.db.execute("CREATE TEMP TABLE reference_batch(class INTEGER, kind INTEGER, source INTEGER, target INTEGER)")
        self.db.execute("CREATE TABLE missing_targets(class INTEGER,id INTEGER,PRIMARY KEY(class,id)) WITHOUT ROWID")
        self.db.execute("CREATE TABLE missing_sources(class INTEGER,id INTEGER,PRIMARY KEY(class,id)) WITHOUT ROWID")
        inspected = 0
        with self.refs_path.open("rb") as source:
            while chunk := source.read(BATCH * REF_STRUCT.size):
                rows = [(cls, REF_TARGET_TYPES[cls], src, dst) for cls, src, dst in REF_STRUCT.iter_unpack(chunk)]
                self.db.execute("DELETE FROM reference_batch")
                self.db.executemany("INSERT INTO reference_batch VALUES (?,?,?,?)", rows)
                missing = self.db.execute("SELECT class,source,target FROM reference_batch r WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.kind=r.kind AND i.id=r.target)").fetchall()
                for cls, src, dst in missing:
                    finding = self.findings[REF_NAMES[cls]]
                    finding["missing_occurrences"] += 1
                    if len(finding["samples"]) < 10:
                        finding["samples"].append({"source_id": str(src), "target_id": str(dst)})
                self.db.executemany("INSERT OR IGNORE INTO missing_targets VALUES (?,?)", ((cls, dst) for cls, src, dst in missing))
                self.db.executemany("INSERT OR IGNORE INTO missing_sources VALUES (?,?)", ((cls, src) for cls, src, dst in missing))
                inspected += len(rows)
                self.db.commit()
                self.progress({"phase": "reference_check", "references_inspected": inspected})
        for table, key in (("missing_targets", "distinct_targets"), ("missing_sources", "affected_sources")):
            for cls, count in self.db.execute("SELECT class,count(*) FROM " + table + " GROUP BY class"):
                self.findings[REF_NAMES[cls]][key] = count
        self.progress({"phase": "reference_check", "references_inspected": inspected}, force=True)
        return self.findings

    def close(self):
        self.db.close()
        self.refs_file.close()
        self.path.unlink(missing_ok=True)
        self.refs_path.unlink(missing_ok=True)


def _string(strings, index):
    require(0 <= index < len(strings), "string_table_index", "String-table index is out of range")
    return strings[index]


def _tags(message, strings):
    require(len(message.keys) == len(message.vals), "tag_cardinality", "Tag key/value arrays differ in length")
    require(len(message.keys) <= 1_000_000, "record_overhead_budget", "Object tag collection exceeds bounded allocation budget", "operational_failed")
    return [[_string(strings, key), _string(strings, value)] for key, value in zip(message.keys, message.vals)]


def _metadata(info, strings, date_granularity, present=True, dense_values=None):
    available = dense_values if dense_values is not None else {name: getattr(info, name) for name in INFO_FIELDS if present and info.HasField(name)}
    require("visible" not in available, "history_shape", "Visible flags require history/deletion support", "unsupported_profile")
    result = {"present": present, "missing": [field for field in INFO_FIELDS if field not in available]}
    for field, value in available.items():
        if field == "timestamp":
            result["timestamp_ticks"] = str(i64(value, "Timestamp ticks"))
            result["timestamp_ms"] = str(value * date_granularity)
        elif field == "user_sid":
            result["user_sid"] = str(value)
            result["user"] = _string(strings, value)
        else:
            if field == "version":
                require(value > 0, "snapshot_version", "Present snapshot versions must be positive")
            elif field in ("changeset", "uid"):
                require(value >= 0, "metadata_range", field + " cannot be negative")
            result[field] = str(value)
    return result


def _coordinate(raw, offset, granularity, latitude):
    value = i64(offset + granularity * raw, "Coordinate")
    maximum = 90_000_000_000 if latitude else 180_000_000_000
    require(-maximum <= value <= maximum, "coordinate_range", "Coordinate outside longitude/latitude range")
    return str(value)


def _delta(values, what):
    current = 0
    for value in values:
        current = i64(current + value, what)
        yield current


def _objects(block, strings, required, optional):
    gran, date, lato, lono = block.granularity, block.date_granularity, block.lat_offset, block.lon_offset
    require(gran > 0 and date > 0, "granularity_range", "Coordinate and date granularities must be positive")
    object_count = sum(len(group.nodes) + len(group.ways) + len(group.relations) + (len(group.dense.id) if group.HasField("dense") else 0) for group in block.primitivegroup)
    require(object_count <= 1_000_000 and len(strings) <= 1_000_000, "protobuf_overhead_budget", "Block object/string overhead exceeds accepted resource budget", "operational_failed")
    for group in block.primitivegroup:
        require(not group.changesets, "changeset_primitive", "ChangeSet primitives have no faithful object-output contract", "unsupported_profile")
        kinds = bool(group.nodes) + bool(group.dense.id) + bool(group.ways) + bool(group.relations)
        require(kinds <= 1, "mixed_primitive_group", "PrimitiveGroup contains multiple object types")
        for node in group.nodes:
            yield 0, node.id, {"tags": _tags(node, strings), "metadata": _metadata(node.info, strings, date, node.HasField("info")), "encoded_lat": str(node.lat), "encoded_lon": str(node.lon), "lat_nanodegrees": _coordinate(node.lat, lato, gran, True), "lon_nanodegrees": _coordinate(node.lon, lono, gran, False)}
        if group.HasField("dense"):
            require("DenseNodes" in required, "dense_feature_missing", "DenseNodes data lacks its required feature declaration")
            dense = group.dense
            count = len(dense.id)
            require(len(dense.lat) == count == len(dense.lon), "dense_cardinality", "Dense ID/latitude/longitude arrays differ in length")
            present = dense.HasField("denseinfo")
            metadata_arrays = {field: getattr(dense.denseinfo, field) for field in INFO_FIELDS if len(getattr(dense.denseinfo, field))} if present else {}
            require(all(len(values) == count for values in metadata_arrays.values()), "dense_metadata_cardinality", "Dense metadata arrays must be absent or aligned")
            accumulators = dict.fromkeys(("timestamp", "changeset", "uid", "user_sid"), 0)
            tags_position = 0
            for position, (identity, lat, lon) in enumerate(zip(_delta(dense.id, "Dense ID"), _delta(dense.lat, "Dense latitude"), _delta(dense.lon, "Dense longitude"))):
                tags = []
                if dense.keys_vals:
                    while True:
                        require(tags_position < len(dense.keys_vals), "dense_tag_delimiter", "Dense tags lack a node delimiter")
                        key = dense.keys_vals[tags_position]; tags_position += 1
                        if key == 0:
                            break
                        require(tags_position < len(dense.keys_vals), "dense_tag_cardinality", "Dense tags lack a value")
                        value = dense.keys_vals[tags_position]; tags_position += 1
                        tags.append([_string(strings, key), _string(strings, value)])
                        require(len(tags) <= 1_000_000, "record_overhead_budget", "Dense node tag collection exceeds bounded allocation budget", "operational_failed")
                available = {}
                for field, array in metadata_arrays.items():
                    value = array[position]
                    if field in accumulators:
                        value = i64(accumulators[field] + value, "Dense " + field)
                        accumulators[field] = value
                        if field == "uid":
                            require(value <= 2147483647, "metadata_range", "Dense uid exceeds int32 range")
                        if field == "user_sid":
                            require(value <= 4294967295, "metadata_range", "Dense user_sid exceeds uint32 range")
                    available[field] = value
                yield 0, identity, {"tags": tags, "metadata": _metadata(None, strings, date, present, available), "encoded_lat": str(lat), "encoded_lon": str(lon), "lat_nanodegrees": _coordinate(lat, lato, gran, True), "lon_nanodegrees": _coordinate(lon, lono, gran, False)}
            require(tags_position == len(dense.keys_vals), "dense_tag_surplus", "Dense tag data remains after the final node")
        for way in group.ways:
            require(len(way.refs) <= 1_000_000, "record_overhead_budget", "Way reference collection exceeds bounded allocation budget", "operational_failed")
            refs = [str(value) for value in _delta(way.refs, "Way node reference")]
            require(all(int(value) > 0 for value in refs), "reference_range", "Snapshot references must be positive")
            locations = None
            if way.lat or way.lon:
                require("LocationsOnWays" in optional, "way_locations_feature_missing", "Way locations lack their optional feature declaration")
                require(len(way.lat) == len(way.lon) == len(refs), "way_locations_cardinality", "Way location arrays must align with references")
                locations = [{"lat_nanodegrees": _coordinate(lat, lato, gran, True), "lon_nanodegrees": _coordinate(lon, lono, gran, False)} for lat, lon in zip(_delta(way.lat, "Way latitude"), _delta(way.lon, "Way longitude"))]
            yield 1, way.id, {"tags": _tags(way, strings), "metadata": _metadata(way.info, strings, date, way.HasField("info")), "refs": refs, "locations": locations}
        for relation in group.relations:
            require(len(relation.memids) == len(relation.types) == len(relation.roles_sid), "relation_cardinality", "Relation member arrays differ in length")
            require(len(relation.memids) <= 250_000, "record_overhead_budget", "Relation member collection exceeds bounded allocation budget", "operational_failed")
            members = []
            for identity, kind, role in zip(_delta(relation.memids, "Relation member reference"), relation.types, relation.roles_sid):
                require(kind in (0, 1, 2), "relation_member_type", "Unrecognized relation member type")
                require(identity > 0, "reference_range", "Snapshot references must be positive")
                members.append({"type": TYPE_NAMES[kind], "id": str(identity), "role": _string(strings, role)})
            yield 2, relation.id, {"tags": _tags(relation, strings), "metadata": _metadata(relation.info, strings, date, relation.HasField("info")), "members": members}


def _header(message):
    require(len(message.required_features) <= 128 and len(message.optional_features) <= 128 and all(len(value) <= 512 for value in (*message.required_features, *message.optional_features)), "header_feature_budget", "Header feature list exceeds bounded report budget", "operational_failed")
    result = {"required_features": list(message.required_features), "optional_features": list(message.optional_features), "missing": []}
    for field in ("writingprogram", "source", "osmosis_replication_timestamp", "osmosis_replication_sequence_number", "osmosis_replication_base_url"):
        if message.HasField(field):
            value = getattr(message, field)
            require(not isinstance(value, str) or len(value) <= 8192, "header_metadata_budget", "Header metadata exceeds bounded report budget", "operational_failed")
            result[field] = str(value) if isinstance(value, int) else value
        else:
            result["missing"].append(field)
    if message.HasField("bbox"):
        box = message.bbox
        require(-180000000000 <= box.left <= box.right <= 180000000000 and -90000000000 <= box.bottom <= box.top <= 90000000000, "header_bounds", "Header bounding box is outside coordinate limits")
        result["bbox_nanodegrees"] = {key: str(getattr(box, key)) for key in ("left", "right", "top", "bottom")}
    else:
        result["missing"].append("bbox")
    return result


def scan_pbf(input_path: Path, output_dir: Path, progress=lambda update: None) -> dict:
    """Extract a stable PBF spool; return structured results for expected failures."""
    output_dir = Path(output_dir)
    checkpoint = _Checkpoint(progress)
    result = {"schema_version": 1, "decoder_provenance": DECODER_PROVENANCE, "status": "input_invalid", "reasons": [], "counts": {"nodes": 0, "ways": 0, "relations": 0}, "tags": {"nodes": 0, "ways": 0, "relations": 0}, "outputs": [], "completed_checks": [], "empty": True,
              "supported_profile": {"schema": "OSM-v0.6-snapshot", "compression": ["raw", "zlib"], "metadata_presence": "explicit; repeated empty/absent indistinguishable", "coordinate_units": "integer_nanodegrees", "timestamp_units": "integer_milliseconds", "redaction_policy": "provider-source policy retained in acquisition provenance"}}
    index = writer = blocks_writer = None
    try:
        index = _Index(output_dir, checkpoint)
        writer = RecordWriter(output_dir / "objects.jsonl.zst")
        blocks_writer = RecordWriter(output_dir / "blocks.jsonl.zst")
        required, optional, ordinal, data_blocks, last_kind = set(), set(), 0, 0, -1
        last_ids, ordering = {}, {"type_ordered": True, "id_ordered": True}
        bounds, timestamp_bounds = None, {}
        summaries, tag_keys, roles, auxiliary = Counter(), Counter(), Counter(), []
        selected_keys = {key: _summary() for key in ("name", "highway", "type", "boundary", "route")}
        relation_types = _summary()
        omitted_tag_keys = omitted_roles = 0
        header_seen = False
        source_samples = []
        sampled_types = set()
        for block_number, blob_header, raw, encoding in _blocks(input_path, checkpoint):
            if blob_header.type == "OSMHeader":
                require(not header_seen and block_number == 1, "header_order", "Exactly one OSMHeader must be the first block")
                message = _parse(raw, osm.HeaderBlock)
                result["header"] = _header(message)
                header_seen = True
                required, optional = set(message.required_features), set(message.optional_features)
                require("OsmSchema-V0.6" in required, "schema_feature_missing", "OsmSchema-V0.6 is required")
                unknown = required - {"OsmSchema-V0.6", "DenseNodes"}
                require(not unknown, "required_feature_unsupported", "Unsupported required features: " + ",".join(sorted(unknown))[:500], "unsupported_profile")
                continue
            require(header_seen, "header_missing", "PBF begins without OSMHeader")
            if blob_header.type != "OSMData":
                require(not blob_header.type.startswith("_"), "reserved_block_type", "Reserved auxiliary block type", "unsupported_profile")
                require(len(auxiliary) < 100, "auxiliary_block_budget", "Auxiliary block summary budget exhausted", "operational_failed")
                require(len(blob_header.type) <= 512, "auxiliary_type_budget", "Auxiliary type name exceeds bounded report budget", "operational_failed")
                auxiliary.append({"block": block_number, "type": blob_header.type, "raw_size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
                continue
            block = _parse(raw, osm.PrimitiveBlock)
            try:
                strings = [value.decode("utf-8", "strict") for value in block.stringtable.s]
            except UnicodeDecodeError as exc:
                raise DecoderError("invalid_text_encoding", "String table contains invalid UTF-8") from exc
            require(strings and strings[0] == "", "string_table_zero", "String table entry zero must be the empty string")
            if any("\0" in value for value in strings):
                result["osmium_scalar_presentation"] = True
            data_blocks += 1
            block_record = {"schema_version": 1, "block": block_number, "encoding": encoding, "raw_size": len(raw), "missing": []}
            for field in ("granularity", "date_granularity", "lat_offset", "lon_offset"):
                block_record[field] = str(getattr(block, field))
                if not block.HasField(field):
                    block_record["missing"].append(field)
            if blob_header.HasField("indexdata"):
                # The index is opaque specification-permitted metadata.
                block_record["indexdata_hex"] = blob_header.indexdata.hex()
            blocks_writer.write(block_record)
            for kind, identity, fields in _objects(block, strings, required, optional):
                require(identity > 0, "identity_range", "Snapshot identities must be positive signed 64-bit values")
                i64(identity, "Object identity")
                index.add(kind, identity)
                ordinal += 1
                key = TYPE_NAMES[kind] + "s"
                result["counts"][key] += 1
                result["tags"][key] += len(fields["tags"])
                for tag_key, tag_value in fields["tags"]:
                    if len(tag_key) <= 128 and (tag_key in tag_keys or len(tag_keys) < 64):
                        tag_keys[tag_key] += 1
                    else:
                        omitted_tag_keys += 1
                    if tag_key in selected_keys:
                        _summarize(selected_keys[tag_key], tag_value)
                    if kind == 2 and tag_key == "type":
                        _summarize(relation_types, tag_value)
                ordering["type_ordered"] &= kind >= last_kind
                ordering["id_ordered"] &= identity > last_ids.get(kind, -1)
                last_kind, last_ids[kind] = kind, identity
                record = {"schema_version": 1, "type": TYPE_NAMES[kind], "id": str(identity), "ordinal": ordinal, "block": block_number, **fields}
                if kind not in sampled_types:
                    source_samples.append(record_sample(record, canonical_line(record)))
                    sampled_types.add(kind)
                writer.write(record)
                if kind == 0:
                    lat, lon = int(fields["lat_nanodegrees"]), int(fields["lon_nanodegrees"])
                    bounds = [lat, lon, lat, lon] if bounds is None else [min(bounds[0], lat), min(bounds[1], lon), max(bounds[2], lat), max(bounds[3], lon)]
                elif kind == 1:
                    for target in fields["refs"]:
                        index.ref(0, identity, int(target))
                else:
                    for member in fields["members"]:
                        index.ref(TYPE_NAMES.index(member["type"]) + 1, identity, int(member["id"]))
                        # A bounded summary cannot be keyed by arbitrary source roles.
                        summaries["member_" + member["type"]] += 1
                        role = member["role"]
                        if len(role) <= 128 and (role in roles or len(roles) < 64):
                            roles[role] += 1
                        else:
                            omitted_roles += 1
                metadata = fields["metadata"]
                if "timestamp_ms" in metadata:
                    value = int(metadata["timestamp_ms"])
                    previous = timestamp_bounds.get(key)
                    timestamp_bounds[key] = [value, value] if previous is None else [min(previous[0], value), max(previous[1], value)]
                if ordinal % 4096 == 0:
                    checkpoint({"phase": "decode", "records": ordinal, "counts": dict(result["counts"])})
        require(header_seen, "header_missing", "Empty bytes are not a valid PBF snapshot")
        writer.close(); blocks_writer.close()
        result["outputs"] = [writer.descriptor(), blocks_writer.descriptor()]
        result["completed_checks"].extend(["complete_framing", "protobuf_required_fields", "snapshot_semantics", "exact_object_extraction"])
        result["references"] = index.check()
        result["completed_checks"].extend(["typed_identity_uniqueness", "complete_typed_references"])
        result["ordering"] = ordering
        result["auxiliary_blocks"] = auxiliary
        result["data_blocks"] = data_blocks
        result["bounds_nanodegrees"] = None if bounds is None else dict(zip(("min_lat", "min_lon", "max_lat", "max_lon"), map(str, bounds)))
        result["object_timestamp_bounds_ms"] = {key: {"min": str(value[0]), "max": str(value[1])} for key, value in timestamp_bounds.items()}
        result["relation_summary"] = dict(summaries)
        result["relation_summary"]["roles"] = dict(roles)
        result["relation_summary"]["omitted_role_occurrences"] = omitted_roles
        result["relation_summary"]["types"] = relation_types
        result["tag_summary"] = {"selected_keys": selected_keys, "bounded_key_occurrences": dict(tag_keys), "omitted_key_occurrences": omitted_tag_keys, "policy": "first_64_keys_and_64_values_per_selected_key_up_to_128_characters"}
        result["source_samples"] = source_samples
        result["reread"] = inspect_object_stream(output_dir / "objects.jsonl.zst", checkpoint)
        reread, descriptor = result["reread"], writer.descriptor()
        require(reread["counts"] == result["counts"] and reread["tags"] == result["tags"] and reread["samples"] == source_samples and reread["uncompressed_sha256"] == descriptor["uncompressed_sha256"] and reread["uncompressed_size"] == descriptor["uncompressed_size"] and reread["sha256"] == descriptor["sha256"] and reread["size"] == descriptor["size"] and all(reread["references"][name] == finding["total"] for name, finding in result["references"].items()), "output_reconciliation", "Independent output stream does not reconcile", "operational_failed")
        result["completed_checks"].append("independent_full_output_reread")
        result["empty"] = ordinal == 0
        result["status"] = "verified"
        if result["empty"]:
            result["reasons"].append({"code": "valid_empty_snapshot", "message": "Snapshot is valid and empty; build eligibility remains false"})
        for name, finding in result["references"].items():
            if finding["missing_occurrences"]:
                result["status"] = "input_invalid" if name == "way_node" else ("verified_with_warnings" if result["status"] == "verified" else result["status"])
                result["reasons"].append({"code": "missing_" + name, "message": str(finding["missing_occurrences"]) + " missing typed reference occurrences", "severity": "blocking" if name == "way_node" else "warning"})
    except DecoderError as exc:
        result["status"] = exc.category
        result["reasons"].append({"code": exc.code, "message": str(exc)})
    except (OSError, sqlite3.Error, MemoryError, ValueError, zstandard.ZstdError) as exc:
        result["status"] = "operational_failed"
        result["reasons"].append({"code": "decoder_operational", "message": (type(exc).__name__ + ": " + str(exc))[:1000]})
    finally:
        result["empty"] = sum(result["counts"].values()) == 0
        for stream in (writer, blocks_writer):
            if stream is not None:
                stream.close()
        if index is not None:
            index.close()
        checkpoint({"phase": "decoder_finished", "status": result["status"], "counts": result["counts"]}, force=True)
    return result
