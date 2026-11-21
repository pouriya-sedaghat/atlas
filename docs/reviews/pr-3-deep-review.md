# PR #3 — deeper pre-merge review

**Decision** — The reviewed commit `1d40f0479faae127eff0f3c40f129b37cc2fedd4` is approved for merge within the accepted pilot scope. This second review identified no merge-blocking defect. The user subsequently granted explicit authorization for this exact merge. PR #3 was merged through the normal API at `32f8bcd4759d6d005f28ca38fe095efa84059e56`, retaining tested head `1d40f0479faae127eff0f3c40f129b37cc2fedd4` as a parent.

## Independent review performed

The head and full tree `4fa1204cd9cf8ed6a3abf5b610f790aa362a8b8c` were fetched again. All 108 locally materialized blobs matched that tree: 105 non-documentation files and three documentation files. Nine additional documentation blobs were not materialized in that snapshot; relevant requirements and review records were read through GitHub.

The second pass examined failure paths and cross-function invariants rather than relying only on green test counts.

| Area | What was checked | Result |
| --- | --- | --- |
| Catalog compatibility | Optional POLY normalization, legacy canonical bytes, URL-only digest/cache invalidation, scoped mapping/exception precedence and frozen historical rows | Consistent with approved contract |
| HTTP trust boundary | Public HTTPS origin/path validation before each request, rejected redirects, response status/encoding/length rules and no Range | No new weaker HTTP path found |
| Fallback eligibility | Typed direct/bounded wrapped timeout, TLS exclusion, HEAD 405/501 and no message matching or repeated GET fallback | Allowed/excluded cases behaved as specified |
| Dated identity | An observed dated target survives method switch; redirect through latest cannot select another date; shared redirect count | Additional state scenarios preserved identity and request bounds |
| Metadata versus bytes | GET metadata responses close without body reads; dated sidecar remains mandatory; ordinary full transfer, digests and publication stay separate | No metadata-only completion path found |
| Claims and concurrency | Operation-local state, Control → Run → Artifact locks, ownership/expiry checks around metadata steps, persistence and publication fencing | Source and VM test evidence support the contract |
| Audit limits | Shared generation-local counter, payload rebounding after attribution, safe target/digest truncation and fail-closed cap | No unbounded metadata trace path identified |
| Deadline regressions | Actual child completion/readiness before controlled clock advance, process cleanup, report-present versus absent counts, denied handoff | Timing race removed without changing production verifier |

Relevant pinned code includes [HTTP and fallback](https://github.com/pouriya-sedaghat/atlas/blob/1d40f0479faae127eff0f3c40f129b37cc2fedd4/atlas_intake/provider.py#L359), [typed context and event bounds](https://github.com/pouriya-sedaghat/atlas/blob/1d40f0479faae127eff0f3c40f129b37cc2fedd4/atlas_intake/metadata.py#L16), [worker observer and persistence](https://github.com/pouriya-sedaghat/atlas/blob/1d40f0479faae127eff0f3c40f129b37cc2fedd4/atlas_intake/worker.py#L98) and [real-process deadline tests](https://github.com/pouriya-sedaghat/atlas/blob/1d40f0479faae127eff0f3c40f129b37cc2fedd4/tests/test_verification_worker.py#L286).

## Additional executable checks

Executed on Python 3.12.14 in the review workspace, using the pinned source and synthetic HTTP responses:

- 42 existing provider/metadata tests passed.
- Six pure ExplicitProviderTests methods passed, isolated from Django imports.
- 129 additional protocol scenarios passed. These vary direct/wrapped timeout depth, excluded transport and HTTP failures, and allocation of redirects before and after the method switch for both resolve and pin. They assert the dated identity, a shared four-redirect limit, at most six metadata opens per operation, response closure and sanitized events.
- 60 observer-failure injections passed across all 20 callback/checkpoint positions in a resolve-plus-pin/checksum sequence. Stop, TimeoutError and OSError injections each prevented subsequent I/O. Every response already returned by the opener was closed.

The 189 additional scenarios are protocol/fault checks, not another PostgreSQL suite. No public network, live source retrieval or VM recovery was used.

The reproducible [review harness](harnesses/pr3-deep-review.py) checks nine critical source/test blob identities before running. Run it against a source snapshot matching the reviewed candidate:

```sh
python3 /path/to/pr3-deep-review.py --source-root /path/to/reviewed-atlas
```

The harness requires the reviewed source blobs and rejects a differing snapshot. It can run against merged main while those source blobs remain identical, or against an exact candidate snapshot. It does not modify the application or register artifacts.

## Integration evidence and limits

The complete 236-test PostgreSQL suite, migration checks, real worker publication/fencing cases and restart/history/hash checks remain the exact-candidate VM evidence already recorded in [technical acceptance](pr-3-intake-acceptance.md) and PR #3. They were not independently rerun in this workspace, which lacks Django/PostgreSQL/native tooling. The private VM report and source files were not opened through a remote VM connection.

Both registered runs sealed after their authorized PBF retries. The live provider used successful HEAD, so live recovery and deterministic fallback proof remain distinct. The second review made no change to those runs or files.

The accepted limitation remains absence of a hard overall deadline for blocking network calls. Between-step fencing prevents expired/superseded work from registering success; it does not interrupt a blocked socket or establish guaranteed scheduler/worker responsiveness under every upstream behavior. Hard interruption and production-wide availability remain separate operational work.

Acquisition seals do not establish new geometry verification, build eligibility or a ready PostGIS release. Historical Jiangsu findings remain intact; current inputs still need normal 1B eligibility before any build.

## Final recommendation

The recommendation to merge this exact head was accepted by the user. Head identity was checked immediately before merging with an expected-SHA guard. Post-merge verification confirmed all 105 non-documentation blobs identical to the tested candidate. The Part 1C prompt can now proceed as design review only.

No merge, deployment, source/test modification or new verification/build was performed in this second review. Repository changes are the review record and its standalone harness.
