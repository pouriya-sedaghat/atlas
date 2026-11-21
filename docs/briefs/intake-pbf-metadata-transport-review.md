# Atlas intake — PBF metadata transport review

**Status** — Review only. Review the bounded metadata fallback and deterministic test correction below on the Atlas VM, then report before implementation. Continue with draft [PR #3](https://github.com/pouriya-sedaghat/atlas/pull/3). Keep its current acquisition evidence and draft status.

## Review result and frozen baseline

The reviewed head is `4db5d45bdfcaa478cbb64641b8300ec6ddf9283a`, tree `cf8ba66827afbbd63eb1c496e65a13435970a279`, image `sha256:5ccd72995593d1930c88963096cc897971260b7a3713e20633462f8ff90bbf0f`. It includes the previously approved updates predicate and explicit catalog POLY support.

The source review found the advertised URL, canonical identity, cache invalidation, override precedence, legacy fallback and direct POLY pin preservation consistent with the approved brief. Project review reran 26 provider tests and six pure `ExplicitProviderTests` methods on fetched source matching the pinned Git blobs. The six methods were run in isolation from Django imports. The complete 207-test PostgreSQL result and both migration checks remain VM-reported evidence, not a separate local database execution.

Normal refresh promoted 554 direct mappings with zero unresolved regions. Both registered runs completed all 554 POLYs and failed Monaco PBF resolution after bounded automatic and operator retries. Neither run sealed.

| Origin | Existing run ID | Recorded state |
| --- | --- | --- |
| Manual | `2b4190fc-9c4e-4dd6-a67a-88c225fe512b` | 554 complete POLYs, one failed PBF |
| Automatic | `6e1ba035-e183-4b6f-b2dc-cf366c9e4724` | 554 complete POLYs, one failed PBF |

Their Monaco source is `https://download.geofabrik.de/europe/monaco/monaco-latest.osm.pbf`. Both PBF records have empty `resolved_url` and pin, with no accepted PBF body or checksum. Retain the exact catalog FK, paths, intent, six failure attempts per PBF and completed POLY fingerprints.

The retained read-only diagnosis observed a timeout while performing HEAD on the resolved dated Monaco target, with successful time-separated GET observations, including a GET with no-cache. This supports investigating a metadata fallback. It does not establish the root cause or show that a diagnostic GET satisfies an artifact.

## Review objective and limits

Determine the smallest safe change that allows PBF metadata acquisition when HEAD is unavailable while preserving dated-target pinning and full transfer verification. Also propose a deterministic correction for the reported verifier deadline test.

During this review:

- Inspect the exact source, retained HTTP traces and failing test log before issuing further probes.
- Do not edit application or test source, change deployments, alter HTTP policy, retry registered runs, change artifact pins or import diagnostic bytes.
- Do not repeat complete catalog discovery or re-download all POLYs. Existing evidence already demonstrates that path.
- Do not raise timeouts, disable TLS/proxy controls, bypass redirects, change source hosts, use a different region to replace Monaco, add a source exception or change verification policy.
- Return a report and concrete proposed code/test changes. Implementation requires the separate follow-up instruction.

## Bounded transport evidence

If the retained traces do not answer a question, use at most three HEAD/GET pairs on the same validated dated target. Use the existing Client opener, public allowlist, timeout and redirect limits. Stop starting probes once a three-minute diagnostic budget is exhausted and let any already-started bounded request finish. Alternate method order where useful.

Match User-Agent, Accept-Encoding identity, Cache-Control no-cache, URL and connection/proxy/TLS configuration across the pair. Record method, validated URL, redirects, request headers, status or sanitized exception class/reason, elapsed time and response length/validators. Record DNS/TLS/connect/first-header timing only where existing tooling exposes it. Do not infer a specific transport phase from a generic `network_failure`.

For a GET metadata probe, inspect headers and close the response without calling body-read methods or draining the file. Report zero application body reads separately from unknown socket/server buffering. Keep diagnostic files outside the registry and outside Git. A successful GET is evidence about that particular request, not proof that HEAD fails universally or that a full download and checksum will succeed.

## Preferred fallback to evaluate

The proposed scope is PBF metadata only, in `Client.resolve_pbf()` and `Client.pbf_pin()`. Preserve the normal HEAD path. Reuse existing URL, response, redirect and metadata validation rather than creating a weaker HTTP path.

Evaluate these requirements and identify any implementation conflict before coding:

1. Allow at most one GET fallback per metadata operation after a positively classified HEAD timeout, or an explicit HEAD 405/501 response. Preserve a sanitized structured transport reason before the current broad exception normalization. Do not infer timeout from an arbitrary exception message.
2. Other failures retain their original handling. In particular, no fallback should conceal a rejected redirect, TLS validation failure, 401/403, missing target, changed validator, malformed metadata or checksum failure. A failed fallback returns through the existing bounded artifact retry policy.
3. If HEAD has already followed a validated redirect to a dated target, GET that same dated target. Do not restart from latest and choose a different date. If no dated target was observed, a GET of the original frozen latest URL may resolve only through the existing exact-region dated-target guard.
4. Share the metadata operation's existing redirect allowance across HEAD and fallback. Do not reset it for each method or introduce nested retries. Retain the existing per-request timeout. Calculate the request/time budget through both metadata operations and the checksum lookup, and explain how it interacts with the worker's active lease and ownership checks.
5. The preferred GET sends no Range and accepts only the existing successful full-representation status and encoding rules. Read response metadata, require the existing positive PBF Content-Length, then close immediately with no application body reads. Do not interpret Content-Length from a one-byte partial response as full-file length or widen accepted download statuses.
6. Retain all existing strong/weak ETag, Last-Modified, length and conditional transfer checks. The exact dated MD5 sidecar remains mandatory. Metadata fallback alone never marks an artifact complete or publishes bytes.
7. Persist resolution before checksum-dependent pin completion using the existing lifecycle. Once a dated resolution or full pin is registered, retries cannot select a new source target or replace the accepted validators. An established pin should continue to bypass metadata resolution.
8. Record the failed HEAD and fallback outcome with target, phase, reason and method in artifact/generation-attributed evidence. Explain how successful and failed fallback traces are retained without cross-contaminating concurrent artifacts or changing historical pin JSON.
9. Keep POLY/catalog/page/sidecar requests and general download behavior unchanged. Avoid a global fallback or a broad acceptance of partial content.

HTTP defines HEAD as retrieval of representation metadata without response content. A GET response can also supply representation metadata, but it may start sending its body. Therefore response closure, identity checks and actual-byte verification remain separate requirements. The standard alone cannot explain this provider's observed timeout.

If a smaller approach is preferable, compare it with the requirements above. Do not silently implement an alternative.

## Regression plan to return

Propose tests for:

- Existing HEAD success without an additional GET.
- Classified direct/wrapped timeout and 405/501 fallback; no fallback for the excluded failures.
- Same dated target after an observed redirect, with no new latest selection.
- Rejection before requesting a wrong host, region, path or file kind under either method, and preservation of the shared redirect limit.
- Response closure and no body reads on successful or rejected metadata GETs.
- Missing/invalid/conflicting lengths, unexpected encodings, weak and strong validators and changed metadata.
- Exact dated checksum sidecar, missing or malformed sidecar, mismatch and truncation during the eventual ordinary download.
- Unresolved, resolved-but-not-pinned and fully pinned retries, including restart/generation fencing and auditable failed fallback.
- Full registered publication/seal after HEAD timeout and successful metadata GET, checksum and body acquisition. Test that a diagnostic response or partial transfer cannot seal.

Explain which tests are pure Client tests and which need PostgreSQL and the normal worker. Preserve existing tests and their evidence rather than replacing a failing assertion with a weaker condition.

## Verifier test finding

The initial suite failure was `VerificationRecoveryTests.test_exit_between_polling_passes_still_enforces_the_deadline`, with missing `counts`. The pinned test sets a 0.1-second deadline while its child sleeps 0.75 seconds before writing `report.json`. Depending on polling and scheduling, the worker may kill the child before that report exists. A failure report then legitimately has no child counts to preserve.

This is a source-based explanation of a timing race, to be checked against the retained failed log. It does not demonstrate a new verifier production defect.

Propose a deterministic fixture that distinguishes:

- A child that has exited with a report, followed by an elapsed-deadline final check. Deadline rejection must preserve that report's counts and expose no handoff.
- A child stopped before producing a report. Deadline rejection must succeed without assuming unavailable counts.

Use controlled clock/process/poll synchronization for the specific branch. Retain meaningful process integration coverage. Do not solve this by increasing arbitrary sleeps, hiding the failed log, weakening the deadline or rerunning until green. Limit any eventual correction to tests unless the review establishes a separate production defect.

## Proposed later acceptance

After the report and implementation approval, the expected validation is the complete PostgreSQL suite and both migration checks on the exact new candidate, plus normal authenticated operator retry of only the unfinished Monaco PBF in each of the two existing runs. Preserve all completed POLYs and append failures/successes to existing histories. Rehash all 554 completed POLYs per run and the established historical sample/output scope before and after recovery and an isolated Compose restart.

If both existing runs seal through the normal worker with valid dated MD5 and full-body digests, that can close their acquisition gap without recreating their accepted boundary transfers. Record which stages used the earlier candidate and which completed on the new exact candidate. The report should confirm that this reuse is valid for the actual frozen state.

This is an acceptance design, not permission to run recovery during the present read-only review. If upstream HEAD recovers without a source change, report that option with exact evidence before proposing unnecessary compatibility code.

## Codex prompt — review only

> On the designated Atlas VM, fetch origin/main and the existing PR #3 branch. Read this brief at the supplied commit and inspect candidate 4db5d45bdfcaa478cbb64641b8300ec6ddf9283a plus its retained evidence.
>
> Review the bounded PBF metadata fallback, exact-target/retry/lease/audit contracts, proposed deterministic deadline-test correction and reuse of the two existing runs for later acceptance. Use only the permitted bounded read-only probes. Do not modify source, deployments, schedules, runs, pins or completed files.
>
> Return findings ordered by severity, exact failing phase and sanitized matched-method observations, proposed code/test changes, request/resource bounds and any decisions needed. Keep PR #3 in draft and await the separate implementation instruction.

## References

- [PR #3 candidate and evidence](https://github.com/pouriya-sedaghat/atlas/pull/3)
- [Pinned provider](https://github.com/pouriya-sedaghat/atlas/blob/4db5d45bdfcaa478cbb64641b8300ec6ddf9283a/atlas_intake/provider.py)
- [Pinned acquisition worker](https://github.com/pouriya-sedaghat/atlas/blob/4db5d45bdfcaa478cbb64641b8300ec6ddf9283a/atlas_intake/worker.py)
- [Pinned deadline regression](https://github.com/pouriya-sedaghat/atlas/blob/4db5d45bdfcaa478cbb64641b8300ec6ddf9283a/tests/test_verification_worker.py)
- [RFC 9110, HEAD](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2), [Content-Length](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6) and [range responses](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7)
- [Python 3.14 urllib.request](https://docs.python.org/3.14/library/urllib.request.html)
