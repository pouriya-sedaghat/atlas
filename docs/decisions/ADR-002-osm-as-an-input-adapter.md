# ADR-002: OSM is an input adapter, not the domain model

- Status: accepted
- Date: 2026-09-20

## Context

OpenStreetMap is the first, and currently only, source Atlas imports. The
tempting shortcut is to let OSM's model — nodes, ways, relations and free-form
tags — become the Atlas model, because then the importer is almost free.

That shortcut is expensive later. OSM tagging is a folksonomy: it changes, it
disagrees with itself, and it carries far more than Atlas needs. Every feature
built on raw tags would inherit that instability, and a second source (a
municipal export, a GeoJSON drop, a road survey) would have to be forced into
OSM's shape to fit.

## Decision

`atlas-kernel` owns the Atlas vocabulary: `MapFeature`, `FeatureKind`,
`RoadClass`, `Geometry`, `SourceReference`. It knows nothing about
OpenStreetMap.

`atlas-osm` is an adapter. `OsmNode`, `OsmWay`, `OsmRelation` and `OsmTags` are
private to that crate and exist only for the duration of an import. Nothing
downstream can see a raw tag map. Values Atlas does not model are preserved
rather than dropped, through `RoadClass::Other(String)` plus an
`UNKNOWN_HIGHWAY_CLASS` warning, so unfamiliar data is visible without becoming
load-bearing.

Provenance is kept generically: `SourceReference { system, entityType, entityId }`
records "this came from OpenStreetMap way 101" without the kernel knowing what
a way is.

## Consequences

- Adding a second source means writing a second adapter, with no change to the
  kernel, the engine or the HTTP API.
- The adapter must make a judgement call on every ambiguous tag rather than
  deferring it to the reader. Those judgements are all in one file, and tested.
- Round-tripping an OSM extract through Atlas is lossy by design. Atlas is not
  an OSM editor and will not become one.
