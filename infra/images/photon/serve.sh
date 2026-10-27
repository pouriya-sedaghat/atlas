#!/usr/bin/env bash
# Serve a prebuilt Photon index. Never imports and never enables /nominatim-update.
set -euo pipefail
data_dir="${PHOTON_DATA_DIR:-/data/photon}"
test -d "$data_dir/photon_data" || { echo "missing Photon index in $data_dir" >&2; exit 3; }
# Release-specific query-time synonyms (normalized token -> original spellings), if packaged.
synonyms=()
if [ -f "$data_dir/synonyms.json" ]; then synonyms=(-synonym-file "$data_dir/synonyms.json"); fi
exec java ${PHOTON_JAVA_OPTS:--Xms512m -Xmx2g} -jar /opt/photon/photon.jar serve \
  -data-dir "$data_dir" -listen-ip 0.0.0.0 -listen-port 2322 \
  -max-results 20 -max-reverse-results 20 -query-timeout 7 -default-language fa "${synonyms[@]}"
