#!/usr/bin/env bash
# Test tooling: convert the SYNTHETIC XML fixture into an .osm.pbf with the pinned osmium image.
# Output goes outside Git (*.osm.pbf is ignored). Usage: build-fixture-pbf.sh OUT_DIR
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:?output directory}" && cd "$1" && pwd)"
img="$(grep -o '"ref": "seyra-demo/osmtools:[^"]*"' "$here/../../infra/dependencies.lock.json" | head -1 | cut -d'"' -f4)"
docker run --rm --pull never --network none -v "$here:/fx:ro" -v "$out:/out" --user "$(id -u):$(id -g)" "$img" \
  osmium cat /fx/synthetic-v1.osm -o /out/synthetic-v1.osm.pbf -O \
  --output-header="osmosis_replication_timestamp=2026-10-01T00:00:00Z"
sha256sum "$out/synthetic-v1.osm.pbf"
