# PBF metadata fallback and recovery plan

> Use superpowers:executing-plans and TDD, with independent deadline-test work and final whole-change review.

Goal: implement the approved PBF-only fallback and recover only existing artifacts555/1110.
Spec: docs/briefs/intake-pbf-metadata-implementation.md at4b38dcc93d85d8d8e965f890352f67ffde42e83f.
Baseline:4db5d45bdfcaa478cbb64641b8300ec6ddf9283a.

Constraints: preserve updates/explicitPOLY behavior, frozen identities, all1108completedPOLYs, pinned dependencies/limits and verifier production code. No new runs/schedules/catalog refresh. One normal operator retry cycle per PBF on the exact tested candidate.

1. Add Client regression coverage before implementation. Introduce per-call metadata operation context, typed bounded timeout classification and sharedredirect HEAD-to-GET switch, tracing checksum without changing its HTTP policy.
2. Add PostgreSQL worker tests for attributed capped audit and ownership/heartbeat fencing, durable partial resolution/full pins, stale claims and actual publication. Use existing Audit JSON; no migration.
3. Correct two deterministic real-process deadline tests independently. No productionverifier edits; preserve original failedlog.
4. Run first fullsuite+bothmigrationchecks and retain result. Diagnose failures. Obtain independent source review and cover material fixes with RED/GREEN.
5. Create exact candidate with approvedmain docs, build image, run fullPostgreSQLsuite/bothmigrationchecks/imagediff and verify shipped sources.
6. Rehash1108POLYs and established historicalscope before recovery. Update only atlas-poly-smoke stack. AuthenticatedCSRF retries only555/1110, maximumonecycleeach. Observe real metadata/sidecar/body/audit/state outcomes; no forcednetwork failures.
7. RehashPOLYs/newPBFs after recovery, restartonlythisstack, recheckmetadata/files/historical38verificationoutputs. Publish testedbranch, verifytree, update same draftPR3 with actual outcomes,gaps and hashedprivateevidence.
