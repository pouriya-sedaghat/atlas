# Atlas Phase 1 — architecture and first delivery brief

**Status** — Draft for Codex review and project approval. The current assignment is to review this brief on the designated Atlas VM and report findings. Implementation begins with a separate instruction after approval.

## Purpose and delivery order

Atlas is an independent provider of OpenStreetMap geographic data. Phase 1 establishes a repeatable, auditable path from Geofabrik downloads to verified PostgreSQL/PostGIS releases. An internal probe will exercise dataset routing and session continuity before consumer engines exist. Map, routing, geocoding and reverse geocoding are Phase 2. Consumer-facing contracts belong to Phase 3.

| Part | Deliverable | Review evidence |
| --- | --- | --- |
| 1A | Geofabrik region catalog, administrator panel, manual and scheduled retrieval, durable inbox | VM smoke run with Iran PBF and POLY, a POLY-only region, and restart and failure tests |
| 1B | Administrator-triggered verification by date and run, full OSM scan and versioned manifests | Real sample statistics and fixtures for corrupt inputs, missing references, and boundary edge cases |
| 1C | Automatic build of an isolated PostGIS candidate and automatic database verification | Import reconciliation, end-to-end validation evidence, and serving-load isolation measurements |
| 1D | Automatic release promotion, session pinning, lifecycle controls, and recovery | Concurrent-session cutover, rollback, drain and expiration tests, and an operator runbook |

Codex reviews the brief for each part and reports findings before receiving an implementation prompt. Implement and test approved changes on the designated VM, push a branch to this repository and open a PR with verification evidence. Project review and acceptance of that part precede the next implementation. Keep application source, migrations, test fixtures and operational docs in Git. Runtime inputs, manifests, database files, credentials and production logs belong outside Git.

## Phase 1 architecture

### Control plane and data plane

Use an administrator web application, a background worker with a persistent scheduler, and a PostgreSQL control database for catalog revisions, schedules, jobs, artifacts, audits, releases, and sessions. Propose a small VM deployment with separate application and worker processes, a managed persistent filesystem for the inbox and release artifacts, and distinct roles for administration, downloads, builds and read-only serving. Each release is a new physical PostgreSQL database with PostGIS. Keep the control database independent of release databases. Benchmark resource contention and decide from VM evidence whether the serving and build instances need distinct PostgreSQL clusters or hosts. Limit worker CPU, memory, I/O and disk usage, including scratch space and the capacity needed for the active and incoming releases.

Use stable IDs for catalog revisions, retrieval runs, verification attempts and releases. Each job has a durable state, claim/lease or equivalent, progress and an audit trail. Use transactional job creation where the control database owns both the state change and the job row. When a workflow crosses PostgreSQL DDL or the filesystem, reconcile partial operations after restart. Retried work cannot overwrite a sealed input or publish an incomplete candidate.

### Source, inbox and manual verification

Geofabrik's public catalog defines the hierarchy of areas and public PBF availability. A retrieval run freezes its catalog revision and PBF selection. Request POLY by default for every region in that revision, including those without a selected PBF. A POLY describes the provider's clipping area for display as such in the admin panel. Keep the retrieval time, provider data timestamp and, when available, replication metadata distinct. The same retrieval date can contain multiple runs and different upstream data timestamps.

Proposed inbox layout, using the configured Atlas timezone for manual runs and the schedule timezone for automatic runs. Record the applied timezone with each run and persist instants in UTC:

```text
inbox/asia/iran/YYYY-MM-DD/<run-id>/iran.osm.pbf
inbox/asia/iran/YYYY-MM-DD/<run-id>/iran.poly
inbox/asia/iran/YYYY-MM-DD/<run-id>/manifest.json
database/YYYY-MM-DD/<release-id>/README.md
```

Allow deeper region paths. Derive safe local path segments from validated catalog ancestry and preserve the upstream ID in metadata. The database directory holds release artifacts and documentation. PostgreSQL manages its own database storage. Each release README lists the regions with published PBF data, distinguishes polygon-only coverage, and records release ID, input and manifest references, data timestamps, schema version, and OSM source and attribution.

The admin panel groups completed and incomplete runs by local date, showing each region and file status. The operator selects a specific sealed run within a date and starts verification. Verification opens each artifact by its immutable identity, confirms its fingerprint and streams the entire PBF. Preserve original input bytes and retain all available node, way and relation fields, tags, ordered references and relation member roles through a lossless extraction path. Keep the manifest bounded. It records provenance, size and checksums, source and retrieval timestamps, parser and schema versions, object counts, bounds, tag and relation summaries, reference diagnostics, polygon validity and the outcome with errors or warnings. The batch manifest pins the per-region manifests and the expected feature coverage. Public Geofabrik PBFs omit OSM contributor user, UID and changeset fields. Evaluate Osmium/libosmium for full scans and reference checks.

Define which anomalies block verification. An unreadable or truncated file, checksum mismatch, or missing expected PBF blocks a build. Assess dangling references at extract edges separately from unreadable data, recording their types and counts. Validate POLY outer rings, holes, and multipart coverage with verified fixtures. Flag unavailable or invalid POLY explicitly. Establish which polygon failures block a release based on its declared coverage. A new verification attempt on sealed input reuses the same fingerprints and records its own outcome.

### Automatic candidate build and verification

Successful intake verification automatically enqueues the candidate build. Bind the build to the verified manifest digest, importer version and migration version. Build in an isolated target, create an Atlas-owned raw schema and required spatial indexes, and use a separate read-only serving role. Store nodes, ways, relations, tags, and ordered references via streaming import and reconcile them against the input manifests. Keep an Atlas-owned schema boundary even if importer software uses its own internal tables.

Specify the policy for overlapping and mixed-vintage extracts before implementing multi-region imports. Treat identifiers as distinct by OSM object type. Deduplicate identical objects and preserve region provenance. Block ambiguous or conflicting overlaps until there is a reviewed reconciliation policy. Prohibit silent coverage regressions when a subset of regions is retrieved. A candidate must satisfy the declared release coverage before promotion, with explicit approval for coverage shrinkage. The part 1C brief will choose how unchanged verified regional inputs are carried forward and how source vintages are represented.

Automatic candidate checks cover PostGIS and schema versions, expected/input versus actual coverage and row counts, spatial column types and SRIDs, declared geometry validity criteria, indexes, permissions and probe queries against recorded fixtures. Preserve raw objects when a derived geometry cannot be formed and record the applicable rejection or warning. Persist the result and README before promotion. A build or verification failure leaves the current serving release available.

### Promotion and session lifecycle

Resolve the active release in the control database when an Atlas data session opens. Persist the chosen release ID with the session and reuse it for all requests until close or expiry. Serialize promotion and new-session admission against the same control record so a session sees a single admissible release even during cutover. Validate candidate reachability through the serving identity before the pointer changes. Use an explicit publication generation to prevent an older job that finishes late from replacing a newer release. Keep in-flight requests and live session leases attached to their original release. Use a defined lease renewal and maximum session lifetime policy, include in-flight requests in drain completion, and make the admin view distinguish logical Atlas sessions from PostgreSQL pool connections.

| Admin status | Operational meaning |
| --- | --- |
| Active — current | Default target for new sessions |
| Active — draining | Existing sessions continue, admission is suspended |
| Inactive | Retained release, available for audited reactivation after a readiness check |
| Expired | Terminal release ID with an audit tombstone after required purge evidence |

For the first successful release, set the default pointer. For later automatic promotions, assign new sessions to the verified candidate and drain the former release. Once the drain completes, retain it as inactive for rollback. For an administrator-initiated deactivate or expire on an active release, require a verified, available replacement, either newer or older. Suspend new admissions to the target and wait for logical sessions, requests and target database connections to clear as appropriate. Rollback is a promotion of an eligible retained release for new sessions. Sessions already attached elsewhere retain their routing. Block retirement of the last serviceable active target after bootstrap.

Expiration is irreversible for the target release. Track purge progress separately and mark the release expired only after the agreed scope has been cleared. Before part 1D, agree on database backups, snapshots, WAL, dumps, replicas, shared verified inputs, and whether reconstruction of matching contents under a new release ID counts as recovery. A database drop alone does not establish irrecoverability. PostgreSQL database creation and deletion run outside the control database transaction and require retry-safe reconciliation.

Single-VM acceptance covers a cutover while Atlas remains online, end-to-end probe traffic under a concurrent import, and restart recovery. Host-outage availability depends on the eventual deployment topology. Set measurable error-rate and latency thresholds using the VM baseline before implementation of promotion. Carry source and ODbL attribution into releases and review applicable redistribution obligations before external service.

## Part 1A — requirements for the first implementation brief

1. **Catalog and selection.** Read the public Geofabrik index and persist a last-known-good validated revision with parent links and exact region IDs. Show a searchable region tree in the admin panel and allow explicit selection of each published PBF, including parent extracts. Expanding or selecting a parent does not implicitly select descendant PBFs. Handle slash-containing provider IDs, missing optional URLs, catalog changes and shared display names. Represent POLY intent separately and enabled by default for the entire catalog, with its own status. The documented index does not promise POLY URLs. Review the use of verified public region-page links or a tested provider mapping and explicit exceptions. Surface unexpected missing POLY as a source issue. If an earlier boundary is displayed, label it with its retrieval date and stale status.
2. **Manual and automatic retrieval.** Manual launches a Geofabrik run from the authenticated admin panel. Automatic uses a persistent schedule with date, time and an IANA timezone, shows the next occurrence, and invokes the same job path with the saved selection. Propose one-off versus recurring semantics, overdue behavior, and changes during an in-flight run. Switching to manual suppresses future automatic dispatch. A dispatched run uses its frozen settings. Use a stable occurrence key and ensure duplicate manual submissions and scheduler restarts cannot create a second run for the same request or occurrence. Distinct intentional same-day runs receive distinct IDs.
3. **Transfers and durability.** Stream files to bounded temporary storage, verify provider checksums where available, compute SHA-256 for local identity, handle timeouts and truncation, and use bounded retry and backoff. Test how the provider's mutable latest URLs and checksum sidecars are exposed. Document how to detect an upstream change during transfer and distinguish verified upstream checksums from local fingerprints. Define the checksum-unavailable policy in the review report. Atomically publish finalized files within the same filesystem and reconcile worker crashes around file publication and metadata commit. Track each missing, failed, pending and complete file separately, and give the operator a safe retry for eligible failures. Pin completed file records to the run. The retrieval metadata in 1A supplies inputs to the later verification manifest.
4. **Operator interface and security.** Show mode, next scheduled instant and timezone, catalog selection, retrievals grouped by date, run and per-region status, retryable errors, and audit events with actor and timestamp. Require authentication and role checks for panel actions, with CSRF protection where cookie-based. Restrict egress to the approved Geofabrik HTTPS endpoints, validate destinations including redirects, and validate local paths and file sizes. Use least-privilege credentials, VM-managed secrets, bounded concurrency, disk preflight and redacted logs. Keep a small deploy and restart runbook with health checks and tests for the worker.
5. **Acceptance on the designated VM.** Demonstrate one real Iran PBF + POLY acquisition and one POLY-only region without committing either file. Confirm that the frozen catalog marks every region for POLY and accounts for provider exceptions. Exercise scheduled retrieval using a controlled clock or schedule fixture, including the configured timezone, restart recovery, duplicate triggers and mode switch. Exercise partial download, incorrect checksum, interrupted finalization and disk pressure with controlled fixtures. Demonstrate the admin flow and prove that a repeated attempt cannot overwrite a successful same-day artifact. Provide a reproducible VM setup and verification log with evidence suitable for a public PR. Full PBF content verification and release writes start in later parts.

## Codex prompt — review only

> Work in the designated Atlas VM session. Connect your workspace to https://github.com/pouriya-sedaghat/atlas.git and read `docs/briefs/phase-1-data-foundation.md` on `main`. You may clone or fetch the repository in the designated VM for this review. Verify the brief against the repository and inspect the VM with read-only checks for OS, available CPU/RAM/disk, installed tools, persistent volumes, Git access and approved outbound connectivity. If a check is unavailable, identify what is unverified and continue the review.
>
> Review the Phase 1 architecture and assess the feasibility of Part 1A. Inspect representative Geofabrik catalog, PBF, POLY, and checksum endpoints with bounded requests. Report observed URLs and capabilities without downloading large extracts for this review. Propose the smallest maintainable application stack and deployment model for the VM, an explicit schedule and timezone policy, provider checksum and POLY discovery behavior, persistent run and artifact models, and the restart and failure cases that the implementation must handle. Address overlaps, partial coverage, release/session boundaries and permanent expiration as design risks for the later parts. Identify material gaps and propose concrete changes to this brief.
>
> Return an English report in this session with the repository ref reviewed, environment facts and checks performed, prioritized findings, recommended Part 1A implementation steps, proposed acceptance evidence, and decisions that require project approval. Stop after the report and await an explicit implementation instruction. The review assignment does not authorize application code changes, installation, deployment, scheduled jobs, destructive operations, or repository pushes.

## References

- [Geofabrik extract technical details and catalog schema](https://download.geofabrik.de/technical.html)
- [Geofabrik public region catalog](https://download.geofabrik.de/index-v1.json)
- [Geofabrik Iran extract and polygon links](https://download.geofabrik.de/asia/iran.html)
- [Osmium full-file inspection](https://docs.osmcode.org/osmium/latest/osmium-fileinfo.html) and [OSM reference checks](https://docs.osmcode.org/osmium/latest/osmium-check-refs.html)
- [Osmosis polygon filter format](https://wiki.openstreetmap.org/wiki/Osmosis/Polygon_Filter_File_Format)
- [osm2pgsql import and output behavior](https://osm2pgsql.org/doc/manual.html)
- [PostGIS geometry validity](https://postgis.net/docs/ST_IsValid.html)
- [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html), [database creation](https://www.postgresql.org/docs/current/sql-createdatabase.html), and [database deletion](https://www.postgresql.org/docs/current/sql-dropdatabase.html)
- [OpenStreetMap copyright and license](https://www.openstreetmap.org/copyright) and [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
