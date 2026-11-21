# Explicit Geofabrik POLY implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline with regression evidence and a final independent review.

**Goal:** Complete PR #3 with explicit catalog POLY resolution and real full-catalog acquisitions.

**Architecture:** Validate optional advertised POLY URLs separately from resolved URLs. Bind advertised intent to provider canonical bytes, reviewed overrides and mapping-cache identity. Resolve direct URLs without HTML and retain existing absent-field fallback and frozen acquisition behavior.

**Tech Stack:** Existing pinned Python/Django, PostgreSQL, Compose and Geofabrik Client.

**Spec:** `docs/briefs/intake-geofabrik-poly-compatibility.md` at `c5038bacd51e6361f08018e7ff8b67a7ae41e3c9`.

## Global constraints

Preserve the approved updates predicate, URL/redirect guards, historical revisions/runs/pins/bytes, dependencies, resource limits and Part 1B policy. Add JSON fields only; no schema migration. Never infer a sidecar for a direct target. Conflicting digest-scoped mapping rejects refresh and retains LKG. No new exceptions or geometry changes.

## Review focus

Absent versus invalid advertised values; URL-only changes and stale mapping reuse; conflict/exception precedence; exact sidecar filename validation; permanent direct-target failure without fallback. Each has a regression in Task 1.

### Task 1: Provider intent, resolution, cache and regressions

Files: `atlas_intake/provider.py`, `atlas_intake/catalog.py`, `atlas_intake/worker.py`, new `tests/test_explicit_poly.py`.

Interfaces: `Client.catalog()` still returns `(override_aware_digest, rows)` and `discover_poly(row)` returns `(url, sidecar)`. Nonempty `advertised_poly_url` participates in provider canonical bytes and mapping keys. Newly resolved rows record `poly_source` as catalog, page, reviewed mapping or reviewed exception.

- [ ] Add failing provider tests for direct/boundary-only and mixed rows, absent canonical identity, changed URL identity, unsafe inputs, mapping/sidecar/conflict/exception precedence and historical override scope.
- [ ] Add normal-refresh/cache tests for provenance, rejected input preserving LKG and stale HTML/different advertised mappings; add a real-Client worker failure test preserving historical pins/bytes.
- [ ] Run new tests in the existing pinned PostgreSQL image with sources mounted read-only. Retain expected failures.
- [ ] Implement optional-field validation/conditional canonical encoding, conflict/sidecar validation before promotion, direct resolution, cache provenance and retaining established direct POLY pins on automatic/operator retries.
- [ ] Run focused tests, then the complete PostgreSQL suite and migration checks. Expect all green and no migration changes.

### Task 2: Exact candidate and live acceptance

Interfaces: Fresh isolated loopback project consumes the candidate image and normal control/operator/worker paths; private evidence stays outside Git.

- [ ] Obtain independent whole-change review; resolve material findings with failing regressions. Create exact candidate commit/tree including approved main documentation.
- [ ] Build pinned image, verify every shipped source file, run full PostgreSQL and migration/diff checks on that image.
- [ ] Promote complete live catalog from empty state. Record raw/provider/override-aware/stored identities, full mapping/provenance, count/field changes and injected transient LKG preservation.
- [ ] Authenticated CSRF Manual Monaco PBF plus every POLY, Iran PBF unselected: record every target/pin/file/hash and actual seal.
- [ ] Prepare frozen 1440-minute QA schedule; restart only new project between acquisitions. Compare identities and rehash every Manual file.
- [ ] Admit controlled-clock Automatic occurrence exactly once, replay without duplication, end schedule through normal control, complete actual acquisition. Rehash Manual files again; compare historical metadata/source/output scope including two earlier incomplete runs.

### Task 3: Evidence and same draft PR

- [ ] Hash private evidence/helper sources. Report exact commands, candidate/image IDs, full mapping, actual seals, health/heartbeat, restart checks and gaps.
- [ ] Push candidate with lease, verify remote tree, update PR #3 title/body for updates plus POLY compatibility; retain draft status. Return URL/SHA/evidence/outcomes.
