# Atlas intake — Geofabrik updates URL compatibility

**Status** — The updates predicate in draft [PR #3](https://github.com/pouriya-sedaghat/atlas/pull/3), tested at `1963315c0429e165fd8691bd5e891949c8658d88`, matches the approved change. End-to-end acceptance remains open because current catalog POLY URLs are omitted by discovery. The proposed correction is reviewed and approved in [the explicit POLY follow-up](intake-geofabrik-poly-compatibility.md). Continue the same draft PR under that brief. The original assignment and prompt below are retained as history.

Part 1B was accepted at tested commit `3616c0b95c37786f12989f190382e34cfb02cf07` and merged through [PR #2](https://github.com/pouriya-sedaghat/atlas/pull/2) at `43bc7a4af4fb34a3f11dda5e8c2397ccae195f5d`.

## Observed problem and approved change

The Part 1B follow-up diagnosed a rejection of the provider's public catalog. The reported first failing entry is region `act`, field `/features/0/properties/urls/updates`, with URL `https://download.geofabrik.de/australia-oceania/australia/act/updates`. All 554 current PBF URLs passed their existing rule, while all 554 updates URLs failed the older `-updates` suffix requirement. Use these observations as the reproducer and inspect the live catalog again on the VM.

In `atlas_intake/provider.py`, extend only the updates-kind path predicate to accept both the legacy `…-updates` form and the region-directory `…/updates` form. After the existing trailing-slash normalization and URL checks, the reviewed predicate is:

```python
path.endswith("-updates") or (
    path.endswith("/updates") and path.count("/") >= 2
)
```

Continue applying the existing public HTTPS host/port, ASCII, path-segment and forbidden-character checks. A root `/updates` does not identify a region directory. Preserve the checks for every other URL kind. An isolated evaluation of the proposed predicate passed 24 accepted/rejected URL and other-kind examples during project review.

The catalog must still be parsed, validated and promoted through the normal refresh process as a new revision. Frozen artifact URLs, established dated PBF pins and prior run paths retain their identities. A provider migration of a previously frozen target stays visible as its existing source error. New acquisitions use an explicitly selected current validated catalog. Part 1B source topology outcomes and verification policy continue to apply.

## Implementation and acceptance

1. Fetch main on the designated Atlas VM and create `fix/geofabrik-updates-url`. Apply the focused predicate update and keep the normal operator, scheduler and worker paths intact.
2. Add fixtures for both accepted updates forms, optional trailing slash and nested region directories. Reject the root form, sibling suffixes, unsafe schemes/hosts/ports, credentials, traversal, queries/fragments and encoded path tricks under the existing guards. Exercise a catalog row containing the new URL and prove existing non-updates URL rules still reject it as the wrong kind.
3. Run the complete PostgreSQL regression suite, both migration checks and a source diff check in the candidate image. Use the same dependency and deployment versions as the accepted baseline.
4. Refresh the current complete public catalog through the normal Client/control path. Record region count, source and revision digests, the actual updates/PBF paths and the full POLY mapping result. Exercise the transient failure behavior and prove that the last-known-good revision remains available. Do not treat a successful first parsing step as evidence that downstream page discovery succeeded.
5. On an isolated loopback deployment, launch a fresh Manual retrieval from the newly validated revision. Select one supported small PBF, such as Monaco, and leave Iran unselected for PBF so its POLY is checked independently. Keep default POLY intent for the entire catalog. Record resolved dated pin, bytes, MD5/SHA-256, per-file states and the real seal outcome. Compare the recorded identifiers and representative hashes of previous runs and verification outputs after the check. Repeat one Automatic admission with a controlled clock and frozen selection if the new source layout affects that path.
6. If a separate page-discovery or published-link migration still blocks refresh or sealing, return the exact URL, redirect chain, field and code path with a focused proposed correction. Keep that acquisition incomplete and preserve its evidence.
7. Push the exact VM-tested candidate and open a draft PR against main. Include commands, tests, candidate/image identities, catalog and acquisition evidence and outstanding source failures. Real catalog downloads, extracts and private credentials belong outside Git.

The acceptance concerns source retrieval and metadata compatibility. Jiangsu's known invalid polygon may be acquired and sealed as bytes under 1A, then remains a blocking geometry finding under 1B. A corrected boundary must be captured in a new run before it can change the verified input result.

## Codex prompt — implement the compatibility fix

> Work on the designated Atlas VM for https://github.com/pouriya-sedaghat/atlas. Fetch `origin/main`, verify that merged PR #2 and tested baseline `3616c0b95c37786f12989f190382e34cfb02cf07` are present, and read this brief at the supplied revision. Preserve unrelated checkout changes and create `fix/geofabrik-updates-url` from current main.
>
> Implement the approved updates-kind predicate and focused regression tests. Run the PostgreSQL suite and migration checks. On the exact candidate, validate the full current catalog through the existing refresh path, exercise a fresh acquisition and record actual mapping and sealing outcomes. Preserve all frozen identities and the accepted verification policy. Diagnose and propose any further provider-layout correction using the exact failing URL and source path.
>
> Push the VM-tested branch and open a separate draft PR against main, using the authorized GitHub connector if needed. Verify the published tree, then return the PR URL, tested SHA, commands/results, live source evidence and material gaps for review.

## References

- [Part 1B acceptance and provider diagnosis](https://github.com/pouriya-sedaghat/atlas/pull/2)
- [Current public catalog](https://download.geofabrik.de/index-v1-nogeom.json) and [Geofabrik technical details](https://download.geofabrik.de/technical.html)
- [Existing URL validation](https://github.com/pouriya-sedaghat/atlas/blob/3616c0b95c37786f12989f190382e34cfb02cf07/atlas_intake/provider.py)
