"""Version 1 deterministic JSONL/Zstd encoding and an independent full reader.

Integer source values are decimal strings. Counts and ordinals fit the bounded
processing contract. A metadata ``missing`` array records field absence; a
present empty Info is distinct from no Info. Repeated proto2 fields preserve
their values and order, since proto2 has no empty/absent repeated distinction.
"""
import hashlib
import io
import json
from pathlib import Path

import zstandard

SCHEMA_VERSION = 1
MAX_RECORD_BYTES = 32 * 1024 * 1024
KINDS = ("node", "way", "relation")


def _preview_text(value):
    if len(value) <= 128:
        return value
    return {"prefix": value[:128], "characters": len(value), "truncated": True}


def record_sample(record, full_line):
    """Bounded display of a complete record whose SHA covers all source values.

    Array previews retain the first four entries. Long text is an exact prefix
    with an explicit truncation marker; complete text stays in the object file.
    Both callers supply their own complete record and independently obtained
    canonical bytes: source extraction before writing, JSON reader after EOF.
    """
    preview = {
        "metadata": {key: _preview_text(value) if isinstance(value, str) else value
                     for key, value in record["metadata"].items()},
        "tags": [[_preview_text(key), _preview_text(value)] for key, value in record["tags"][:4]],
        "tags_count": len(record["tags"]),
    }
    for key in ("encoded_lat", "encoded_lon", "lat_nanodegrees", "lon_nanodegrees"):
        if key in record:
            preview[key] = record[key]
    if record["type"] == "way":
        preview["refs"] = record["refs"][:4]
        preview["refs_count"] = len(record["refs"])
        preview["locations"] = None if record["locations"] is None else record["locations"][:4]
    elif record["type"] == "relation":
        preview["members"] = [{"type": member["type"], "id": member["id"], "role": _preview_text(member["role"])} for member in record["members"][:4]]
        preview["members_count"] = len(record["members"])
    return {"ordinal": record["ordinal"], "type": record["type"], "id": record["id"],
            "record_sha256": hashlib.sha256(full_line).hexdigest(), "preview": preview}


def canonical_line(record):
    # The C encoder is substantially faster on the normal small records. This
    # conservative upper bound includes JSON's worst-case six-byte escaping and
    # all variable source fields. Large records use an incremental encoder so a
    # repeated long tag/user/role cannot allocate an unbounded serialized blob.
    maximum = 4096
    maximum += sum(16 + 6 * (len(key) + len(value)) for key, value in record.get("tags", ()))
    maximum += 6 * len(record.get("metadata", {}).get("user", ""))
    maximum += 24 * len(record.get("refs", ()))
    maximum += 128 * len(record.get("locations") or ())
    maximum += sum(128 + 6 * len(member["role"]) for member in record.get("members", ()))
    maximum += 6 * len(record.get("indexdata_hex", ""))
    options = {"ensure_ascii": False, "sort_keys": True, "separators": (",", ":"), "allow_nan": False}
    if maximum < MAX_RECORD_BYTES:
        data = (json.dumps(record, **options) + "\n").encode("utf-8")
    else:
        bounded = bytearray()
        for chunk in json.JSONEncoder(**options).iterencode(record):
            encoded = chunk.encode("utf-8")
            if len(bounded) + len(encoded) + 1 >= MAX_RECORD_BYTES:
                raise ValueError("JSON record reaches the 32 MiB encoding ceiling")
            bounded.extend(encoded)
        bounded.extend(b"\n")
        data = bytes(bounded)
    if len(data) >= MAX_RECORD_BYTES:
        raise ValueError("JSON record reaches the 32 MiB encoding ceiling")
    return data


class _HashSink:
    def __init__(self, stream):
        self.stream, self.digest, self.size = stream, hashlib.sha256(), 0

    def write(self, data):
        self.digest.update(data)
        self.size += len(data)
        return self.stream.write(data)

    def flush(self):
        self.stream.flush()


class RecordWriter:
    def __init__(self, path):
        self.path = Path(path)
        self.file = self.path.open("wb")
        self.sink = _HashSink(self.file)
        self.stream = zstandard.ZstdCompressor(level=3, threads=0, write_checksum=True, write_content_size=False).stream_writer(self.sink, closefd=False)
        self.digest, self.size, self.count = hashlib.sha256(), 0, 0

    def write(self, record):
        data = canonical_line(record)
        self.digest.update(data)
        self.size += len(data)
        self.count += 1
        self.stream.write(data)

    def close(self):
        if not self.file.closed:
            self.stream.close()
            self.file.close()

    def descriptor(self):
        return {"path": self.path.name, "sha256": self.sink.digest.hexdigest(), "size": self.sink.size,
                "count": self.count, "encoding": "jsonl+zstd", "schema_version": SCHEMA_VERSION,
                "uncompressed_sha256": self.digest.hexdigest(), "uncompressed_size": self.size,
                "compression": {"algorithm": "zstd", "level": 3, "threads": 0, "checksum": True}}


def _strict_frame_identity(path, progress):
    # stream_reader returns clean EOF for some truncated frames. A separate
    # incremental frame check must observe eof and prohibit trailing bytes.
    # A 1024-byte compressed feed also bounds worst-case RLE expansion to 32 MiB.
    decoder = zstandard.ZstdDecompressor(max_window_size=64 * 1024 * 1024).decompressobj()
    digest, size, chunks = hashlib.sha256(), 0, 0
    with Path(path).open("rb") as source:
        while chunk := source.read(1024):
            if decoder.eof:
                raise ValueError("Output has bytes after its single Zstd frame")
            digest.update(chunk); size += len(chunk); chunks += 1
            decoder.decompress(chunk)
            if decoder.unused_data:
                raise ValueError("Output has trailing data after its Zstd frame")
            if chunks % 64 == 0:
                progress({"phase": "output_frame_check", "compressed_bytes": size})
    if not decoder.eof:
        raise ValueError("Output Zstd frame is truncated")
    progress({"phase": "output_frame_check", "compressed_bytes": size})
    return {"sha256": digest.hexdigest(), "size": size}


def inspect_object_stream(path, progress=lambda update: None):
    """Read every emitted record using JSON and Zstd, independent of protobuf.

    This reader checks source ordinals, field presence, counts, tag and reference
    cardinalities and exact stream digest. It never imports the source decoder.
    """
    counts = {"nodes": 0, "ways": 0, "relations": 0}
    tags = dict.fromkeys(counts, 0)
    refs = dict.fromkeys(("way_node", "relation_node", "relation_way", "relation_relation"), 0)
    digest, size, ordinal, samples = hashlib.sha256(), 0, 0, []
    sampled_types = set()
    with Path(path).open("rb") as source, zstandard.ZstdDecompressor(max_window_size=64 * 1024 * 1024).stream_reader(source) as decoded:
        buffered = io.BufferedReader(decoded)
        while True:
            line = buffered.readline(MAX_RECORD_BYTES)
            if not line:
                break
            if len(line) >= MAX_RECORD_BYTES or not line.endswith(b"\n"):
                raise ValueError("Output contains an oversized or unterminated JSONL record")
            digest.update(line); size += len(line)
            record = json.loads(line)
            ordinal += 1
            if record["schema_version"] != 1 or record["ordinal"] != ordinal or record["type"] not in KINDS:
                raise ValueError("Output schema, type or ordinal does not reconcile")
            if not isinstance(record["id"], str) or str(int(record["id"])) != record["id"]:
                raise ValueError("Output ID does not round-trip as a decimal string")
            key = record["type"] + "s"
            counts[key] += 1
            tags[key] += len(record["tags"])
            if record["type"] == "way":
                refs["way_node"] += len(record["refs"])
            elif record["type"] == "relation":
                for member in record["members"]:
                    refs["relation_" + member["type"]] += 1
            if record["type"] not in sampled_types:
                samples.append(record_sample(record, line))
                sampled_types.add(record["type"])
            if ordinal % 4096 == 0:
                progress({"phase": "output_reread", "records": ordinal, "uncompressed_bytes": size})
    progress({"phase": "output_reread", "records": ordinal, "uncompressed_bytes": size})
    frame_identity = _strict_frame_identity(path, progress)
    return {"counts": counts, "tags": tags, "references": refs, "count": ordinal, "uncompressed_sha256": digest.hexdigest(), "uncompressed_size": size, "samples": samples, **frame_identity}
