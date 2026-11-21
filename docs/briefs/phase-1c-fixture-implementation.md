# Atlas Part 1C — approved fixture build pilot

**Status** — Implementation approved for the bounded fixture pilot defined here, following the read-only review of main `b3157b8f4f5a99961b75e94c6336d1c56ca0d551`. Create `feat/phase-1c-fixture-builder` from current main on the designated Atlas VM. Deliver one draft PR and exact-candidate evidence for review. Do not merge or activate a release.

This supplements [the 1C design review](phase-1c-candidate-database.md). The reviewed proposal is accepted with the additional control-report string-fidelity prerequisite and the precise safeguards below.

## Outcome and scope

Deliver one genuine controlled fixture through normal Part 1B verification/publication, durable automatic build admission, isolated PostgreSQL/PostGIS loading, independent database validation and an immutable READY bundle. Also prove the eligible relation-only case and the specified negative/recovery cases.

READY means ready for later publication. It does not publish a release, change sessions, expose engines or alter the active pointer. Part 1D and external consumer contracts remain separate.

Live build admission stays disabled. Do not launch verification/build of the recovered Monaco runs or the historical Iran batch. The historical Jiangsu finding remains blocking under the unchanged whole-batch policy. Matching bytes make a new blocker expected, but no formal verification outcome exists for the recovered batches. Existing eligible fixture verifications may be inspected as references; do not automatically import history or copy their status to new jobs.

The VM report identified eligible fixtures `087c8896-59c5-40fb-87b3-58457f896819` (2/1/1 objects) and `5946ef90-f53b-41da-97f4-403ab875f1e3` (0/0/1). Valid-empty `9a5df6a2-6a21-43ef-925a-f4a9b84244f6` remains ineligible. Preserve all records and outputs.

## 1. Mandatory first checkpoint — string fidelity through the handoff

The raw candidate store must use bytea for accepted IR lines and arbitrary source strings. PostgreSQL text/JSONB cannot store every accepted source string, including NUL.

There is also an upstream integration seam to address: `VerificationAttempt.summary` and `VerificationExecution.report` are JSON fields, while `records.record_sample()`, decoder summaries/header information and execution region results can retain source strings. Merely changing candidate tables does not prove a NUL-containing fixture can reach a successful handoff.

First add a PostgreSQL regression that carries NUL through a sampled tag/user/role and a selected-key summary/header, wherever admitted by the existing profile. Demonstrate the actual control-report storage behavior. Do not put the string beyond preview limits to avoid the issue.

Implement lossless bytea-backed storage for source-bearing verification reports if the regression reproduces this incompatibility. Preserve the Python dictionary API or provide a fully updated compatible accessor across workers, panel, execution history and tests. JSONB may retain controlled metadata/projections only; opaque source strings must not be sanitized, dropped or substituted in authoritative reports.

Use a tested data-preserving migration for existing attempt and execution reports. Exercise the accepted old schema/data on an isolated upgrade copy; do not apply this migration to the five historical stacks during the pilot. Preserve their semantic contents, statuses, IDs and eligibility. Existing manifests/IR/source files and registered byte digests must remain unchanged. Do not use an implicit jsonb-to-bytea cast or promise a reverse migration that would lose newly admitted strings; document the actual rollback/restore constraint.

Separate authoritative report bytes from bounded human-readable diagnostics. Escape unsafe diagnostic text explicitly for display/audit without changing authoritative values. Test all database/report paths touched by arbitrary source strings, including keys, rather than fixing only one preview field.

Do not change accepted source policy, geometry rules, manifest/IR schema versions or source-output identities to force success. If compatibility cannot be preserved, report the concrete blocker before provisioning/import work. This storage prerequisite is within the approved 1C PR scope.

## 2. Admission, scope and coverage

Use one complete successful, supported, build-eligible batch handoff, verified through `get_handoff(..., verify_outputs=True)`. Multiple PBF regions within that batch are supported. Do not admit an individually passing region from a failed batch, an empty/boundary-only result, a hash-inconsistent graph or an invalidated source.

Validate the batch, regional manifests and complete registered output graph, including counts, descriptors, versions and provenance. Rehash registered source inputs and outputs through descriptor-safe paths. Copy the exact IR/sidecars into a private builder spool and import only that stable copy; recheck control eligibility after long reads. Before READY repeat the required source/output digest and current-eligibility checks, followed by the short fenced registration check. A still-sealed metadata record alone must not hide changed source bytes.

Write a unique durable automatic build-registration/queue row in the same control transaction that registers eligible verification success. This may be an intent or a durable outbox receipt admitted by a reconciled dispatcher; an on_commit callback alone is insufficient. A rollback must remove both registration and trigger.

The existing verification publisher locks Run then VerificationAttempt and performs file publication. Do not acquire the global Control lock late inside that lock order or hold it across publication/hashing. Use an independent uniquely constrained outbox insert in that transaction if needed, then admit under the established Control-first order outside the publisher. Assign immutable request order when the automatic build request is accepted, never from build completion time. Preserve order and idempotency through delayed/out-of-order receipt commits and replay; test the actual lock graph.

Default the pipeline to disabled. Activation must be explicit and durable, with an epoch/watermark and trusted scope/profile binding, not a wall-clock-only or request-key-name convention. Only new opted-in fixture verification publications after activation may auto-admit. No historical backlog. Fixture status must be explicit in every manifest/handoff and cannot be promoted into live scope. The fixture helper is limited to the isolated QA control database.

Freeze:
- Expected PBF region set, boundary-only set and frozen exceptions.
- Input/handoff fingerprints, importer/schema/policy/tool versions.
- Scope/profile, bootstrap or baseline identity, actor, request order and idempotency key.
- Requested-at UTC, saved zone and bundle date.

Require exact coverage-role reconciliation; downgrading a PBF region to polygon-only is removed PBF coverage. No implicit carry-forward. Require an explicit bootstrap intent when no baseline exists, with independent fixture/live baselines.

At admission and before READY compare coverage with the relevant current last READY/published baseline in that scope. Any shrink approval must identify the actual baseline/coverage digest, removed regions/roles, proposed coverage, actor and reason. It is not a general bypass flag. Revalidate if the baseline changes during work. A late lower-order candidate must not move the scope baseline backward. Preserve both admission and final comparison evidence.

Normal replay returns one intent. An intentional rebuild requires a fresh explicit nonce. Do not turn deployment or a worker restart into a new rebuild.

## 3. Approved raw-store contract

Use Atlas-owned `raw`, `spatial` and `atlas_meta` schemas. Implement the reviewed per-source occurrence store plus deduplicated objects, with constraints equivalent to or stronger than the proposed DDL.

| Relation | Required role |
| --- | --- |
| raw.source | Verification/run/region identity, coverage role, exact regional manifest/provenance bytes and digests |
| raw.block | Original block line plus independently queryable precision, presence, encoding, raw size and optional opaque index data |
| raw.object_record | Exact accepted JSONL line, line/semantic hashes, source ordinal, type/ID and source block |
| raw.osm_object | Typed canonical identity and representative occurrence |
| raw.info | Metadata presence/missing fields and every admitted value, including exact ticks and numeric reconstructed milliseconds |
| raw.node_value | Encoded integer coordinates and exact reconstructed nanodegrees |
| raw.tag | Position and UTF-8 bytea key/value, preserving duplicate pairs |
| raw.way_state / raw.way_ref | Nullable-versus-present location state and all ordered references/locations |
| raw.member | Ordered typed member IDs and UTF-8 bytea roles, including unresolved targets |
| raw.poly_source | Exact token sidecar, original POLY/input descriptors and verified WKB |
| spatial.node_point / boundary | Canonical points and verified multipolygons, explicit types/SRID and GiST indexes |

Use bigint for accepted positive signed-int64 IDs. Explicitly validate producer integer domains; the JSON schema's decimal regex alone does not impose int64 bounds. Store timestamp scaling exactly in numeric. Source strings use bytea; empty bytes, SQL NULL and absent fields remain distinct. Controlled region identifiers and Atlas enums may use text.

Preserve the complete accepted IR contract. Retain every original object/block line below the existing 32 MiB record ceiling, with source header/auxiliary/index provenance and original PBF/POLY descriptors. Do not claim to reconstruct original protobuf wire bytes from JSONL.

Independently validate source-object ordinal continuity, block references, parent object types, metadata presence/value consistency, contiguous child positions and optional-location cardinality/ranges. PBF block numbers may have gaps because auxiliary blocks are distinct from object ordinals. Do not invent a visible flag: that history shape is unsupported by the current profile and remains so.

Add occurrence-to-canonical-object referential integrity after reconciliation. Do not add target FKs that reject admitted dangling relation members. Missing way nodes remain blocking per source, not merely after cross-region union.

### Exact semantic equality

Deduplicate only the same (type, ID) with complete equal semantic values. A digest is an index/filter, followed by full equality; test a forced digest collision.

Preserve order and duplicates, metadata presence, actual version/changeset/UID/user values, timestamp value, reconstructed coordinates, reference/member roles and location presence. No Unicode normalization, tag sorting, duplicate collapse, longitude wrapping or newest-version conflict resolution.

Source ordinal/block, compression, string-table slot numbers, encoded-coordinate values and timestamp ticks may differ when reconstructed values and presence agree. In particular, user_sid presence is significant, while its numeric string-table index is encoding provenance; compare the resolved user value. Preserve all excluded encoding details in per-source rows.

Different complete semantic values block the candidate and retain both source identities. Mixed vintages with agreeing objects are visible warnings, not a conflict resolver.

## 4. Import and independent verification

Use bounded client-side Psycopg COPY FROM STDIN, never server filesystem/PROGRAM privileges. Validate compressed identity, single complete Zstd framing, declared expansion, record/schema limits and total object cap. Include blocks, sidecars and all copied output descriptors in input/spool/expansion accounting, not just the object stream. Reject an over-budget declared input before copying or decompressing it and enforce the same bounds against actual reads. Bound batches by bytes and rows, handling a permitted large record without unbounded child-row accumulation.

Commit bounded chunks into an inaccessible LOADING candidate. On interrupted/failed import, terminate that execution. Retry uses a fresh generation, candidate UUID, database and credentials; no arbitrary mid-stream resume. Publication-only resume may retain an already FROZEN validated database and exact bundle intent.

Reconstruct records from independent SQL projections, not by rereading only record_line. Compare complete canonical source-order digests, block data, metadata, tags, references and locations with the spooled registered IR. Separately compare every stored original line and per-source versus deduplicated counts.

Initially derive node points and verified boundaries only. Preserve exact raw nanodegrees separately from spatial floats. Way/relation geometries may be explicitly not-derived. Relation-only input is eligible with zero points and unavailable node extent when its declared requirements pass.

Import accepted boundary WKB/token provenance under the existing provider-plane multipart/exclusion/antimeridian/Antarctica policy. No repair, filtering or reinterpretation to force validity. Validate mandatory presence separately from validity, plus SRID, type, dimensions, emptiness, indexes and spatial probe results/plans.

Before READY verify exact extension/schema/importer versions, ownership identity, all coverage/fidelity/reference checks, reader access and complete bundle digests. Counts alone are insufficient.

## 5. Provisioning, freeze and generation ownership

Use a dedicated candidate cluster independent of control clusters. The reviewed amd64 image pin is approved for pull and acceptance verification:

`docker.io/postgis/postgis:17-3.7@sha256:6bb0c694d6f06201b49d447fd9689ab57f3c7662de621ca35939cc57aafc522b`

Verify the pulled platform/digest and actual PostgreSQL 17.12 / PostGIS 3.7.0 plus native library versions. Do not silently substitute a tag/digest/version or upgrade the existing control cluster.

A dedicated provisioner alone holds candidate administrative credentials. Web/intake/verifier receive none and no Docker socket. Provisioner requests are bounded typed operations over recorded execution identities, not arbitrary SQL or user-supplied database names.

Journal role/database creation before autocommit DDL. Use never-reused names containing the full candidate UUID/generation within identifier limits. Record cluster system identity, owner role OID, database OID and execution marker. Create the unique owner role before database creation so the pre-marker crash window can be reconciled using the journal, cluster, name and exact owner OID. Unknown or mismatched ownership is quarantined, not adopted or deleted.

Use an execution-specific NOLOGIN owner and a separate LOGIN loader with only candidate-local loading rights and no owner membership, SUPERUSER, CREATEDB or CREATEROLE. Extension installation is provisioner work. A stale loader has no credentials for another generation.

Before FROZEN/reader validation: stop and disable the loader, revoke further access, terminate its existing candidate connections and transfer any loader-owned objects to the NOLOGIN owner. REVOKE alone is insufficient while the loader still owns objects. Prove it cannot reconnect, regain owner membership or write.

Use a separate actual reader login with SELECT/USAGE/CONNECT only and no ownership or administrative membership. Deny effective write paths through PUBLIC/default grants, including unnecessary large-object creation/write and SECURITY DEFINER routines. Test denied DML/DDL, TEMP creation and large-object writes after disabling transaction_read_only; that setting alone is not enforcement.

Validate ownership/lease before and after external steps; keep control transactions short and outside COPY, DDL or hashing. Use a supervisor/control connection for heartbeats and bounded cancellation. Identify cancellable backends by candidate/execution/role and backend identity, not an unchecked PID alone. A stale process may leave an old orphan but cannot affect a new target or register READY.

Proposed candidate states are CREATE_INTENT, LOADING, FROZEN, VALIDATING, BUNDLE_PREPARED and READY, with explicit failure/publication-paused outcomes and append-only executions. Journal create/freeze/drop and reconcile every external-operation gap. Do not recreate or overwrite an existing database merely because its name matches.

Bound transient per-operation retries to at most three with backoff; reconcile ambiguous DDL before retry. Failed loading is a terminal execution, not an automatic import loop.

## 6. Capacity and deployment

Use one isolated fixture stack/control plane, with distinct new candidate storage. Preserve the five historical stacks and their accepted inputs, outputs, schedules and databases. Do not pause, migrate or reconfigure their services without separate authorization.

Coordinate intake, verifier and builder reservations in the active control plane using the shared lock/order and filesystem identity. Charge outstanding versus already allocated bytes without double-counting. READY databases, retained failures, WAL/temp, spool and bundle/log storage all consume capacity even after a builder slot is released.

Older clusters do not participate in that lock. Before the VM pilot, perform an external read-only preflight of their modes, queued/running work, upcoming schedule windows, reservations and resource use. Require a documented quiescent pilot window. Reserve conservative legacy headroom of at least one frozen per-run cap per legacy scope plus one per-attempt cap for each deployed legacy verifier, with a 10% allocation margin; use any larger observed outstanding commitment instead. Derive and record the actual amount from the deployment inventory. This is additional to the new execution reservation and 20 GiB free reserve. Stop new work if legacy writer/queue/schedule or container inventory changes during the pilot. Do not treat this headroom, zero reservations once, sampled health or the active-plane lock as a cross-stack guarantee. If this cannot be established, complete source/tests but stop VM build acceptance and report the blocker.

Initial limits:

| Resource | Approved pilot ceiling/condition |
| --- | --- |
| Active builders | 1 |
| Builder | 0.5 CPU / 1 GiB RAM |
| Candidate cluster | 1 CPU / 1.5 GiB RAM |
| Provisioner | 0.25 CPU / 256 MiB RAM |
| Execution wall time | 5 minutes for fixtures; no live/Monaco execution in this approval |
| Input | At most 512 MiB declared uncompressed object IR, 2 million objects, and 1 GiB aggregate decoded input streams |
| Heap/TOAST / indexes | 4 GiB / 2 GiB |
| Retained WAL / aggregate temp | 2 GiB / 1 GiB |
| Client spool/scratch | 1 GiB |
| Bundle and logs | 64 MiB combined per execution |
| New execution storage reservation | 12 GiB including headroom |
| Aggregate new build root | 32 GiB |
| Filesystem free reserve | At least 20 GiB after outstanding commitments and legacy headroom |
| Host memory | Admission at least 4 GiB available and sufficient uncommitted headroom; stop build growth below 2 GiB |
| Build I/O | Aggregate physical reads 20 MiB/s and writes 10 MiB/s |

Use initial shared_buffers 256 MiB, work_mem 8 MiB, maintenance_work_mem 128 MiB, bounded connections and no parallel query/maintenance workers. Account for process/operation multiplication and all new services when checking memory headroom.

Prove effective cgroup CPU/RAM/I/O enforcement and device attribution. If I/O enforcement is unavailable, do not silently relax the limit. Monitor actual database/index/TOAST/WAL/temp and host growth; configuration WAL limits are not hard quotas. Reserve termination/checkpoint/rollback margin and cancel before exhausting it. A process/statement timeout plus supervised termination must bound this builder's work; do not inherit an unbounded blocking-call assumption.

Keep at most one retained failed candidate database within 6 GiB and an automatic-cleanup grace of 24 hours. New admission must include that retained capacity and block if safe limits cannot be honored. Early cleanup requires an audited explicit operator action after preserving failure evidence; automatic cleanup waits for the grace. Only proven owned, quiescent, never-READY failed resources may be dropped. Unknown ownership and READY candidates are never automatic cleanup targets. Fault tests may clean their own disposable fixture targets through the same checked provisioner protocol.

Do not delete inbox/verification/history to free space. Iran exceeds this pilot and requires separate capacity approval. Wider unattended multi-stack operation is outside this pilot's accounting guarantee.

## 7. Bundle and readiness

Use these separately scoped persistent purposes, adapting the QA deployment prefix without touching existing roots:

- candidate-postgres: PostgreSQL-managed cluster storage.
- build-work/<intent>/<generation>: private spool, scratch and staged bundle.
- database/<date>/<candidate-id>/README.md and postgis/: immutable metadata/index, not copied PGDATA.
- separately mounted, scoped secret files outside Git.

Freeze the bundle date from the actual build-request instant in Asia/Tehran. Retain UTC/zone, retrieval dates and source vintages independently; the 2031 Automatic QA date is not the PBF timestamp.

Generate versioned build and validation manifests, README and a bundle index. The index lists exact digests of the other files and excludes itself; register its digest in control metadata. Include scope, request order, candidate/cluster/database/owner identity, complete PBF/boundary coverage, exceptions, source vintages, verification fingerprints, versions, independent reconciliation, privilege and resource results.

Use a logical database fingerprint, not live PGDATA hashes. Publish no-overwrite, generation-fenced files with file/directory synchronization. Register READY only after full publication, final database identity/privilege checks and current input/coverage eligibility under short ordered locks.

Publication failure retains the FROZEN database and exact bundle intent, releases the active builder slot and allows audited publication-only resume. A source invalidation revokes current readiness eligibility while preserving original evidence; the Part 1D handoff must revalidate instead of trusting a permanent Boolean. It exposes no session/activation action.

## 8. Implementation and acceptance sequence

1. Implement the string-fidelity PostgreSQL regression and control-report migration first. Prove existing successful/failed records, handoff behavior and immutable output hashes survive; pass a NUL-bearing fixture through normal 1B publication.
2. Add models/migrations, disabled-by-default activation/scope, transactional admission, request ordering, coverage/exception/shrink checks and active-plane capacity accounting. Test upgrade with zero historical backlog.
3. Add the isolated cluster/provisioner, unique ownership journals, generation fencing, raw COPY and independent SQL reconciliation.
4. Add freeze/reader security, spatial validation, bundle publication, restart recovery and minimal authenticated operator/progress/diagnostic views. Use role checks and CSRF for mutations.
5. Run complete PostgreSQL regression and both migration checks, including a fresh install and upgrade from the accepted schema. Use real candidate PostgreSQL/PostGIS and reader/provisioner roles.
6. On the exact committed image, run a newly created controlled fixture through the normal verification completion seam and automatic builder to READY. Fixture setup may register synthetic inputs only in the isolated QA database; it must not fabricate successful verification, handoff, candidate validation or READY states. Record every transition and exact IDs/digests.
7. Prove relation-only success with zero node extent, valid-empty/boundary-only refusal, corrupted/invalidation refusal, exact duplicate/conflicting overlaps, same IDs across types, encoding-only differences, forced hash collisions, ordered duplicates, NUL/Unicode/empty/presence, nondefault coordinate/date precision and optional locations.
8. Inject failure/cancellation/worker death before and after each DDL/control/bundle boundary, including create-before-marker, stale loader connections, wrong owner OID, missing database, interrupted COPY, publication pause, source invalidation and tampering. READY publication must be unique and incomplete artifacts ineligible.
9. Keep a READY fixture under a stable real-reader probe while building a second candidate. Demonstrate CPU/RAM/I/O/storage/wall limits, low-disk cancellation, restart identity and all original input/output hashes. Recheck the established 17 historical runs and 38 successful output files through read-only paths.
10. Leave all live source batches unbuilt and un-reverified. Report the actual lack of live eligibility; do not weaken policy or select a passing region from a failed batch.

Predeclare and measure zero probe errors; web p95 <= max(100 ms, 5x baseline), max <=2 s; reader p95 <= max(50 ms, 5x unloaded baseline), max <=1 s; controlled scheduler delay <=5 s; intake/verifier/builder heartbeat ages <=45/15/10 s. Record provider-blocking effects separately. Report effective cgroup limits, OOM deltas, sampled/peak distinctions, database/index/WAL/temp growth and cumulative WAL generation.

Retain the first actual check results and diagnose failures. Do not rerun until green without explanation.

## Delivery

Preserve unrelated VM checkout work. Implement and commit on feat/phase-1c-fixture-builder, test that exact candidate, push through the authorized GitHub route and open a new draft PR against main. Verify the published tree.

Return tested SHA and image/tree identities, migrations/upgrade and full test results, fixture/handoff/intent/candidate identities, DDL ownership/recovery and independent reader evidence, manifests/README hashes, resource/load measurements, historical integrity/restart checks and material gaps.

Keep data, database files, credentials and private logs outside Git. Do not merge this PR, deploy into old stacks, activate a release or start Part 1D.

## Codex prompt — implement the fixture pilot

> On the designated Atlas VM, fetch origin/main and read this approved brief at the supplied commit. Verify merged PR #3 is present and create feat/phase-1c-fixture-builder, preserving unrelated work.
>
> Implement the bounded Part 1C fixture pipeline through a genuine immutable READY candidate. Start with the mandatory end-to-end NUL/control-report storage regression and lossless migration, then implement durable scoped automatic admission, coverage/overlap enforcement, generation-owned provisioning, bytea raw import, independent SQL/spatial/reader validation, fenced publication and capacity/recovery controls.
>
> Preserve accepted 1A/1B behavior, historical outputs and whole-batch geometry policy. Keep live admission disabled. Use only the isolated fixture deployment and approved resource/preflight limits; do not modify old stacks or verify/import live batches.
>
> Run the required full regression, migration/upgrade, real PostGIS fixture/fault/load/restart and historical integrity acceptance on the exact candidate. Push and verify the branch, open a new draft PR, and return exact identities, evidence and gaps. Do not merge or activate anything.

## Evidence and primary references

The VM review report is retained privately at /home/owner/projects/.atlas-phase1c-review-b3157b8/review-summary.json. Its capacity figures are observations, not import benchmarks.

- [Accepted IR](https://github.com/pouriya-sedaghat/atlas/blob/b3157b8f4f5a99961b75e94c6336d1c56ca0d551/atlas_verification/schemas/object-v1.json)
- [Source previews](https://github.com/pouriya-sedaghat/atlas/blob/b3157b8f4f5a99961b75e94c6336d1c56ca0d551/atlas_verification/records.py)
- [Verification persistence/publication seam](https://github.com/pouriya-sedaghat/atlas/blob/b3157b8f4f5a99961b75e94c6336d1c56ca0d551/atlas_verification/worker.py)
- [PostgreSQL JSON restrictions](https://www.postgresql.org/docs/17/datatype-json.html)
- [CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html), [REVOKE](https://www.postgresql.org/docs/17/sql-revoke.html) and [COPY](https://www.postgresql.org/docs/17/sql-copy.html)
