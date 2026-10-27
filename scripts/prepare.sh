#!/usr/bin/env bash
# Online preparation only. Runtime/imports use the resulting local images.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
for command in docker python3 git curl sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 2; }
done
docker info >/dev/null
docker compose version
docker buildx version
case "$(docker info --format '{{.OSType}}/{{.Architecture}}')" in
  linux/x86_64|linux/amd64) ;;
  *) echo 'This package targets a native linux/amd64 Docker daemon.' >&2; exit 2;;
esac
export SEYRA_SOURCES="${SEYRA_SOURCES:-$root/.build/sources}"
mkdir -p "$SEYRA_SOURCES"
SEYRA_SOURCES="$(cd "$SEYRA_SOURCES" && pwd)"; export SEYRA_SOURCES
mkdir -p validation
# ZIP extraction does not reliably preserve executable bits.
find bin infra fixtures scripts -type f \( -name '*.sh' -o -name seyra-maps \) -exec chmod +x {} +
bash infra/prepare/fetch-sources.sh
# Pull the database by its upstream recorded immutable digest, then tag for the local lock.
db_ref="$(python3 -c 'import json; print(json.load(open("infra/upstream.dependencies.lock.json"))["images"]["db"]["repo_digests"][0])')"
docker pull "$db_ref"
docker tag "$db_ref" postgis/postgis:17-3.5
bash infra/prepare/build-images.sh
# Check source heads on the host, then use the built ops image to record local image identities.
bash scripts/finalize-preparation.sh
printf '\nImages prepared. Next: bash demo.sh --synthetic\nOr: bash demo.sh --pbf /absolute/path/to/your.osm.pbf\n'
