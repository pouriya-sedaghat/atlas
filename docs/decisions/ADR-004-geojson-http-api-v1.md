# ADR-004: A GeoJSON HTTP API, version 1

- Status: accepted
- Date: 2026-09-20

## Context

Atlas Studio needs map features for a viewport. So will every other client.
The obvious options are a bespoke JSON shape, vector tiles, or GeoJSON.

Vector tiles are the right answer at scale and the wrong answer now: they add a
tiling scheme, a binary encoder and a cache layer before there is any evidence
Atlas needs them. A bespoke shape means every client writes a parser.

## Decision

Serve GeoJSON `FeatureCollection` documents from `GET /api/v1/map/features`,
with `Content-Type: application/geo+json`, and put Atlas-specific metadata in a
top-level foreign member named `atlas` — never inside `properties`, which
belongs to the feature.

Coordinates are always numeric `[longitude, latitude]` pairs, matching the
GeoJSON specification and the `bbox` parameter's `west,south,east,north` order.

The wire schema is written out explicitly as versioned DTOs in
`atlas-server::dto`, with hand-written mapping from domain types. No domain
struct derives `Serialize`.

Errors are plain JSON, not GeoJSON:

```json
{ "error": { "code": "INVALID_BOUNDING_BOX", "message": "…", "requestId": "…", "details": {} } }
```

Codes are stable strings, and messages never contain paths, stack traces or
parser internals.

## Consequences

- Any mapping client can read Atlas output without an Atlas-specific library.
- Refactoring a domain type cannot silently change the public API; the mapping
  code has to be edited, and the contract tests fail if the shape moves.
- The duplication between domain types and DTOs is real and deliberate.
- GeoJSON is verbose. A truncation flag plus a server-enforced maximum limit
  keeps responses bounded; vector tiles remain the answer when that stops being
  enough.
