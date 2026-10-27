# Isolated engine laboratory

This lab creates its own Compose project, private network, database and local-only tile endpoints.
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
objects, unordered input, duplicate tag keys and identifiers/references outside the exact Lua
integer range. Unsupported input is rejected rather than silently rounded or collapsed.

## Prepare and test

Obtain the exact Martin release archive recorded in `images.lock.json`; transfer it and the PBF
to the VM. Compare the expected SHA-256 with the received bytes before invoking preparation.

```sh
python3 tools/atlas-lab.py prepare \
  --source /data/iran.osm.pbf --expected-sha256 FULL_SHA256 \
  --martin-archive /data/martin-1.16.1-linux-musl.tar.gz
npm ci --ignore-scripts --no-audit --no-fund
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

After successful import, Martin listens on `127.0.0.1:3111`, pg_tileserv on `127.0.0.1:7801`.
Neither endpoint is a public gateway. Martin publishes only the explicit basemap function;
the tile role cannot read the raw archive. Import and tile services run without Linux capabilities
or a writable root filesystem. Resource quotas bound the experiment.

## Full semantic verification and comparison

Run the following using the fixed Node image in the lab network. `/src` is the repository checkout;
mount the source audit read-only at `/in/audit.json` and the private admin password file read-only
at `/run/secrets/db_password`. Passwords are read from files, not passed in command arguments.

```sh
node tools/verify-raw.mjs /in/audit.json /src/.lab-state/raw-roundtrip.json
node tools/verify-tiles.mjs /src/.lab-state/tile-parity.json
node tools/run-registry-tests.mjs
```

`verify-raw` reconstructs and hashes every canonical primitive from a repeatable-read database
snapshot, including tag values, metadata and ordered references; counts alone do not prove retention.
`verify-tiles` decodes 24 geographic/zoom samples and compares both servers against the SQL function.
It compares geometry/property content rather than serialization order. These checks do not prove
real-world geographic correctness or every possible tile.

```sh
python3 tools/atlas-lab.py benchmark --rounds 4 --concurrency 4
```

The benchmark alternates engine order, disables HTTP application caching, and reports errors,
p50/p95/max for a fixed sample. PostgreSQL buffers are shared/warm. A single VM sample is not a
production capacity result or a demonstration of uninterrupted all-engine publication.

Reports/logs stay in `.lab-state`. Export only selected non-secret reports. Keep image digests,
source hashes, tool versions and report scope with any published numbers. Supply-chain review,
restore tests and workload-specific capacity testing remain production requirements.
