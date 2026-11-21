# Atlas intake — explicit Geofabrik POLY URLs

**Status** — Implementation reviewed at `4db5d45bdfcaa478cbb64641b8300ec6ddf9283a` in draft [PR #3](https://github.com/pouriya-sedaghat/atlas/pull/3). The POLY compatibility implementation is consistent with this contract. Full refresh promoted 554 direct mappings, and both Manual and Automatic completed all POLYs. Both runs remain incomplete because Monaco PBF metadata resolution timed out. The current assignment is the read-only [PBF metadata transport review](intake-pbf-metadata-transport-review.md). Keep PR #3 in draft. The implementation instructions below remain the record of the completed POLY work, with final acquisition acceptance still open.

## Review decision and baseline

The reviewed candidate is `1963315c0429e165fd8691bd5e891949c8658d88`, based on main `54c74ce28a0e11e21acb025c4fc4d457159e1489`. Its updates predicate matches the approved expression and retains the existing URL guards. No correction to that predicate is requested. The VM report records 190 passing PostgreSQL tests and both migration checks.

The candidate still cannot complete normal catalog promotion or new-catalog retrieval. Its retained observations report 554 parsed regions but zero resolved POLY mappings. Current PBF paths include an extra region directory. Deriving an HTML page from those paths produces, for example, `/asia/iran/iran.html`, which returned 404. The working older region page still advertised an obsolete POLY path. Correcting HTML derivation alone would therefore leave this observed failure unresolved.

The same captured catalog advertises explicit public `urls.poly` values. All 554 passed the existing POLY URL validator in the VM diagnosis, and three direct QA transfers succeeded. Representative source URLs are:

| Region | Advertised POLY URL |
| --- | --- |
| act | `https://download.geofabrik.de/australia-oceania/australia/act/act.poly` |
| iran | `https://download.geofabrik.de/asia/iran/iran.poly` |
| monaco | `https://download.geofabrik.de/europe/monaco/monaco.poly` |

These are observations from the pinned PR evidence, not a promise that a later upstream revision is identical. Reinspect the complete live catalog on the VM. The two previously incomplete retrievals and the direct QA files retain their recorded identities and outcomes.

## Approved source and identity contract

1. Parse the optional `properties.urls.poly` field in `_catalog_rows()`. Missing, JSON null and the empty string mean absent. Validate every other value with the existing `_url(value, "poly")` rule. Reject an invalid advertised value rather than silently falling back to HTML.
2. Store a validated nonempty value as `advertised_poly_url`, separate from the resolved `poly_url`. Omit the added field for absent values. This permits a boundary-only region to resolve directly even when the provider supplies no public PBF URL.
3. Include every present `advertised_poly_url` in the deterministically ordered provider canonical bytes before computing the digest and applying digest-scoped reviewed overrides. Changing only this URL must change the provider digest and the resulting revision identity. Preserve the existing canonical encoding and digest for a feed with no advertised POLY values. Do not rewrite historical catalog digests or rebind an old override to a new digest.
4. Include the advertised URL in the mapping cache identity. A previous HTML-derived mapping or a different advertised URL cannot satisfy a new source intent. Preserve existing explicit refresh and last-known-good behavior.
5. Retain the advertised value in newly frozen catalog rows and record enough provenance to distinguish direct catalog resolution from legacy page or reviewed mapping resolution. Existing rows and runs remain readable without the new field.

No schema migration should be necessary for an added catalog JSON field. If implementation reveals a required persistent-schema change, explain it and test the upgrade before proposing it for acceptance.

## Resolution and reviewed override rules

Apply these rules consistently through normal refresh:

- An applicable, previously approved acquisition exception retains its existing semantics. It must match the new canonical provider digest and existing region scope. This brief approves no new exception.
- When a validated advertised POLY URL exists, use it directly. Do not request a derived or configured HTML page to reconfirm that URL.
- If an applicable reviewed mapping also specifies a POLY URL, validate it and require equality with the advertised URL. A conflicting mapping is a configuration error that rejects refresh and preserves the last-known-good revision. Detect this before a partial revision can be promoted. A mapping that only supplies a page does not displace an advertised URL.
- A matching reviewed mapping may provide an optional sidecar under the existing sidecar URL and exact filename rules. A page-only mapping may also supply such a sidecar for the advertised target if it passes those same checks. No sidecar is inferred merely from a filename or from the existence of the advertised POLY URL.
- When the advertised field is absent, retain the existing reviewed mapping and page discovery behavior, including page-advertised POLY and sidecar checks and repeated-link deduplication.
- If a direct advertised target later fails pinning or transfer, retain the frozen target and actual error. Do not replace it with an older page link, a previous run's bytes or a newly guessed path.

Keep the public HTTPS host/port, character/path and redirect guards intact. The existing pin, bounded streaming, size, validator, SHA-256 and publication checks remain responsible for acquiring unchanged response bytes. A catalog mapping is source intent, not proof that the file has been downloaded or verified.

## Regression evidence required

Add focused tests that exercise observable behavior:

- A realistic current-layout catalog resolves its explicit POLY without touching a derived HTML endpoint that would return 404. Include a POLY-only row without a public PBF URL.
- Legacy rows with missing/null/empty POLY fields preserve the prior canonical digest and page fallback. Mixed legacy and explicit rows resolve through the proper paths.
- A change only to the advertised POLY URL changes the canonical digest and revision and cannot reuse a stale resolved mapping.
- Unsafe schemes, hosts, ports, credentials, traversal, encoded paths, query/fragment content, wrong suffixes and invalid field types are rejected through normal refresh while retaining the last-known-good revision and a visible error.
- Matching mappings, page-only mappings, conflicts and digest-scoped exceptions follow the precedence above. An override scoped to a historical digest is not applied to the new feed.
- A rejected direct-target transfer does not fall back or repin. Existing frozen catalog rows, artifact URLs, dated PBF pins and completed files retain their identities.
- Existing updates URL tests, transient discovery recovery, manual replay, recurring admission and Part 1B handoff tests continue to pass.

Run the complete PostgreSQL suite, `makemigrations --check --dry-run`, `migrate --check` and a source diff check against the exact candidate image on the designated Atlas VM. Preserve existing pinned dependencies and resource limits.

## Live acceptance on the exact candidate

1. Fetch main and this brief, preserve unrelated work, and incorporate the documentation into the existing PR branch without discarding its tested updates fix. Review the frozen source and cache paths before editing.
2. Use an isolated loopback deployment and the normal complete catalog refresh path. Record raw catalog bytes/hash, actual count, canonical provider identity, override-aware identity, stored revision ID, direct/fallback/exception counts and the complete mapping outcome. The reviewed feed had 554 entries. Account explicitly for any upstream count or field change rather than hardcoding it or shrinking the selection.
3. Prove current catalog promotion from an empty deployment. Also exercise refresh with a last-known-good revision present and an injected transient source failure. Record the retained revision and visible error.
4. Launch a new Manual run through the authenticated, CSRF-protected operator path using the newly promoted revision. Select Monaco PBF and leave Iran PBF unselected. Acquire every default POLY in the complete catalog. With the reviewed count this is 555 artifacts. Record the exact catalog FK, frozen intent, dated PBF target/checksum, HTTP validators, lengths, SHA-256 values, paths and actual seal outcome.
5. Admit one fresh recurring Automatic occurrence using the same validated source policy and Monaco selection. Use a controlled application clock, without changing the host clock, and stop the QA schedule through the normal control path. Demonstrate one admitted run, replay without duplication, frozen selection and a real complete acquisition/seal. Separate planned and actual times.
6. Restart only the isolated Compose stack between the completed Manual run and the Automatic acquisition. Verify persisted catalog/run/schedule identity and rehash every Manual-run file after restart and after the second run. Compare before/after prior-run metadata, representative source hashes and previously successful verification output hashes using the established baseline scope. Leave the two older incomplete QA runs intact.
7. Record health and worker heartbeat observations while acquiring. Preserve actual failures and bounded retry outcomes if the provider changes again. Direct QA downloads outside the registry cannot satisfy a run.
8. Push the exact VM-tested candidate, verify the published tree, and update the existing draft PR's title and description around the final updates-plus-POLY compatibility scope. Include exact commands, candidate/image identities, evidence locations and hashes, actual mapping/sealing outcomes and remaining gaps. Keep raw source data, extracts and credentials outside Git.

Acquisition sealing remains a Part 1A byte-integrity result. Jiangsu's accepted Part 1B topology blocker and the whole-batch verification policy are unchanged. This task includes no geometry repair, new source exception or Part 1C database build.

## Codex prompt — implement the approved follow-up

> Work on the designated Atlas VM for https://github.com/pouriya-sedaghat/atlas. Fetch origin/main and read this brief at the supplied commit. Continue draft PR #3 on fix/geofabrik-updates-url from its reviewed candidate 1963315c0429e165fd8691bd5e891949c8658d88. Preserve unrelated work and the approved updates predicate.
>
> Implement explicit catalog POLY resolution with the identity, override, fallback and last-known-good rules in this brief. Add the required regression coverage, run the complete PostgreSQL suite and both migration checks, and perform the complete current-catalog plus fresh Manual/Automatic acquisition acceptance on the exact candidate.
>
> Preserve every historical frozen identity and verification outcome. Update the same draft PR, verify its published tree, and return the tested SHA, commands/results, full mapping and seal evidence, restart/integrity checks and material gaps. This is the separate implementation instruction following review of your PR #3 proposal. Keep the PR in draft for review.

## Review references

- [Pinned PR #3 candidate](https://github.com/pouriya-sedaghat/atlas/tree/1963315c0429e165fd8691bd5e891949c8658d88)
- [Provider parser and resolver](https://github.com/pouriya-sedaghat/atlas/blob/1963315c0429e165fd8691bd5e891949c8658d88/atlas_intake/provider.py)
- [Catalog refresh and cache](https://github.com/pouriya-sedaghat/atlas/blob/1963315c0429e165fd8691bd5e891949c8658d88/atlas_intake/catalog.py)
- [Geofabrik catalog](https://download.geofabrik.de/index-v1-nogeom.json)
