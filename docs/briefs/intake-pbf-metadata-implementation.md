# Atlas intake — approved PBF metadata implementation

**Status** — Technical acceptance complete at `1d40f0479faae127eff0f3c40f129b37cc2fedd4`, recorded in [the PR #3 acceptance](../reviews/pr-3-intake-acceptance.md). Both existing runs sealed, and the approved recovery allowance is consumed. PR #3 remains draft with merge pending explicit user approval. The original implementation instructions below are retained as history; do not repeat the recovery helper. The next assignment is [Part 1C review only](phase-1c-candidate-database.md).

## Baseline and approval decision

Start from PR head `4db5d45bdfcaa478cbb64641b8300ec6ddf9283a`. Fetch and incorporate the current main documentation without discarding the approved updates predicate, explicit POLY handling or direct POLY pin preservation.

The read-only VM report confirms that each of the two existing runs has 554 complete POLYs and one failed/retryable PBF. All 1,108 POLYs, totaling 9,154,700 bytes, matched their recorded hashes. The PBFs have six retained failures each, generation 6, empty resolved URL/pin and no accepted body.

The latest matched HEAD/GET pair on the diagnostic Monaco dated URL timed out for both methods. Earlier successful diagnostic GETs and the new failed pair remain evidence. The fallback is an approved resilience mechanism, not a demonstrated recovery guarantee or proof of the transport cause.

Accept the reported request bound of six opens for latest metadata resolution, six for dated pin metadata and five for its mandatory sidecar, totaling at most 17 before ordinary download. The nominal 204 seconds at 12 seconds per open is not a hard wall-clock guarantee. Blocking calls and sidecar reads can overrun that arithmetic. Fenced renewal between network steps is required.

## Implementation contract

### PBF-only metadata helper

Introduce a private metadata helper used by `Client.resolve_pbf()` and `Client.pbf_pin()`, reusing the existing `_request()` validation. HEAD remains the normal method.

Before transport exceptions are normalized, preserve bounded structured context for the validated current URL, method, metadata operation/phase, redirect count and typed reason. Preserve existing public error-code/retry behavior for unaffected paths.

Allow at most one HEAD-to-GET switch per metadata operation for:

- A direct `TimeoutError`.
- A positively typed wrapped timeout, such as an `URLError` whose bounded, explicitly handled wrapping terminates in `TimeoutError`.
- An explicit HEAD response status 405 or 501.

Do not classify errors by message text. TLS failures, arbitrary connection errors, 401/403, missing targets, rejected redirects, invalid metadata, changed validators and checksum errors retain their existing handling. HTTP 408 and 504 do not authorize fallback. Do not fall back again if GET fails.

After HEAD has followed an allowed redirect to a dated URL, issue fallback GET to that same validated dated target. Do not restart from latest. If no dated target was observed, GET may start at the original frozen latest URL and resolve only under the existing exact-region dated-target guard.

HEAD and GET share the existing four-redirect allowance. A method switch does not reset the allowance or introduce another retry loop. Keep the existing per-request timeout, ordinary artifact retry policy and download budgets unchanged.

### Header-only GET and normal verification

Send no Range request. A metadata GET must satisfy the existing successful full-representation status and identity-encoding rules and provide a valid positive full-file Content-Length. Reject 206. Close the response on every success/error path without application body reads or draining its contents.

Zero application reads does not imply zero network buffering. Neither metadata nor diagnostic bytes can complete an artifact.

Retain all existing length, strong/weak ETag, Last-Modified and conditional transfer checks. Resolve and persist the dated target through the existing lifecycle before checksum-dependent pin completion. Require the exact dated MD5 sidecar. The actual file must still pass ordinary streaming, complete length, provider MD5, local SHA-256 and fenced publication.

Once dated resolution is registered, retry/checksum failure/restart cannot select another target or replace accepted validators. A fully pinned retry bypasses metadata resolution. Do not add diagnostics to old pin JSON or rewrite historical records.

### Operation-local observer, audit and ownership

Pass an optional observer per metadata operation. The worker binds it to artifact ID, generation and operation identity. Keep observer state, counters and redirect context local to that call; the Client is shared between transfers.

Use the existing audit storage for bounded structured events containing phase, method, validated target, trigger/status/typed reason, elapsed time and outcome. Persist request starts before opening the connection so an interrupted operation is distinguishable from a completed request. Cover the mandatory checksum step within the pin operation's trace as well as metadata requests.

Adopt a maximum of 40 trace events with at most 4 KiB of serialized JSON payload per event for one artifact generation's metadata/pin attempt. This bounds trace payload to 160 KiB, excluding database/index overhead. Combine redirect information with request outcomes instead of duplicating it as extra events. Bound fields and event counts before writing; retain essential target/failure identity and make any truncation visible within the cap. Do not log credentials, arbitrary raw exception text, response bodies or unbounded stacks.

Before each network step, validate current ownership and renew the active lease in a short transaction. Renew heartbeat only following a successful ownership check. Use the existing lock order and release database locks before network I/O. Recheck ownership at the following step/outcome before renewing or registering success.

Never revive an expired lease or superseded generation. Retain `_owned()` checks before resolution/pin persistence and existing publication fencing. A lost claim must stop further metadata, checksum or download work and close any response. A stale operation may retain its already-written starts/history; it must not record a successful current-generation result or mutate its replacement.

Keep general catalog, page, POLY, sidecar transport semantics and ordinary download behavior intact. The sidecar is traced/fenced within the PBF operation, not given a new method fallback. Existing test providers may accept an optional observer argument while preserving their default behavior.

### Deterministic deadline tests

Correct `VerificationRecoveryTests.test_exit_between_polling_passes_still_enforces_the_deadline` with two deterministic real-process cases:

1. A real child writes the expected report and exits. Synchronize completion, then advance a controlled worker monotonic clock before the final deadline check. Require deadline rejection, preserved `nodes: 123`, no publication and no handoff.
2. A real child signals readiness and remains blocked without a report. Synchronize readiness, then advance the controlled clock while the child is alive. Require termination, deadline rejection and no handoff, without assuming unavailable counts.

Use bounded synchronization and reliable child/process-group cleanup. Patch the worker clock rather than the host clock or production deadline. Retain meaningful real-process coverage. Do not extend arbitrary sleeps, weaken assertions or hide the original failed log. No verifier production change is approved without a separately established defect.

## Required candidate checks

Add meaningful regression coverage for:

- HEAD success with no GET; direct/typed wrapped timeouts and 405/501 fallback; all excluded failure classes, including HTTP 408/504 and TLS errors.
- Continuation at the already-observed dated target, a single method switch and shared redirect exhaustion.
- Rejection before contacting a wrong origin, region, path or file kind in either method.
- Closed responses and forbidden body reads for accepted/rejected metadata GETs; positive, absent, malformed and conflicting lengths, encodings and 206.
- Strong/weak validators; exact dated sidecar; missing/malformed sidecar; ordinary body checksum mismatch and truncation.
- Unresolved, resolved-but-unpinned and fully pinned retries; restart and stale/expired-generation fencing, including a network operation that outlives its claim.
- Attributed success/failure/interruption events, payload/event limits and concurrent artifact trace isolation.
- Full normal worker publication/seal after timeout, successful metadata GET, valid sidecar and complete body; diagnostic/metadata/partial responses cannot seal.
- Both deterministic deadline branches with real processes.

Run the complete PostgreSQL suite, both migration checks and `git diff --check` against the exact candidate image. Keep pinned dependencies, Compose resource limits and persistent storage. No schema change is expected for existing audit JSON/context.

Retain original failure logs and report the first actual suite result. Any further test failure needs diagnosis; do not use repeat-until-green as acceptance.

## Approved live recovery scope

Use only the isolated `atlas-poly-smoke` deployment and its existing persistent data. Updating that stack to the tested candidate and restarting it for acceptance is authorized. Preserve other stacks.

| Origin | Existing run | PBF artifact |
| --- | --- | --- |
| Manual | `2b4190fc-9c4e-4dd6-a67a-88c225fe512b` | 555 |
| Automatic | `6e1ba035-e183-4b6f-b2dc-cf366c9e4724` | 1110 |

1. Before recovery, confirm the expected catalog/run/artifact identities and retry eligibility. Rehash all 1,108 completed POLYs and retain the established historical run/verification/output baseline. If the state differs, inspect and report the actual change before retrying; do not reset it.
2. Through the authenticated CSRF-protected operator path, request only the two unfinished PBF retries. Their origin remains Manual/Automatic respectively; a new schedule or run is unnecessary.
3. Because neither PBF has accepted a dated resolution, the normal guarded Client may establish the then-current dated target from its frozen latest URL. Do not import the diagnostic `261120` target, its bytes or any guessed metadata as a pin.
4. Allow at most one new operator retry cycle per PBF on this candidate, using its existing bounded automatic attempts. Preserve all prior failures. If transport still fails, stop this acceptance attempt and report incomplete outcomes with the new traces. Do not loop recovery indefinitely or replace Monaco with another region.
5. Record the actual method/phase/target/validator/sidecar/body evidence, generation/lease behavior and final artifact/run state. A run seals only when its final PBF has been genuinely acquired, verified and published.
6. Rehash every completed POLY after recovery. Restart only this stack, verify metadata and all completed files, then compare the historical scope, including the 38 previously successful verification output files. Verify any newly completed PBF against recorded lengths, MD5 and SHA-256.
7. Record health and heartbeat observations during recovery. State separately which POLYs were acquired on `4db5d45...` and which PBF resolution, transfer and publication stages used the new exact candidate. Reusing the accepted boundary bytes is approved; a new full-catalog download is unnecessary.

If HEAD succeeds normally during acceptance, retain that genuine outcome. Deterministic tests must still prove the fallback path. Do not force a live network failure or claim that a live fallback happened when it did not.

The whole-batch verification policy and accepted Jiangsu finding remain unchanged. Recovery/sealing is acquisition acceptance, not a new Part 1B verification or Part 1C build.

## Delivery and review

Push the exact VM-tested candidate to the existing `fix/geofabrik-updates-url` branch and verify the published tree. Update draft PR #3 around its final compatibility and recovery behavior, with the tested SHA, image/tree identities, commands/results, source/audit evidence hashes, real recovery/seal outcomes, restart/integrity checks and remaining gaps.

Keep retained failures, full data and private diagnostics outside Git. Keep the PR in draft and do not merge. Successful fallback behavior in fixtures and successful live recovery are separate claims; report each accurately.

## Codex prompt — implement the approved follow-up

> On the designated Atlas VM, fetch origin/main and the existing PR #3 branch. Read this brief at the supplied commit. Continue from reviewed candidate 4db5d45bdfcaa478cbb64641b8300ec6ddf9283a, preserve unrelated work and incorporate the current main documentation.
>
> Implement the approved PBF-only metadata helper, typed failure/target context, operation-local bounded audit observer, fenced between-step lease renewal and deterministic real-process deadline tests. Preserve all source identity, redirect, checksum, completed-file and verification-policy invariants.
>
> Run the complete PostgreSQL suite and both migration checks on the exact candidate. Then perform the narrowly approved recovery of only artifacts 555 and 1110 through the normal authenticated retry path, with the one-cycle limit and before/after restart/hash evidence. Preserve the 1,108 completed POLYs, run IDs and histories.
>
> Push the exact tested candidate, verify the published tree and update the same draft PR #3. Return the tested SHA, commands/results, audit and live recovery evidence, actual seal outcomes and material gaps. Keep the PR in draft for review. This is the separate implementation instruction following the read-only design report.
