# Isolated Part 1C fixture pilot

This is a fixture-only candidate builder, disabled by default. It publishes no release, active pointer, session, engine or external consumer contract. The approved scope is [the fixture brief](../briefs/phase-1c-fixture-implementation.md). Live Monaco/Iran verification and import require separate approval.

## Storage and deployment

Use only Compose project `atlas-phase1c-fixture` and a new private runtime root, currently `/home/owner/projects/.atlas-phase1c-fixture`. Never use a historical root. `atlas_build.monitor.guard_root` rejects symlinked paths and ancestor/descendant overlap with any retained deployment mount. The host monitor must run before admitting a pilot job.

`deploy/fixture-compose.yaml` pins the separate PostgreSQL 17.12 / PostGIS 3.7.0 cluster. The actual native GEOS/PROJ versions are recorded from `postgis_full_version()`; they are not inferred from a tag. Do not substitute images or upgrade a historical control cluster.

Persistent purposes under the runtime root:

- `data/postgres`: new QA control cluster; database `atlas_fixture`.
- `data/candidate-postgres`: separate PostgreSQL-managed candidate cluster storage.
- `data/inbox`, `data/verification`: only new controlled input and normal 1B outputs.
- `data/build/build-work/<intent>/<generation>`: private spool, result and staged bundle evidence.
- `data/build/database/<request-date>/<candidate>/README.md` and `postgis/`: immutable metadata, not PGDATA copies.
- `secrets/`: scoped secret files outside Git; `evidence/`: private check results.

The private root and secret directory are mode 0700. Compose secret source files may be mode 0444 inside that inaccessible host directory because Compose bind-mounted secrets retain host permissions. Mount each file only in the service that needs it. Keep the credential derivation key stable across restart and separate from RPC authentication.

Directory ownership inside mounts is inbox UID/GID 10001, verification UID 10002/GID 10001, build UID 10003/GID 10001, and PostgreSQL UID/GID 999. Public metadata directories are group-readable; execution work remains private. `data/build-tests`, UID 999/GID 10001, is a separate disposable test purpose and is never an intake or verification root.

Only the provisioner and its owned test process receive the candidate administrator password and credential derivation key. The builder receives RPC authentication and its own scoped loader/reader credentials in memory. Web/intake/verifier receive no candidate admin or credential key. No service mounts the Docker socket. Candidate/control networks are internal; only the web port is bound to host loopback.

On a fresh control cluster the init scripts create the app and restricted provisioner users. After migrations, grant the provisioner SELECT on these six control tables only:

```sql
GRANT SELECT ON atlas_build_candidate, atlas_build_buildexecution,
  atlas_build_buildintent, atlas_build_buildprofile, atlas_build_buildreceipt,
  atlas_build_ddloperation TO atlas_build_provisioner;
```

Existing pilot control storage must receive its own missing role initialization explicitly. Never run these scripts or migrations on a historical stack.

## Capacity window

Seven service ceilings total 4,224 MiB: control DB 384; web 256; intake 256; verifier 512; candidate DB 1,536; provisioner 256; builder 1,024. CPU ceilings are 0.25/0.25/0.25/0.5/1/0.25/0.5 respectively. Swap is disabled. Physical read/write caps sum to 20/10 MiB/s on the observed backing device, not a guessed overlay device. The monitor rejects missing effective kernel CPU/RAM/swap/I/O limits or changed image/service pins.

The builder has one active slot, including prepared publications. Each claim reserves 12 GiB. Admission charges outstanding versus allocated active-plane commitments, all retained build storage, 20 GiB free reserve, and independently observed legacy headroom. The initial observed five-scope legacy commitment was `(5 × 2 GiB + 20 GiB) × 1.10 = 33 GiB`; derive it again from the current inventory. This is a quiescent pilot window, not a general cross-stack lock.

Run the host-only read-only preflight with `python3 -m atlas_build.legacy --output <private-file>`. Preserve its inventory/digest. Build an image-pin JSON mapping the seven service names to independently checked Docker image IDs. Run the external monitor from the clean tested checkout:

```sh
python3 -m atlas_build.pilot --root <private-runtime-root> \
  --baseline <private-preflight.json> --revision <tested-sha> \
  --pins <private-image-pins.json> --physical-device 8:0 --seconds 900
```

The monitor reuses five bounded read-only diagnostic processes in the existing web containers. Every sample executes the unchanged query in a new READ ONLY transaction; no older source, deployment, schedule or data is changed. Startup warms the sink and diagnostic imports before collecting fresh observations. Each diagnostic response is bounded to six seconds and 1 MiB, with the original eight-second aggregate collection budget and twelve-second attestation expiry. It reads old modes, queues, schedule windows, reservations and container identities. It sends bounded observations only to the QA control database. A changed legacy inventory/work state fails closed. A dead monitor expires admission/growth after 12 seconds. The source includes actual cgroup and allocation observations; record sampled versus lifetime peaks separately.

Admission requires host available memory of at least 4 GiB and sufficient uncommitted headroom; growth stops below 2 GiB. Heap/TOAST, indexes, retained WAL, aggregate temp and database size have a 128 MiB rollback margin before their 4/2/2/1/6 GiB ceilings. Client storage is at most 1 GiB, bundle/log storage 64 MiB, and aggregate build storage 32 GiB. Cumulative WAL is measured from the pre-DDL LSN; it is not inferred from `max_wal_size`.

Metrics calls allow five seconds each under the fixed CPU quota; three consecutive unavailable observations stop the execution. The attestation sink signals readiness within a separate ten-second startup bound before the first fresh sample. Growth stops at 270 seconds, leaving supervision/termination margin within the five-minute fixture budget. SQL, connection and RPC operations are bounded; RPC retries are at most three. Failures do not automatically loop imports.

## Normal fixture admission

Apply migrations only to the isolated control database. Keep `ATLAS_BUILD_FIXTURE_MODE` absent in ordinary deployments. Even when enabled, helper operations require database `atlas_fixture` or its disposable test database.

To explicitly activate a profile and register new synthetic inputs:

```sh
python manage.py atlas_build_fixture --activate --bootstrap \
  --kind lossless --actor <operator>
```

The command returns the run, verification and profile IDs. It constructs inputs/seal metadata only. The normal verifier determines verification success, the publication transaction writes a unique receipt, the dispatcher admits under Control-first ordering, and the builder determines validation/READY. A request-key name is not a fixture binding. No historical backlog is imported.

Use `--profile <id>` for later fixtures with the same coverage. Supported controlled cases include `relation-only`, `empty`, `mixed-empty`, `boundary-only`, `boundary-policy`, `conflict`, `missing-way-node`, `invalid-boundary`, `large-children` and `load`. Boundary-only activation freezes its own coverage. Existing 1B policy requires every selected PBF to be nonempty: a successful mixed-empty verification remains build-ineligible.

The lossless case includes full signed-int64 positive identities across object types, ordered duplicate tags/references/members, NUL/Unicode/empty strings, absent versus empty metadata, nondefault precision/date scaling, optional way locations and encoding-only differences. `large-children` carries 30,000 ordered references per PBF. `boundary-policy` preserves multipart/exclusion, split-antimeridian and Antarctica provider-plane geometry without repair or wrapping.

The authenticated `/build/` panel requires the existing intake operator permission. Mutations are POST/CSRF protected and require a reason. It exposes progress, identity and bounded escaped diagnostics; authoritative source-bearing reports remain lossless bytea.

Coverage approval is specific to a receipt, actual baseline, proposed digest, removed roles, actor and reason:

```sh
python manage.py atlas_build_approve <receipt> --baseline <candidate> \
  --actor <operator> --reason <reviewed-reason>
```

Normal replay retains one request. An intentional rebuild needs `request_rebuild(intent, fresh_nonce, actor)`; restart is not a rebuild request. Late lower-order completions cannot move the scope baseline backward.

## Provisioning, validation and recovery

Full UUID/generation names, a unique NOLOGIN owner and external ownership journal fence autocommit DDL. Cluster identity is recorded before CREATE. The pre-marker database is not connectable. The builder has a separate nonowner loader and actual reader; no owner/admin membership is granted.

Original lines/strings are bytea. Binary COPY is bounded by rows and bytes. Source and private-spool descriptors, a single complete Zstd frame, expansion/record budgets and producer domains are checked. Semantic dedup uses a digest filter followed by complete equality; excluded encoding details remain in source rows. Missing way nodes are checked per source; dangling relation targets are retained.

Freeze disables the loader, revokes access, synchronously terminates exact owned backends and transfers loader-owned objects. Reader validation reconstructs SQL projections, checks every original line, exact schema identity, canonical/reference integrity, required spatial presence, WKB/type/SRID/index/probe results and effective privileges across user relations. Write probes run with transaction read-only disabled.

READY metadata includes complete provenance, versions, coverage, independent validation, resource evidence and a logical fingerprint. The bundle index hashes the other files and excludes itself. Publication is synchronized, no-overwrite and generation-fenced. Final source/output hashes, current eligibility, database identity and coverage are checked before short ordered READY registration. The date is the actual build-request instant in Asia/Tehran, independent of retrieval/source timestamps.

Failed import/cancellation is terminal. A fresh explicit retry needs checked cleanup and creates new execution/candidate/database/credentials. Keep at most one failed candidate DB, within 6 GiB. Automatic cleanup waits 24 hours; early cleanup is an audited operator action. Unknown and READY resources are never automatic cleanup targets. Retained work and metadata continue to consume root capacity.

Publication failures retain the frozen database and exact staged intent, release the active slot and allow audited publication-only resume. Resume does not import again. Source invalidation revokes current eligibility while preserving original READY evidence. Internal handoff checks current bytes, identity and actual reader rather than trusting a permanent Boolean:

```sh
python manage.py atlas_build_handoff <candidate>
```

A separate provisioner-only orphan maintenance command requires a reviewed external journal SHA, exact cluster/name/database/owner identity, no control candidate and LOADING state. It refuses FROZEN/unknown resources. Original role OIDs that were not recorded remain quarantined; they are not inferred. Preserve failure evidence before invoking it.

## Verification and rollback

Run the complete PostgreSQL suite through the provisioner-owned test profile; ordinary image tests without that profile deliberately skip real-PostGIS integration. Preserve first failures and their diagnoses. Check both `makemigrations --check --dry-run` and `migrate --check`, fresh installation and an isolated accepted-schema/data upgrade copy. Verify no historical auto-admission and unchanged semantic reports, IDs, statuses, eligibility and registered bytes.

On the exact committed image, use new normal fixtures through READY, relation-only success, negatives, fault/restart checks and a stable real-reader probe while building a second candidate. Predeclare the brief's web/reader latency, scheduler-delay and heartbeat thresholds. Check effective limits, OOM deltas, database/index/WAL/temp/storage growth and all historical identities/hashes. No live batch is verified or imported in this pilot.

Report-storage migration is lossless forward and intentionally not a lossy reverse conversion. Rollback to the old JSONB schema requires restoring the pre-upgrade backup; preserve any newly admitted source-bearing bytes separately. Do not migrate the five historical stacks as part of this pilot. Keep the PR draft; do not merge or activate a release.
