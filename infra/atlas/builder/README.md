# Experimental PostGIS/Martin component builder

This stage consumes a cryptographically verified `experimental_source_only` receipt. It builds
a private candidate component and **cannot publish a map release**. The existing API, Tegola,
gateway and web client are not switched. Search, routing, POI and assets are missing components
in every manifest, regardless of whether tile QA passes. See the [stage report](../../../docs/ATLAS-STAGE-3-FA.md).

## Deployment boundary

Use Linux amd64, Node **24.21.0**, PostgreSQL 17/PostGIS 3.6 with GEOS >=3.13.1, Docker,
the pinned importer/Martin images and the already provisioned intake controller. Treat this
as an operator-managed laboratory deployment, not a production installer. Docker membership
and the builder's data-admin credential are privileged. The untrusted PBF parser/importer
receives neither Docker access, the signing key, control credentials nor the data-admin DSN.
The lab uses one Unix owner for trusted controllers: this is not an independent signer boundary.

Provision a **separate data cluster and managed volume** bearing `atlas.role=candidate-data`.
The control database stays on the existing cluster. Set and inspect Docker limits and actual
cgroup v2 `cpu.max`, `memory.max`, `memory.swap.max`, `io.max` and `io.stat`; missing or
unbounded observed devices cause refusal. Device major/minor numbers must come from the
destination machine. Include both the logical and physical device when both are charged.
Do not copy the lab's device numbers blindly. I/O ceilings reduce interference; they do not
reserve latency on a shared host or establish a production capacity envelope.
The lab's two Docker volumes still share the host filesystem; a named volume is not a
separate free-space reservation or failure domain. Production disk quotas/reservations,
continuous capacity protection and safe GC must be addressed before a no-downtime claim.

The tested lab profile is 3 GiB RAM/no swap, one CPU, shares 256, read/write 16 MiB/s on
8:0 and 252:0 for the data cluster; the importer has 2 GiB/no swap, one CPU/shares 128.
The original serving PostgreSQL keeps its own 5 GiB budget and shares 2048. Preserve fsync
and synchronous commit. Keep at least 20 GiB free **before** starting a new real build;
continuous disk admission/estimated peak usage and cleanup remain future work.

Set `client_connection_check_interval=1s` persistently on the **candidate** PostgreSQL
cluster and verify `SHOW client_connection_check_interval` before enabling the worker.
The default is zero: closing a client connection alone does not promptly stop a long query.
The lab applied `ALTER SYSTEM SET client_connection_check_interval='1s'`, reloaded that
cluster, and verified that a disconnected 60-second query's backend disappeared in about
two seconds. This server setting is an operator prerequisite; current automatic Docker
profile checks do not enforce every PostgreSQL GUC. Pinning the complete server configuration,
explicit database-backend reaping and partition tests remain production hardening work.
See [PostgreSQL's connection-check documentation](https://www.postgresql.org/docs/17/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL).

Create a private config from [config.example.json](config.example.json). Paths must be absolute,
canonical and private; DSN files are 0600, state roots 0700. Keep all of them outside the repo.
`controlAdminDsnFile` owns the dedicated `atlas_ingest*` control DB for initialization only.
Create `atlas_candidate_controller` LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
with a generated secret; `controlDsnFile` uses that role in the same control DB. The schema
grants it only the needed intake reads, processing-slot access, build writes and event inserts.
`dataAdminDsnFile` is privileged on the separate data cluster; it must never point at serving data.
`dataHost` is the unique private Docker alias; the admin DSN uses its inspected private IP.

Build dependencies and pin the pipeline from an immutable deployment directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w packages/contracts -w apps/ingest -w apps/builder
node apps/builder/dist/cli.js init --config /private/builder/config.json
node apps/builder/dist/cli.js inspect-spec --config /private/builder/config.json
```

Initialization requires the intake schema. Set `expectedPipelineSha256` to the reviewed
`inspect-spec.sha256`; subsequent commands refuse a mismatch. The hash binds executable
builder/SQL/Lua/verifier/lockfile bytes, exact images, Node, source-verifier build, source
public key and resource profile. Record actual PostgreSQL system identifier and managed
volume per attempt. An image digest alone cannot distinguish two clusters using that image.
Render [the systemd unit](systemd/atlas-candidate-worker.service.in) with the immutable root,
Node bin and config path; inspect it before enabling it. The tested VM uses a lingering user service.

## Operation and evidence

```sh
node apps/builder/dist/cli.js reconcile --config /private/builder/config.json
node apps/builder/dist/cli.js status --config /private/builder/config.json
node apps/builder/dist/cli.js work --once --config /private/builder/config.json
```

`work` continuously reconciles and claims. Reconciliation verifies accepted receipt signatures
and source bytes before allocation. One heavy-work slot is shared with intake in the **same**
control database. Never give two controllers different control DBs against the same constrained
host to bypass this admission rule. At protocol upgrades, stop both workers, wait for jobs to
drain/reap safely, migrate both schemas, install immutable compatible controllers, then restart.
Trusting an older report does not permit running an old worker against a new admission protocol.

Each attempt gets a fresh database and unique owner/import/tile/QA roles. The owner is NOLOGIN;
the importer cannot write serving/control data. After import, ownership moves to the owner,
import login/connect are revoked, and the database and serving/QA roles become read-only.
The tile role can read only eight display tables and call the pinned tile function; it cannot
read the raw archive or build outcomes. No candidate container publishes a host port.

The full raw roundtrip checks every primitive, ordered reference/member, tag and available
metadata against the source audit. Every tagged primitive has one outcome: rendered, partial,
geometry rejected, uncatalogued, catalog-policy excluded, metadata only, or unaccounted.
Insert refusal is recorded, not counted as success. Missing/orphan outcomes, unexplained
catalog loss, invalid/empty stored layer geometry and row/insertion mismatch fail the build.
Missing relation references must match the audit; direct and ancestor impact is reported.
Available geometry is not proof of geographic truth or complete relation topology.

QA decodes SQL and HTTP MVT for identical sites/zooms twice, with an explicitly recorded
cold SQL warmup before strict checks. The final manifest references hashed raw/coverage/tile
reports. Geometry issues, unsupported catalog content or incomplete source topology lead to
`review_required`, even when raw preservation and engine checks pass. Source acceptance and
component review do not authorize release publication. There is no review override CLI here.

Artifacts live under `root/artifacts`, with per-attempt private credentials/logs under
`root/attempts/<token>`. Treat attempt logs/configs as private. Export only a reviewed whitelist
of reports; never export DSNs, `credentials.json`, pgpass, Martin YAML or signing secrets.
The manifest is content addressed; signing a complete map release is a later stage.

## Failure, cancellation and retention

Leases renew atomically for job and shared slot. A transient control error can retry only
within the known monotonic safe deadline; definite loss or deadline expiry cancels work.
Active administrative PostgreSQL connections close on cancellation as well as importer
processes. Completion requires the current unexpired token. A replacement attempt always
uses a different database. The reaper removes only registered containers matching the exact
root/job/token/kind labels and protects live and completed resources. Docker/control uncertainty
fails closed. Capacity waits do not consume input-failure allowance; infrastructure retries are bounded.

Stop only the builder via `systemctl --user stop atlas-candidate-worker.service`. Existing
serving containers continue independently. The lab observer stops the experimental builder
on its first serving failure; it is a test tool, not a production monitoring system. A successful
private tile probe does not establish browser, gateway, session, release-switch or load behavior.

Failed/abandoned databases and role identities are deliberately retained for investigation.
**No actual database/source GC is implemented.** Do not delete by prefix or age alone.
Future GC must verify the recorded target cluster/volume/system identifier, ownership marker,
build identity and all release/session/inflight/job/pin protections before deletion. Attempts
created before target recording have null `data_target` and require independent provenance;
they must not be swept automatically. Keep last-three/current/previous/live leases as already
specified by the registry; storage exhaustion must block new builds, not destroy protected data.

## Verification

Root CI runs unit tests and real PostgreSQL queue/fencing tests. `tools/catalog-smoke.py`
uses only fictional PBFs and disposable PostGIS to verify actual osm2pgsql insert refusal,
partial output and ordered references. `tools/builder-e2e.mjs` additionally exercises real
intake/Cosign/import/Martin and fault injection; it refuses configs outside a fresh fixture
`atlas_test_ingest_e2e_<nonce>` control DB. Do not point a fault harness at live control data.
