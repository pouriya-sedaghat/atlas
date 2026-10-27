#!/usr/bin/env bash
# Complete preparation from already-built images. No fetch, rebuild, or runtime-data changes.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root"
for command in docker python3 git; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 2; }
done
export SEYRA_SOURCES="${SEYRA_SOURCES:-$root/.build/sources}"
SEYRA_SOURCES="$(cd "$SEYRA_SOURCES" && pwd -P)"; export SEYRA_SOURCES
mkdir -p validation
record="$root/validation/verified-source-heads.json"
python3 infra/prepare/record-checkouts.py infra/prepare/sources.json "$SEYRA_SOURCES" "$record"
# Git stays on the host. The existing ops image provides Node and Docker; no extra packages,
# image changes, Node installation on the VM, or network access are needed for this step.
docker run --rm --pull never --network none --entrypoint node \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$root:$root" \
  -v "$SEYRA_SOURCES:$SEYRA_SOURCES:ro" -v "$record:$record:ro" \
  -e SEYRA_SOURCES -e SEYRA_VERIFIED_SOURCE_HEADS="$record" \
  -e SEYRA_PREP_DB_ORIGIN='Pinned upstream postgis image; local identity inspected during demo preparation.' \
  -e SEYRA_PREP_NOTE='HTTP VM demo: source heads verified with host Git; lock generated in the existing ops container; runtime validation is separate.' \
  -w "$root" seyra-demo/ops:1.0.0-seyra1 infra/prepare/write-lock.mjs
export SEYRA_HOME="${SEYRA_HOME:-$root/.demo-state}"
bash bin/seyra-maps verify-images
echo 'Preparation finalized: all 10 image identities verified. You can now run demo.sh.'
