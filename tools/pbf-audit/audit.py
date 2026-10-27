#!/usr/bin/env python3
"""Read-only, two-pass OSM snapshot audit using libosmium, not a custom PBF parser.

No URLs from a file header are fetched. Object handles never leave a callback.
Identifiers remain integers; unsupported Lua number ranges are rejected before import.
Digests cover ordered source semantics; tags are canonicalized, reference order is retained.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
import time

import osmium

KINDS = ("node", "way", "relation")
EXAMPLE_LIMIT = 20
# Rendering catalog v1 uses id*10 + type (1..3) as a JavaScript-exact MVT ID.
MAX_OSM_ID = (9007199254740991 - 3) // 10


def file_hash(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_record(kind: str, obj) -> list:
    timestamp = obj.timestamp.isoformat().replace("+00:00", "Z")
    metadata = [obj.version or None, timestamp if obj.timestamp.year > 1970 else None,
                obj.changeset or None, obj.uid or None, obj.user or None, obj.visible]
    # int32 coordinate units preserve OSM's 1e-7 degree precision.
    if kind == "node":
        content = [obj.location.x, obj.location.y] if obj.location.valid() else None
    elif kind == "way":
        content = [n.ref for n in obj.nodes]
    else:
        content = [[m.type, m.ref, m.role] for m in obj.members]
    return [obj.id, metadata, sorted((t.k, t.v) for t in obj.tags), content]


class Inventory(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ids = {kind: osmium.index.IdSet() for kind in KINDS}
        self.counts = Counter()
        self.tagged = Counter()
        self.tag_keys = Counter()
        self.relation_types = Counter()
        self.digests = {kind: hashlib.sha256() for kind in KINDS}
        self.last_kind = -1
        self.last_id = {kind: 0 for kind in KINDS}
        self.ordered = True
        self.invalid_locations = 0
        self.bbox = [180.0, 90.0, -180.0, -90.0]
        self.timestamps = [None, None]
        self.metadata = {field: Counter() for field in ("version", "timestamp", "changeset", "uid", "user")}

    def observe(self, kind: str, obj):
        if obj.id <= 0 or not obj.visible:
            raise ValueError("only positive-id, visible current snapshots are accepted")
        if obj.id > MAX_OSM_ID:
            raise ValueError("object ID exceeds the reviewed importer/MVT exact number range")
        if obj.id in self.ids[kind]:
            raise ValueError(f"duplicate {kind} id {obj.id}; history/multiple versions are unsupported")
        order = KINDS.index(kind)
        self.ordered &= order >= self.last_kind and obj.id > self.last_id[kind]
        self.last_kind = order
        self.last_id[kind] = obj.id
        self.ids[kind].set(obj.id)
        self.counts[kind] += 1
        if len(obj.tags):
            self.tagged[kind] += 1
        self.tag_keys.update(t.k for t in obj.tags)
        record = canonical_record(kind, obj)
        if len({tag[0] for tag in record[2]}) != len(record[2]):
            raise ValueError('duplicate tag keys cannot be archived faithfully as a JSONB object')
        references = record[3] if kind == 'way' else [m[1] for m in record[3]] if kind == 'relation' else []
        if any(ref <= 0 or ref > MAX_OSM_ID for ref in references):
            raise ValueError('reference ID is outside the supported exact positive integer range')
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf8")
        self.digests[kind].update(len(encoded).to_bytes(8, "big"))
        self.digests[kind].update(encoded)
        for index, field in enumerate(self.metadata):
            self.metadata[field]["present" if record[1][index] is not None else "absent"] += 1
        stamp = record[1][1]
        if stamp is not None:
            self.timestamps[0] = min(self.timestamps[0] or stamp, stamp)
            self.timestamps[1] = max(self.timestamps[1] or stamp, stamp)

    def node(self, obj):
        self.observe("node", obj)
        if not obj.location.valid():
            self.invalid_locations += 1
            return
        lon, lat = obj.location.lon, obj.location.lat
        self.bbox = [min(self.bbox[0], lon), min(self.bbox[1], lat),
                     max(self.bbox[2], lon), max(self.bbox[3], lat)]

    def way(self, obj):
        self.observe("way", obj)

    def relation(self, obj):
        self.observe("relation", obj)
        self.relation_types[obj.tags.get("type", "<missing>")] += 1


class References(osmium.SimpleHandler):
    def __init__(self, ids):
        super().__init__()
        self.ids = ids
        self.counts = Counter()
        self.missing = Counter()
        self.examples = []

    def check(self, source_kind, source_id, target_kind, target_id):
        label = f"{source_kind}_to_{target_kind}"
        self.counts[label] += 1
        if target_id not in self.ids[target_kind]:
            self.missing[label] += 1
            if len(self.examples) < EXAMPLE_LIMIT:
                self.examples.append([source_kind, source_id, target_kind, target_id])

    def way(self, obj):
        for node in obj.nodes:
            self.check("way", obj.id, "node", node.ref)

    def relation(self, obj):
        kinds = {"n": "node", "w": "way", "r": "relation"}
        for member in obj.members:
            self.check("relation", obj.id, kinds[member.type], member.ref)


def audit(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError("source must be a regular file, not a symbolic link")
    before = path.stat()
    source_hash = file_hash(path)
    with osmium.io.Reader(str(path)) as reader:
        header = reader.header()
        if header.has_multiple_object_versions:
            raise ValueError("history input is unsupported")
        source_header = {key: header.get(key) or None for key in (
            "generator", "osmosis_replication_timestamp", "osmosis_replication_sequence_number",
            "osmosis_replication_base_url")}
    started = time.monotonic()
    inventory = Inventory()
    inventory.apply_file(str(path))
    refs = References(inventory.ids)
    refs.apply_file(str(path))
    after = path.stat()
    # A private immutable intake copy is still required by the importing controller.
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or file_hash(path) != source_hash:
        raise ValueError("source changed while it was being audited")
    blockers = []
    if not inventory.counts["node"]:
        blockers.append("no_nodes")
    if not inventory.ordered:
        blockers.append("objects_not_ordered")
    if inventory.invalid_locations:
        blockers.append("invalid_node_locations")
    if refs.missing["way_to_node"]:
        blockers.append("missing_way_nodes")
    review = ["incomplete_relation_members"] if sum(refs.missing.values()) > refs.missing["way_to_node"] else []
    return {
        "schema": "atlas.pbf-audit/1", "generated_at": datetime.now(timezone.utc).isoformat(),
        "tool": {"name": "pyosmium", "version": importlib.metadata.version("osmium")},
        "source": {"filename": path.name, "bytes": before.st_size, "sha256": source_hash,
                   "md5_transport_only": file_hash(path, "md5"), "header": source_header},
        "counts": {kind: inventory.counts[kind] for kind in KINDS},
        "tagged": {kind: inventory.tagged[kind] for kind in KINDS},
        "untagged": {kind: inventory.counts[kind] - inventory.tagged[kind] for kind in KINDS},
        "semantic_digest": {"format": "atlas.osm-records/1; uint64be-length + utf8-compact-json per object",
                            **{kind: inventory.digests[kind].hexdigest() for kind in KINDS}},
        "metadata_coverage": {key: dict(value) for key, value in inventory.metadata.items()},
        "bbox": inventory.bbox if inventory.counts["node"] else None,
        "object_timestamps": inventory.timestamps,
        "ordered": inventory.ordered, "tag_keys": dict(sorted(inventory.tag_keys.items())),
        "relation_types": dict(sorted(inventory.relation_types.items())),
        "references": {"counts": dict(refs.counts), "missing": dict(refs.missing), "examples": refs.examples},
        "blockers": blockers, "review_reasons": review,
        "structural_status": "rejected" if blockers else "review_required" if review else "passed",
        "geographic_truth_verified": False, "publisher_signature_verified": False,
        "elapsed_s": round(time.monotonic() - started, 3),
    }


def write_report(path: Path, report: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--out", type=Path)
    output.add_argument("--stdout", action='store_true', help='emit only the complete JSON report for a bounded sandbox consumer')
    args = parser.parse_args()
    # Do not let the report replace its own input, including through an existing symlink.
    if args.out is not None and args.source.resolve() == args.out.resolve():
        parser.error("output must differ from source")
    try:
        report = audit(args.source)
    except (ValueError,RuntimeError,OSError) as error:
        if not args.stdout: raise
        print(json.dumps({'schema':'atlas.pbf-audit-failure/1','code':'invalid_osm_input','error_type':type(error).__name__,'detail':str(error)[:1000]},ensure_ascii=False))
        return 2
    if args.stdout:
        print(json.dumps(report,ensure_ascii=False,separators=(',',':')))
        return 2 if report['blockers'] else 3 if report['review_reasons'] else 0
    write_report(args.out, report)
    print(json.dumps({"status": report["structural_status"], "counts": report["counts"],
                      "sha256": report["source"]["sha256"], "report": str(args.out)}))
    return 2 if report["blockers"] else 3 if report["review_reasons"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
