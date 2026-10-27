# Durable private PBF intake

This stage accepts source bytes. It does not build a map release, change PostGIS serving
databases, publish a default release, or connect the legacy client to Martin.
See [the measured results and limits](../../../docs/ATLAS-STAGE-2-FA.md).

## Trust and delivery contract

The coordinator, database administrator and signing operator are trusted. The PBF parser
is untrusted: no network, database credentials, signing keys or Docker socket are mounted
in its container. Host Docker access is privileged; separate SQL roles/processes on the
same owner account do not isolate the signer from a compromised host/coordinator.
Use an independent signer identity/KMS and reviewed administrative access before production.

Use Linux amd64, owner uid/gid 1000, Docker, Python 3 and the Node/Cosign artifacts in
`tools.lock.json`. Verify downloads against their complete SHA-256 values. Keep the
control database and state root exclusive to this controller. Do not share its database
with another filesystem root. The CLI checks the database name and a two-way instance binding.

`submit` copies a regular source into `incoming/<random-id>/`, syncs it, commits the manifest,
and publishes `READY` last. Plain files, `.part` files and deliveries without `READY` are
ignored. A completed-copy marker is required; an unchanged file size is not sufficient.
The original operator file is not removed. An upload UI may later wrap this same contract.

```text
state/                         private, owner only
  incoming/<id>/               input.osm.pbf + source-manifest.json + READY
  quarantine/<id>/<attempt>/   private snapshot in progress
  sources/<full-sha256>/        one canonical input.osm.pbf, read-only
  artifacts/<full-sha256>.json  bounded reports, receipts and bundles
  signing/                     short-lived private Cosign working files
```

Paths are opened descriptor-relative with no symlink traversal. FIFOs, hardlinks, malformed
manifests and changed delivery bytes are refused. The snapshot is checked by SHA-256/size
and copied into the private canonical store before any parsing. Delivery copies are consumed
only after a durable database checkpoint. The worker validates canonical bytes again before
completion; the signer verifies them before acceptance. Filesystem write protection assumes
the trusted owner/administrator does not maliciously change the private store.

## Prepare a dedicated lab instance

1. Review the policy in `iran-policy.json`. The first Iran input requires baseline review;
   every incomplete relation currently requires review. Missing way nodes, invalid structure
   and regressed snapshots cannot be overridden. Bounds are initial conservative limits,
   not a measured production quality envelope.
2. Build with Node 24.21.0 after `npm ci --ignore-scripts --no-audit --no-fund`:
   `npm run build -w apps/ingest`. Record `apps/ingest/dist/build-id.json`; it binds emitted
   JS/SQL/Python files, Node version and the package lock. Do not edit a running build.
3. Build the parser using `docker build -t atlas-intake/audit:local -f
   infra/atlas/intake/Dockerfile.audit .`. Record `docker image inspect
   atlas-intake/audit:local --format '{{.Id}}'`. Configure the full image ID, never its tag.
   The Dockerfile copies the pinned native expat dependency and tests the non-root entrypoint.
4. Have the database administrator create a dedicated `atlas_ingest` database owned by
   `atlas_ingest_admin`, plus login roles `atlas_ingest_worker`, `atlas_ingest_reviewer`,
   `atlas_ingest_signer`. Runtime roles must be NOSUPERUSER/NOCREATEDB/NOCREATEROLE and
   must not own the database/schema. Store distinct DSNs in owner-only files, mode 0600.
   Passwords belong in private files, never shell arguments, source, CI logs or reports.
5. Create an encrypted Cosign local test key and random password in an owner-only private
   directory. Use `cosign generate-key-pair --output-key-prefix /PRIVATE/source` with
   `COSIGN_PASSWORD` supplied privately to that process. Store the encrypted key and password
   files mode 0600. Pin SHA-256 of the public PEM. Do not replace an existing key or partial
   key state automatically. This is a lab trust profile, not a production KMS installation.
6. Copy `config.example.json` into that private directory with mode 0600. Replace paths,
   all zero hash placeholders and resource limits. Configuration, binaries, policy and their
   parent directories must be controlled by the trusted operator. The state root is mode 0700.
   The configured interpreter runs the reviewed `secure_fs.py` from the verified build.
7. Initialize once using the dedicated admin role:

```sh
node /OPT/ATLAS/apps/ingest/dist/cli.js init --config /PRIVATE/config.json
node /OPT/ATLAS/apps/ingest/dist/cli.js status --config /PRIVATE/config.json
```

`init` applies additive intake tables and SQL grants, then binds the database and filesystem.
It never imports source data or touches the active map. This is not a generic database migration
tool: never point it at an existing application's database.

On the current VM, the lab database is reached over its private Docker address. If that
container/network is recreated, inspect its new address and update the private DSNs before
starting controllers. Do not expose a database port just to run this lab. A stable service
address, independent database lifecycle and a tested whole-host recovery plan remain deployment work.

## Run and observe

Use the service and timer templates in `systemd/`, rendering `@SOURCE_ROOT@` to a newly
installed, fixed build directory, `@NODE_BIN@` to the verified Node bin directory and
`@CONFIG@` to the private configuration. Install as owner user units. Enable the worker,
signer and reconcile timer with `systemctl --user enable --now ...`; enable user lingering
through the authorized host administrator. The timer registers new deliveries even while
a long parser is active. Services restart on failure; the coordinator scans the durable queue.

```sh
node /OPT/ATLAS/apps/ingest/dist/cli.js submit --config /PRIVATE/config.json \
  --file /DATA/iran-261025.osm.pbf --provider geofabrik --region iran \
  --url https://download.geofabrik.de/asia/iran-261025.osm.pbf
node /OPT/ATLAS/apps/ingest/dist/cli.js status --config /PRIVATE/config.json
systemctl --user status atlas-intake-worker.service atlas-intake-signer.service
journalctl --user -u atlas-intake-worker.service -u atlas-intake-signer.service
```

The source URL is operator-declared provenance, not proof that the publisher signed the bytes.
`--expected-sha FULL_SHA256` optionally binds submission to an independently obtained hash.
The receipt explicitly keeps `publisher_signature_verified=false`.

There is one heavy validation lease per control database. Defaults in the example: 2 GiB input
ceiling, 2 GiB free reserve, 3 GiB parser RAM with no swap, 1.5 CPU, 64 pids, 2 hour wall limit.
These are test limits. Source size does not bound decoded complexity; resource exhaustion
fails closed. Infrastructure failures have bounded retries/backoff; insufficient capacity
waits without consuming the failure budget. A lost lease fences all completion writes.
Orphan removal checks database liveness and exact managed labels; database failure protects
containers rather than deleting unknown work.

## Review, sign and verify

Ordinary passing reports enter signing automatically. Review-required inputs cannot sign
until the reviewer records the exact report hash and decision hash plus identity/rationale.
Hard failures cannot be approved. A changed policy or baseline is re-evaluated by the signer;
an obsolete decision cannot silently carry approval forward. Read the full artifact before
using these commands; example placeholders are deliberately not runnable approval instructions:

```sh
node /OPT/ATLAS/apps/ingest/dist/cli.js review --config /PRIVATE/config.json \
  --validation VALIDATION_ID --report-sha REPORT_SHA --decision-sha DECISION_SHA \
  --action approve --actor OPERATOR --reason 'Specific reviewed anomaly and accepted source scope'
node /OPT/ATLAS/apps/ingest/dist/cli.js verify-receipt --config /PRIVATE/config.json \
  --validation VALIDATION_ID
```

The signer independently checks report/policy/baseline, source bytes, pinned Cosign binary
and public key; signs a blob offline; verifies the signature; saves content-addressed payload
and Sigstore bundle; then commits acceptance under a short signer lease. The local profile uses
`--tlog-upload=false --use-signing-config=false`; verification uses an explicitly pinned public
key and offline bundle verification. There is no transparency-log assurance in this profile.
See [Sigstore blob signing](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/).

All receipts in this lab profile carry `usage_scope=experimental_source_only`; verification
requires that scope. Production publishers must not accept this lab profile/key as production
authorization. An accepted source is not an approved map release.

Receipt lineage distinguishes the collector build from the signer build and embeds normalized
policy and validator image identity. `signer.trustedCollectorBuilds` can explicitly list up to
10 previously reviewed build hashes. If omitted, only the current controller build is trusted.
An old collector still requires the same configured policy and validator image; trusting its
hash does not bypass review, report/decision matching or signature verification. Accepted
historical receipts retain their signed policy context when verified.

Pin a baseline only after acceptance and signature verification, using `baseline --validation
ID --actor ... --reason ...` and `--previous-baseline OLD_ID` for a replacement. This CAS checks
the expected previous baseline. Source acceptance/baseline approval does not authorize release
publication. At this stage no component consumes receipts to build or publish a map.

## Upgrade, recovery and remaining limits

Drain queued/active jobs under their original collector build before switching worker builds.
Install a new build directory and render new unit paths; never overwrite files beneath a live
controller. Preserve old build manifests/source/dependencies for lineage. An explicitly trusted
old collector can finish signing with a newer signer. Queued jobs are not silently rebound to
a new build specification; automated multi-build draining/migrations remain future work.

Stop units before private configuration/key changes. Back up the control database, instance
binding, canonical sources, artifacts and signing trust material consistently. Do not reset
bindings or clear leases by editing SQL in a live environment. Whole-host restore, key rotation/
revocation, KMS identity, independent approval authentication, complete disk/WAL accounting,
resource-pressure tests, source/artifact GC and a remote administration UI remain outstanding.
The incoming directory safety ceiling is 10,000 submission IDs; consumed metadata is retained
for audit and needs a separately protected archival/retention implementation before sustained use.

Do not delete canonical sources because a delivery copy is consumed. Release/session/build
dependencies and approved retention must be integrated before deleting historical artifacts.
The existing release library alone does not grant permission to remove this source store.

## Verification

The CI workflow builds/typechecks/tests all workspaces against PostgreSQL, tests descriptor-relative
filesystem attacks on Linux, and builds/runs the real no-network parser on a complete fixture.
`tools/ingest-e2e.mjs CONFIG FIXTURES EVIDENCE [PREVIOUS_COLLECTOR_ROOT]` runs real Docker/Cosign/SQL
fault checks only against a fresh `atlas_test_ingest_e2e_<8 hex>` database and fictional PBFs.
It deliberately tampers with that disposable database and must never target the Iran instance.
The optional previous build test proves explicit collector trust and distinct signed lineage.
`tools/build-intake-fixtures.py` creates the malformed/missing-reference inputs.
