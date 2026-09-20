# ADR-005: In-memory storage for the first milestone

- Status: accepted
- Date: 2026-09-20

## Context

Atlas has to store imported features somewhere and find the ones that intersect
a viewport. The candidates are a database (PostGIS being the obvious one), an
embedded store, or plain memory with a linear scan.

A database would settle persistence, concurrency and spatial indexing in one
move — and would also mean a schema, migrations, a connection pool, a container
to run in tests, and a query planner between Atlas and its own data, before
anyone has measured what Atlas actually needs.

## Decision

Keep the active dataset in memory as `Vec<Arc<MapFeature>>`, and answer
viewport queries with a linear scan: filter by kind, then test exact geometry
intersection against the requested box.

No spatial index. Not an R-tree, not a grid, not a quadtree. The scan runs to
completion even after the result limit is reached, so `candidatesFound` is the
true match count and `truncated` is honest.

Every query reports what it did — features examined, candidates found, features
returned, elapsed time — so the decision to add an index will be made against
numbers rather than intuition.

## Consequences

- Startup re-imports from the source file every time. For a synthetic fixture
  that is instantaneous; for a large extract it is a real cost.
- Query cost is O(features) per request. With a few thousand roads this is
  microseconds. It will not stay that way, and the diagnostics will say so.
- Nothing survives a restart, and there is no write path. Both are fine for a
  read-only viewer over a file.
- The `MapQuery` contract is shaped around the use case, not around storage, so
  an index or a database can be introduced behind it without touching callers.
