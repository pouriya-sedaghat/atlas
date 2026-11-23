# Part 1C Fixture Builder Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with TDD and one fresh whole-branch review at completion.

**Goal:** Carry a newly opted-in controlled fixture through real verification, automatic durable admission, owned PostGIS loading, independent validation and immutable READY publication.
**Architecture:** Bytea-backed verification reports preserve accepted strings. A transactional verification outbox feeds a Control-first scoped dispatcher; a separate builder supervises typed provisioning and bounded imports in unique candidate databases. Original source occurrences and SQL projections are independently reconciled before reader-only validation and bundle publication.
**Tech Stack:** Accepted Python/Django/Psycopg/Zstd runtime; PostgreSQL17.12; approved PostGIS3.7.0 image pin.
**Spec:** docs/briefs/phase-1c-fixture-implementation.md at9c88e039896d415f8d6d6d9365002cbb54d58ff9.

## Global Constraints

- Fixture-only, disabled by default; explicit durable epoch/profile and QA database guard. No history backlog, no live batch verification/import, no activation/Part1D.
- Five historical stacks remain untouched; isolate all migrations/tests/deployment. Preserve17 historical runs,38 verification outputs and1108 completed POLYs plus recovered PBFs.
- Begin with genuine NUL/report failure, lossless compatibility migration and successful real1B handoff before candidate provisioning.
- Approved image docker.io/postgis/postgis:17-3.7@sha256:6bb0c694d6f06201b49d447fd9689ab57f3c7662de621ca35939cc57aafc522b.
- Builder0.5CPU/1GiB; candidate1CPU/1.5GiB; provisioner0.25CPU/256MiB; fixturewall300s;1builder;12GiBreservation;20GiBfree;legacyheadroom+10%;32GiBnewbuildroot.
-512MiBobjectIR;2millionobjects;1GiBtotaldecoded/spool;sourcerecord<32MiB;heap4GiB,index2GiB,WAL2GiB,temp1GiB,bundle+logs64MiB;aggregatephysicalI/O20MiB/sread10MiB/swrite.
- Provisioner alone holds candidate admin; ownerNOLOGIN, restricted loader, actual reader; no Docker socket. External DDL/file intents journaled and fenced.
- Preserve accepted IR/manifests/version/policy and immutable prior bytes. Exactcandidate image fullPGsuite/migrations/upgrade/fault/load/restart required. No merge.

## Review Focus

- NUL in source-derived keys, user/role/header/summary and diagnostic errors survives ORM and panel boundaries.
- Out-of-order outbox commits, source invalidation and baseline advancement cannot reverse order or admit shrinking coverage.
- Ambiguous create-before-marker, stale loader/backend identity and publication resume cannot adopt or affect another target.
- Large children/records, Zstd framing and nondefault numeric domains are bounded without truncating valid values.
- Cross-stack reservations and physical device accounting are not equivalent to one control-row lock or soft PostgreSQL settings.

### Task 1: Lossless verification storage
Files: atlas_verification/{fields,diagnostics,models,worker,views}.py; migrations/0002; tests/test_verification_reports.py and upgrade harness.
Interfaces: LosslessJSONField preserves dict API; diagnostic_text escapes controls. Existing handoff API unchanged.
- [ ] Add real-child NUL sampled tag/user/role/key/header fixture and ORM/error/panel regressions; observe PostgreSQL RED.
- [ ] Bytea report/progress fields and explicit data migration; authoritative values unchanged; diagnostics escaped.
- [ ] Run focused GREEN, full baseline, and old-schema isolated-copy upgrade/digest/API checks before Task3.

### Task 2: Durable admission and capacity
Files: atlas_build/{models,control,inputs,capacity}.py; migrations; verification completion seam; fixture binding/activation; tests/test_build_control.py.
Interfaces: outbox registration in publisher transaction; dispatcher Control-first; current_handoff/spool; capacity reservations.
- [ ] RED admission/scope/epoch/order/rollback/replay/coverage/graph/range tests, then implement.
- [ ] Preserve old APIs/bytes; explicit fixture manifest/handoff binding; profile/bootstrap/shrink evidence.

### Task 3: Owned provisioning and raw import
Files: atlas_build/{provision,raw,importer,semantic}.py; owned schema SQL; tests/test_build_raw.py and test_build_provision.py; separate fixture deployment.
Interfaces: typed bounded provisioner requests; database identity journal; stream COPY from private verified spool.
- [ ] RED ownership/ambiguous-DDL/stale-role/dedup/domain/encoding/collision/fidelity cases, then implement.
- [ ] Freeze loader rights/connections, independent SQL reconstruction and actual reader privilege checks.

### Task 4: Supervision, validation and immutable bundle
Files: atlas_build/{worker,validate,bundle,views,urls}.py; commands/templates; capacity integration with new-plane workers.
- [ ] RED generation/cancellation/deadline/resource/publication/invalidation/panel tests, then implement.
- [ ] Short fenced registration, immutable READY evidence, bounded pause/resume and checked cleanup.

### Task 5: Exact-candidate acceptance
Files: deployment config/runbook and controlled fixture/fault/load harnesses.
- [ ] Preserve first actual logs, fresh install/old-copy upgrade/fullPGsuite/bothmigrationchecks.
- [ ] Preflight and monitor all legacy inventory; prove effective CPU/RAM/physicalI/O before VM import.
- [ ] Commit candidate, build/check image identities, normal real fixture->READY and relation-only; negatives/fault/load/caps/restart/hashhistorical.

### Task 6: Review and draft PR
- [ ] Fresh whole-branch reviewer; material fixes RED/GREEN plus full regression; record rulings/gaps.
- [ ] Push exact tested candidate, verify tree, new draft PR main, attach URL. Never merge/activate.
