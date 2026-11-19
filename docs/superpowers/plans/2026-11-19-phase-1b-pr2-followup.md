# Part 1B PR #2 Follow-up Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent inspector and handoff tasks; the coordinator implements resource accounting and acceptance orchestration.

**Goal:** Complete the approved PR #2 corrections and update the same draft with exact-candidate evidence.

**Architecture:** Preserve atlas-input-v1 extraction, frozen source identities and Jiangsu's blocker. Add a narrow pinned-Osmium no-node-bounds count adapter, integrate a real positive child/publication/handoff test, and record cgroup enforcement plus attempt-scoped OOM deltas. Diagnose current provider rejection and measure matched transfer phases without changing intake compatibility policy.

**Tech Stack:** Django/PostgreSQL, generated proto2, Zstd, pinned Osmium/GEOS, Docker Compose/cgroup v2.

**Spec:** docs/briefs/phase-1b-pr2-followup.md at 40f8e46a58a200dbeb1450c9cf4df0065aa8dfc6; updated implementation brief at the same revision.

## Global Constraints

- Continue feat/phase-1b-verification from reviewed baseline 2f63eba7b280fe8947d88f0b1843a7a66ba7708c and preserve unrelated work.
- Keep memory.max at 2,147,483,648 bytes, one CPU, one hour, 20 GiB per attempt, 60 GiB root and 20 GiB free reserve.
- Keep original sealed corpus and all original negative reports/receipts. No geometry repair, exception, relaxed source allowlist or silent repin.
- Treat actual allocation/OOM evidence as resource failure; report transient lifetime peaks, sampled attempt peaks, RSS and file cache distinctly.
- One exact-candidate corpus rerun may reuse old two-attempt fidelity evidence if extracted bytes and live-corpus outcomes match; otherwise run two complete new attempts.
- Evidence and real data remain outside Git. Publish through the authorized connector, fast-forward the existing branch and update draft PR #2.

## Review Focus

- A generic inspector error or malformed/failed count invocation must block; it must not masquerade as the known JSON presentation failure.
- Relation-only input with no node bounds must receive the same mandatory full-file count reconciliation when admitted by the decoder.
- A real child must publish a complete successful result, and output corruption must revoke its handoff.
- Historical OOM events must not poison a new attempt; an event during that attempt must prevent a successful handoff.
- Transfer phase failures and partial bytes must remain in evidence; controls must share the same dated identity and bounded byte limit.

## Task 1: Inspector correction (independent agent)

**Files:** atlas_verification/execute.py; tests/test_verification_pipeline.py; optional tests/test_verification_inspector.py.

**Interface:** osmium_check(source, expected_counts, directory) retains the current nonempty behavior; the fallback records adapter version, commands/raw results, exact counts and absent bounds.

- [x] Add failing valid-empty and relation-only fixtures and generic-error/count-error/malformed/mismatch cases.
- [x] Reproduce failures against baseline. Implement only the known pinned JSON no-bounds adapter with three --extended --get=data.count.<kind> invocations on the same spool.
- [x] Require successful exit and strictly bounded nonnegative decimal output for every kind; reconcile all three counts.
- [x] Verify focused tests and freeze owned files for review.

## Task 2: Integrated positive handoff (independent agent)

**Files:** tests/test_verification_handoff.py.

**Interface:** normal request_verification -> VerificationWorker actual child -> fenced publication -> get_handoff(verify_outputs=True).

- [x] Declare a small synthetic sealed catalog and valid PBF/POLYs under temporary isolated storage.
- [x] Execute parser, native inspector, publication and handoff without mocking the child, complete or publish.
- [x] Assert manifest/input/output identities and one successful result; alter a registered output and assert handoff rejection.
- [x] Verify the test on PostgreSQL without concurrent database test runs, then freeze.

## Task 3: Resource interpretation and diagnostics (coordinator)

**Files:** atlas_verification/resources.py; atlas_verification/worker.py; tests/test_verification_resources.py; docs/operator-verification.md.

- [x] Add failing tests for effective limits, memory/swap/stat snapshots, lifetime versus sampled peaks and OOM event deltas.
- [x] Record cgroup before/after and sampled observations; block on new OOM events while preserving partial reports. Retain enforced limits and peak values.
- [x] Update operator documentation for the accepted memory interpretation and supported empty-input adapter.

## Task 4: Provider diagnosis and matched observation (independent agent prepares, coordinator executes)

**Files:** bounded acceptance harness and evidence under /home/owner/projects/.atlas-verification-smoke, outside Git.

- [x] Capture exact rejected public URL, JSON catalog field and validation rule, plus current last-known-good and frozen identities.
- [x] Prepare matched idle/concurrent transfers using one validated dated pin, retaining successes/failures/partial bytes, CPU time, provider open/read and local write/fsync timing.
- [x] Include bounded controlled local replay to separate local contention from unstable provider I/O; restore any deliberately paused verifier child automatically.
- [x] Propose any provider compatibility adjustment as a focused review item; do not implement it in this follow-up.

## Task 5: Final candidate and PR update (coordinator)

- [x] Review integrated changes before expensive live checks. Run full PostgreSQL suite and both migration checks.
- [ ] Create/fetch exact candidate with the main documentation parent; verify local/GitHub trees and image source; run the full suite in that image.
- [ ] Run positive, valid-empty and relation-only acceptance cases on the exact candidate; preserve original corpus reports.
- [ ] Re-verify the live Iran/554-POLY corpus, record effective cgroup limits/swap/OOM deltas and matched transfer observations, compare all semantic/input identities against baseline.
- [ ] If bytes or corpus outcomes differ, repeat two complete new attempts and explain. Restart Compose and rehash retained/source outputs.
- [ ] Fast-forward the tested branch using a lease, update the same draft PR with new/reused evidence, commands, measurements and remaining gaps; verify published SHA/tree.
