# PR #3 — technical acceptance

**Decision** — Accepted against the approved intake compatibility and metadata recovery contract at tested head `1d40f0479faae127eff0f3c40f129b37cc2fedd4`. The subsequent [deeper review](pr-3-deep-review.md) confirmed that decision. After explicit user authorization, PR #3 was merged into main at `32f8bcd4759d6d005f28ca38fe095efa84059e56`.

## Review scope and evidence

Source review covered the updates predicate, advertised POLY URL/digest/cache rules, direct POLY pin preservation, typed PBF metadata fallback, shared redirects/dated target, bounded observer and worker fencing, and deterministic real-process deadline tests.

Nine fetched source/test files were checked against their exact Git blob identities. Project review executed 42 provider/metadata tests and six pure ExplicitProviderTests methods successfully. The six POLY methods were isolated from Django imports. PostgreSQL/Django/native integration was not rerun in the review workspace.

The exact-candidate VM report records 236 PostgreSQL tests, both migration checks and diff checks passing. Retained fixture mistakes were diagnosed, and the original timing-sensitive failure log remains recorded. There are no GitHub check runs/status records for this candidate; VM evidence and source review are the acceptance basis. The private VM report and data files were not independently opened from the review workspace.

## Accepted acquisition outcome

The existing Manual run `2b4190fc-9c4e-4dd6-a67a-88c225fe512b` and Automatic run `6e1ba035-e183-4b6f-b2dc-cf366c9e4724` each sealed after one approved retry cycle of PBF artifacts 555 and 1110. Their 1,108 completed POLYs were acquired on the previous accepted candidate and retained unchanged. Resolution, pin, body acquisition and publication of the two PBFs used the new candidate.

Both PBFs have length 704,767, provider MD5 `d10b113c7426a59ecbe7206268ff728d` and SHA-256 `0138f33c14c8e2116ff77277682e26cda9502199905a73a1876f905b8c0a27d1`.

The report records 24 attributed events with a maximum payload of 450 bytes. Normal live HEAD succeeded; no live GET metadata fallback was needed or forced. Deterministic Client and PostgreSQL worker tests establish the fallback path separately.

After isolated Compose restart, the reported 1,110 completed files, pins, histories, paths and terminal state matched. Historical checks retained 17 prior runs, ten verification records and 38 successful verification output files.

Evidence receipt SHA-256 is `3f1ee5e174c7036e8557c3fc9c4178a2aace884e12139e9cfd73ee873fe099f7`. The original PR body retains commands, exact image/tree identities, earlier failures and private evidence locations.

## Limits and next step

Blocking network operations still have no hard overall deadline. Existing per-request bounds and between-step ownership fencing are accepted for this pilot; stale work cannot register success. This does not establish guaranteed upstream availability or a root cause for prior timeouts.

These are acquisition seals. They do not create a new successful geometry verification, override the accepted Jiangsu finding or authorize a database build.

The next assignment is [Part 1C design review](../briefs/phase-1c-candidate-database.md), with live-input eligibility explicitly unresolved until current verification evidence is inspected.

## Merge state

An initial merge attempt was rejected by automatic approval review because explicit authorization for this exact default-branch merge was not established. No merge occurred at that point, and the PR was restored to draft. After the deeper review, the user explicitly authorized this exact merge. The normal GitHub merge API then merged the PR with expected head `1d40f0479faae127eff0f3c40f129b37cc2fedd4`, producing `32f8bcd4759d6d005f28ca38fe095efa84059e56`. Post-merge verification found all 105 non-documentation source/test/deployment blobs identical to the tested candidate.
