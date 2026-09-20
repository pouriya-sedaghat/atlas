# ADR-001: Rust for the Atlas engine

- Status: accepted
- Date: 2026-09-20

## Context

Atlas imports map data, holds it in memory and answers viewport queries on
every pan and zoom. The work is CPU-bound, latency-sensitive and driven by
untrusted external input: an OSM extract is a file somebody else produced, and
it will contain broken references, impossible coordinates and tags nobody
anticipated.

Two properties matter more than raw speed. First, a malformed input must never
be able to crash the process or corrupt a published dataset. Second, the
boundary between "validated" and "not yet validated" data has to be visible in
the code, not maintained by convention.

## Decision

Implement the Atlas backend in Rust, as a Cargo workspace.

Validation lives in the type system: `Longitude`, `Latitude`, `BoundingBox` and
`LineString` all have private fields and fallible constructors, so a value that
exists is already known to be well formed. Errors are typed enums rather than
strings. Atlas-owned crates carry `#![forbid(unsafe_code)]`, and production
paths avoid `unwrap`/`expect` on external input entirely.

## Consequences

- Import and query code can be written without defensive re-checking: the type
  of a value is the proof it was validated.
- The compiler enforces the layering between crates, so an accidental
  dependency from the domain kernel onto HTTP or OSM will not build.
- The cost is compile times and a smaller pool of contributors than, say, Go or
  TypeScript would give. That is accepted for a component whose main job is
  being correct about other people's data.
- A single deployable binary with no runtime is a pleasant side effect rather
  than the reason for the choice.
