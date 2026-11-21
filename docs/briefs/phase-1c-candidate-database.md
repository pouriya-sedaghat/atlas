# Atlas Part 1C — candidate PostGIS build design review

**Status** — Review only. Prepare a VM-grounded implementation proposal before development. Parts 1A/1B are accepted. PR #3 is technically accepted at `1d40f0479faae127eff0f3c40f129b37cc2fedd4`; its merge is pending explicit user approval. Read that pinned candidate while the merge is pending. Do not merge it or implement Part 1C under this brief.

## Goal and phase boundary

Part 1C automatically turns a successful, build-eligible Part 1B handoff into an isolated PostgreSQL/PostGIS candidate, automatically verifies that database, and records a durable ready-for-publication result with README and manifests.

Part 1D owns active-release selection, session pinning, rollback, draining and permanent expiration. A Part 1C READY candidate is not an active or published release. Map/routing/geocoding engines and external consumer contracts remain later phases.

Review [the Phase 1 architecture](phase-1-data-foundation.md), [accepted 1B contract](phase-1b-input-verification.md), current handoff implementation and [PR #3](https://github.com/pouriya-sedaghat/atlas/pull/3). Return findings and an implementation plan; await the separate implementation instruction.

## Current evidence and eligibility gate

The recovered Manual run `2b4190fc-9c4e-4dd6-a67a-88c225fe512b` and Automatic run `6e1ba035-e183-4b6f-b2dc-cf366c9e4724` each contain Monaco PBF plus all 554 POLYs. They are sealed acquisition runs. This does not establish a current build-eligible verification.

The older Iran verification had a blocking Jiangsu boundary finding under the whole-batch policy. Preserve that result. Do not assume the newly acquired boundaries have the same geometry or that the new runs are build-eligible. Inspect existing verification records and output fingerprints; report what is actually available.

Use `get_handoff(..., verify_outputs=True)` and the versioned manifests as the eligibility boundary. A sealed run, an individually passing region inside a failed batch, a boundary-only result or a valid-empty PBF is insufficient. Revalidate current eligibility and all registered digests before build admission and before READY registration. Do not weaken 1B policy or silently repair a source boundary.

If no usable live handoff exists, propose a positive controlled-fixture acceptance and a later manual verification of the new source batch through the normal panel. Do not launch that verification during this review. A blocked real input and a successful controlled fixture must be reported separately.

## Proposed policies for implementation review

These are the proposed initial 1C rules. Confirm feasibility, identify gaps and return the final policy/DDL before they become implementation instructions.

| Concern | Proposed initial rule |
| --- | --- |
| Trigger | A durable automatic job follows successful verification only when its handoff is build-eligible |
| Identity | Bind input/handoff manifest-byte digest, coverage intent, importer version, database schema version and policy/tool versions |
| Work | One bounded builder initially, generation-fenced claims and append-only execution history |
| Raw identity | OSM object type plus full-width OSM ID |
| Overlap | Deduplicate semantically identical objects; preserve every regional source/provenance edge; block conflicting objects |
| Vintage | Preserve each input's source timestamps and receipt/verification times separately; never pick a conflicting object by newest timestamp |
| Coverage | Explicit complete build intent; no implicit carry-forward or silent coverage shrinkage |
| Candidate | One separate database per candidate, independent of the control database |
| Publication | Database verification and metadata publication produce READY only; no active pointer or sessions yet |

For coverage, distinguish selected-PBF coverage from boundary-only coverage. Require all expected PBF regions in the frozen build intent. Initial 1C should block a missing region rather than silently filling it from an old input. Return a proposal for comparing intent with the last ready/published baseline and handling the first explicit bootstrap. Any future carry-forward must name currently eligible verified source handoffs and vintages; it cannot extract an apparently valid region from a rejected batch.

Describe which source-encoding details may vary for semantically identical objects. Preserve source ordinal, block precision and original source payload as provenance even if those details are excluded from a deduplication key. Different metadata presence, ordered tags/references or reconstructed coordinates must not be normalized away to make an overlap appear identical.

## Required architecture proposal

### Durable lifecycle and external operations

Propose control models for build intent, candidate, execution/generation, DDL intents, validation results and published bundle fingerprints. Specify idempotency and intentional rebuilds, queue admission, leases, retry classes and cleanup ownership.

Job creation must be durable with successful verification registration, or use an equally durable reconciled dispatcher. Explain upgrade behavior so old fixture/history handoffs do not suddenly start an unbounded import backlog.

PostgreSQL database creation/deletion execute outside transaction blocks. Journal intent before issuing DDL and reconcile the resulting database afterward. Use deterministic safe names and generation-specific ownership markers. A stale worker must not adopt, delete or mark READY a database belonging to another generation. Cleanup must not touch control databases, previous candidates, inbox inputs or verification outputs.

Keep control locks short and outside imports/DDL. Account for cancellation, worker death, database creation before metadata commit, partial import, validation failure and publication interruption. A failed new candidate must leave existing serving data usable.

### Raw schema and streaming import

Recommend an Atlas-owned authoritative raw schema and an import path from the accepted JSONL/Zstd intermediate representation. Preserve everything admitted by the approved 1B schema:

- Exact typed identities, coordinates/precision and source timestamp values.
- Metadata presence separately from explicit zero/empty values.
- Ordered tag pairs including duplicates.
- Ordered way references and relation members, including duplicate entries and unresolved relation targets.
- Per-extract provenance and source ordinal.

Return DDL, keys, indexes and representative import/query examples. If JSONB is proposed, demonstrate compatibility with the accepted value domain and use ordered arrays where order/duplicates matter. Do not rely on a feature-oriented importer as the only lossless store. Explain a bounded client-side streaming COPY path, staging/transaction strategy, restart semantics and independent import reconciliation.

Reconcile per-source object/reference counts separately from deduplicated candidate counts. Keep missing way-node references blocking and accepted missing relation members visible under the current policy. Do not drop a raw object because a derived geometry is unavailable.

### PostGIS and database verification

Propose the initial geometry contract without preempting Phase 2 engines. At minimum evaluate node points and verified regional boundaries with explicit column types/SRIDs and indexes. Preserve exact raw coordinates independently of floating spatial representations.

Carry forward 1B's approved multipart, exclusion, antimeridian and Antarctica interpretation. Do not repair shapes with an automatic MakeValid operation or infer validity from a non-null bbox. Check required geometry presence separately from validity; nullable or unavailable derived geometry needs an explicit finding.

Automatic database verification must cover extension/schema versions, actual coverage, raw/count/provenance reconciliation, reference findings, spatial types/SRIDs/validity, required indexes and representative probe results. Test real privilege enforcement with a separate reader role, including denied writes/DDL. A row-count match alone is insufficient evidence of fidelity.

### Deployment, privilege and storage mapping

Recommend a dedicated PostGIS cluster separate from the existing control cluster, initially with one database per candidate. Evaluate how the later serving and concurrent build workload would share or isolate resources; do not assume database-name separation provides CPU/I/O isolation.

Identify an appropriate pinned PostgreSQL/PostGIS image/dependency combination without changing the accepted runtime during review. Keep privileged provisioning separate from web/intake/verifier and ordinary reader credentials. Prefer controlled PostgreSQL administration over granting the application a Docker socket.

Return exact persistent paths and a nonsecret mapping to the user's `database/<date>/postgis` and README concept. Include a candidate/release ID for multiple same-day builds. Explain which paths hold PostgreSQL-managed data and which hold immutable build metadata or exports. Do not rename or copy live PGDATA directories to represent individual databases.

Recommend the bundle date/zone rule, retaining input retrieval dates and source vintages separately. The existing Automatic QA run's 2031 directory date is not its PBF data timestamp.

### Bundle and readiness contract

Define versioned build/validation manifests and a generated README listing PBF regions, boundary-only regions, sources/vintages, verification IDs/digests, warnings and candidate status. Describe isolated candidates accurately; do not label them published before Part 1D.

Publish README/manifests through no-overwrite, generation-fenced durable file publication. Register the exact complete bundle and verified database identity before exposing READY. Recheck input validity after potentially long reads/imports.

Describe the immutable handoff to Part 1D, including ordering assigned when work is requested, database identity, bundle-byte digests, schema/policy/importer versions, coverage and readiness evidence.

## Read-only VM work

Use repository reads, bounded filesystem/metadata inspection, existing container inspection and read-only SQL as needed. Record current CPU/RAM/disk use, all relevant persistent mounts and outstanding intake/verification reservations. Inspect successful verification metadata without modifying it. Reuse established evidence rather than rescanning the full Iran corpus.

Do not edit source/tests/deployments, apply migrations, install packages, pull/run new images, create/drop databases, launch imports/verification, change schedules/runs or modify prior outputs. Do not publish or activate anything. Keep private observations outside Git.

Distinguish measured facts, estimates and proposed implementation benchmarks. Recommend explicit CPU/RAM/wall/scratch/output/database/WAL/index budgets, filesystem reserve and failure-retention limits. Include temporary duplication and concurrent worker reservations; do not estimate database size directly from compressed PBF bytes.

The pilot must fit the actual VM. Larger Iran and multi-region builds need their own measurements. Return a staged small-fixture/current-Monaco/Iran plan rather than promising capacity for every catalog selection.

## Acceptance plan to return

Provide a concrete implementation test/measurement plan covering:

1. Automatic idempotent admission from a real successful handoff; no admission from invalidated, empty/boundary-only or corrupted outputs.
2. A small lossless fixture with full-width IDs, metadata presence, ordered duplicate tags/members and exact coordinates; independent SQL-to-IR reconciliation.
3. Two extracts with identical overlap, conflicting overlap, mixed vintages, missing relation members and coverage omission.
4. Actual PostGIS schema/geometry/index and reader-permission checks, including boundary edge cases from 1B.
5. Creation/import/validation/publication failures and restart recovery, stale-generation and concurrent-trigger races, output tampering and source invalidation during work.
6. README/manifest atomicity and readiness; no activation or session changes.
7. Database/WAL/index/scratch growth, resource peaks and low-disk termination. Proposed import-load probes must measure web latency, scheduler delay, verifier/intake health and a stable read-only database probe.
8. Controlled positive fixture success and actual live-input eligibility/outcome, accurately distinguished. No source exceptions or geometry policy changes to force a positive result.

Recommend numerical probe thresholds and resource limits with rationale before implementation. Existing idle or acquisition-only health samples do not establish build-load isolation.

## Report and next instruction

Return prioritized findings, exact code/data seams, proposed DDL/state transitions, dependency/privilege/storage choices, coverage/overlap policy decisions, measured capacity and unknowns, failure/recovery design and staged acceptance commands. Identify the smallest coherent implementation slice and decisions needed.

This task is review only. Keep PR #3's merge decision separate. Wait for the approved implementation brief before coding Part 1C.

## Codex prompt — review only

> On the designated Atlas VM for https://github.com/pouriya-sedaghat/atlas, fetch origin/main and read this brief at the supplied commit. Inspect accepted PR #3 candidate 1d40f0479faae127eff0f3c40f129b37cc2fedd4 if it is not yet merged.
>
> Perform the read-only Part 1C design and capacity review. Evaluate eligible verification handoffs, the lossless PostgreSQL/PostGIS schema, durable automatic build/verification lifecycle, coverage/overlap rules, external DDL recovery, resources and immutable readiness bundle.
>
> Do not modify source, deployments, data, schedules or databases, and do not launch verification/imports or merge PR #3. Return the concrete findings, schema/state/storage/resource proposal and acceptance plan. Await the separate implementation instruction.

## Primary references

- [PostgreSQL 17 CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html)
- [PostgreSQL 17 DROP DATABASE](https://www.postgresql.org/docs/17/sql-dropdatabase.html)
- [PostgreSQL 17 COPY](https://www.postgresql.org/docs/17/sql-copy.html)
- [PostGIS geometry validity](https://postgis.net/docs/ST_IsValid.html)
