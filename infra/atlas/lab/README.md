# Isolated engine laboratory

This lab creates its own Compose project, private network, database and internal tile endpoints.
It does not activate a release in the legacy platform. Run on a dedicated Linux amd64 VM with
Docker/Compose, Python 3 and an owner with uid 1000. Plan disk/RAM for the full primitive archive,
temporary import tables and derived catalog, not only the compressed PBF size.

## Input audit

Run outside the serving runtime with a fixed parser version. The parser needs no internet access
while auditing a file. The audit reads all primitives twice and may take considerable time.

```sh
python3 -m venv audit-env
audit-env/bin/pip install --no-deps -r tools/pbf-audit/requirements.txt
audit-env/bin/python tools/pbf-audit/audit.py /data/iran.osm.pbf --out /data/audit.json
```

Exit 0 means structural checks passed, 2 means rejected, 3 means human review is required.
An exception also fails validation. Missing way nodes block import. Missing relation members
require review: a regional extract may contain parents whose other members lie outside it.
Staging import is permitted for investigation; publication is not implied.

The audit normalizes absent metadata (zero/empty values) to null. It rejects history, duplicate
objects, unordered input, duplicate tag keys and identifiers/references outside the exact importer
and catalog-MVT number range. Unsupported input is rejected rather than silently rounded or collapsed.
Use a resource-limited worker for untrusted files; this standalone audit is not an upload service.

## Prepare and test

Obtain the exact Martin release archive recorded in `images.lock.json`; transfer it and the PBF
to the VM. Compare the expected SHA-256 with the received bytes before invoking preparation.

```sh
python3 tools/atlas-lab.py prepare \
  --source /data/iran.osm.pbf --expected-sha256 FULL_SHA256 \
  --martin-archive /data/martin-1.16.1-linux-musl.tar.gz
docker run --rm --user 1000:1000 --network host --tmpfs /tmp \
  -e npm_config_cache=/tmp/npm-cache -v "$PWD:/src" -w /src \
  node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  npm ci --ignore-scripts --no-audit --no-fund
audit-env/bin/python tools/pbf-audit/build_conformance_fixture.py /data/conformance.osm.pbf
audit-env/bin/python tools/pbf-audit/audit.py /data/conformance.osm.pbf --out /data/conformance-audit.json
python3 tools/atlas-lab.py selftest --source /data/conformance.osm.pbf --audit /data/conformance-audit.json
python3 tools/atlas-lab.py import --audit /data/audit.json
```

Preparation creates private `.lab-state` credentials/configuration (never commit or publish it).
Use a fresh lab for a different input. Import refuses to overwrite an existing dataset.
An interrupted/failed import is not automatically promoted or overwritten; inspect its log and
rebuild a separate lab. This utility is an evaluation harness, not the production controller.

The importer archives all tagged and untagged nodes/ways/relations separately from osm2pgsql's
temporary middle tables. The legacy rendering catalog is reused to compare engines with identical
SQL/data. Its feature coverage is not enlarged by replacing the tile server.

After successful import, Martin is available internally at `http://martin:3000`, pg_tileserv at
`http://pgtileserv:7800`. The network is isolated; host/public ports are not published.
Martin publishes only the explicit basemap function;
the tile role cannot read the raw archive. Import and tile services run without Linux capabilities
or a writable root filesystem. Resource quotas bound the experiment.

## Full semantic verification and comparison

Run the following using the fixed Node image in the lab network. `/src` is the repository checkout;
mount the source audit read-only at `/in/audit.json` and the private admin password file read-only
at `/run/secrets/db_password`. Passwords are read from files, not passed in command arguments.

```sh
lab_node() {
  docker run --rm --pull never --user 1000:1000 --network atlas-lab_backend \
    --memory 1g --cpus 1.5 --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$PWD:/src" -v "$PWD/.lab-state/db_password:/run/secrets/db_password:ro" \
    -v /data/audit.json:/in/audit.json:ro -w /src \
    node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 "$@"
}
lab_node node tools/verify-raw.mjs /in/audit.json /src/.lab-state/raw-roundtrip.json
lab_node node tools/verify-tiles.mjs /src/.lab-state/tile-parity.json
lab_node node tools/inspect-catalog.mjs /src/.lab-state/catalog-inspection.json
lab_node node tools/run-registry-tests.mjs
```

`verify-raw` reconstructs and hashes every canonical primitive from a repeatable-read database
snapshot, including tag values, metadata and ordered references; counts alone do not prove retention.
`verify-tiles` decodes 24 geographic/zoom samples in three rounds and compares both servers against the SQL function.
It compares geometry/property content rather than serialization order. These checks do not prove
real-world geographic correctness or every possible tile.

```sh
python3 tools/atlas-lab.py benchmark --rounds 4 --concurrency 4
```

The benchmark alternates engine order, disables HTTP application caching, and reports errors,
p50/p95/max for a fixed sample. PostgreSQL buffers are shared/warm. A single VM sample is not a
production capacity result or a demonstration of uninterrupted all-engine publication. The same
bounded Node HTTP client runs inside the private network for both engines; each request opens a
new connection. Warm-up completes for every sample before timing begins.

The tile profile rejects older GEOS versions that can yield unstable Multi simplification.
Do not upgrade an existing database volume across OS/collation changes by swapping its image.
In the recorded experiment, a logical backup was restored into a fresh volume and every raw
primitive was reverified; the original volume was retained. This is a lab restore check, not a
production backup/recovery implementation.

Reports/logs stay in `.lab-state`. Export only selected non-secret reports. Keep image digests,
source hashes, tool versions and report scope with any published numbers. Supply-chain review,
restore tests and workload-specific capacity testing remain production requirements.
