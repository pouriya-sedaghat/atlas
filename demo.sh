#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"
usage() {
  cat <<'EOF'
Seyra temporary HTTP VM demonstration (all four real map providers).
  bash scripts/prepare.sh                 online build, once before first use
  bash demo.sh --synthetic                fictional map fixture; no real Iran data
  bash demo.sh --pbf /path/region.osm.pbf   owner-supplied real map data
    [--bind VM_IPV4 --cidrs CLIENT_NETWORK/PREFIX] [--port 8080]
    [--server-names "VM_IP maps.internal"]
Default: http://127.0.0.1:8080. No CA or certificates are used.
Use a NEW SEYRA_HOME for this demo, separate from an existing Seyra installation.
EOF
}
pbf=''; synthetic=0; bind=127.0.0.1; cidrs=''; port=8080; names=''
while [ $# -gt 0 ]; do
  case "$1" in
    --synthetic) synthetic=1; shift;;
    --pbf|--bind|--cidrs|--port|--server-names)
      [ $# -ge 2 ] || { usage; exit 2; }
      case "$1" in
        --pbf) pbf="$2";; --bind) bind="$2";; --cidrs) cidrs="$2";; --port) port="$2";; --server-names) names="$2";;
      esac
      shift 2;;
    --help|-h) usage; exit 0;;
    *) usage; exit 2;;
  esac
done
if { [ "$synthetic" = 0 ] && [ -z "$pbf" ]; } || { [ "$synthetic" = 1 ] && [ -n "$pbf" ]; }; then
  usage; exit 2
fi
export SEYRA_HOME="${SEYRA_HOME:-$root/.demo-state}"
case "$SEYRA_HOME" in /*) ;; *) echo 'SEYRA_HOME must be absolute' >&2; exit 2;; esac
mode=loopback
if [ "$bind" != 127.0.0.1 ]; then
  [ -n "$cidrs" ] || { echo 'For VM/LAN access supply --cidrs, e.g. 192.168.1.0/24.' >&2; exit 2; }
  mode=lan
fi
if [ -z "$names" ]; then
  names='localhost 127.0.0.1'
  [ "$bind" = 127.0.0.1 ] || names="$names $bind"
fi
# Verify before initialising any database or state.
bash bin/seyra-maps verify-images
if [ "$synthetic" = 1 ]; then
  mkdir -p .demo-input
  bash fixtures/osm/build-fixture-pbf.sh "$root/.demo-input"
  pbf="$root/.demo-input/synthetic-v1.osm.pbf"
  echo 'SYNTHETIC DATA: fictional streets and places, suitable for function checks only.'
fi
[ -f "$pbf" ] || { echo "OSM input file not found: $pbf" >&2; exit 2; }
bash bin/seyra-maps init --bind "$bind" --port "$port" --access "$mode" \
  --lan-cidrs "$cidrs" --server-names "$names" --no-relay
mkdir -p validation
log="$root/validation/import-$(date -u +%Y%m%dT%H%M%SZ).log"
bash bin/seyra-maps import --pbf "$pbf" | tee "$log"
dataset="$(sed -nE 's/^\[import\] release ([a-z0-9-]+) built and validated.*$/\1/p' "$log" | tail -1)"
[ -n "$dataset" ] || { echo 'No validated dataset ID returned; inspect the import log.' >&2; exit 1; }
bash bin/seyra-maps activate "$dataset"
base="http://$bind:$port"
# Readiness already checked internally by activate; this also verifies the HTTP ingress.
bash scripts/smoke.sh "$base"
printf '\nMap: %s/\nSwagger: %s/api/docs/\nOpenAPI: %s/api/docs/json\n' "$base" "$base" "$base"
