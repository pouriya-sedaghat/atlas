# Atlas catalog 2.0.0

The contract distinguishes source preservation, classified render output, and geometry permitted
to reach tiles. A successful row for an OSM object does not prove support for every tag on it.
Raw primitives, tags, available metadata and ordered references remain the source of record.
This is an experimental Atlas schema; assets, client integration and complete semantic coverage
are separate acceptance work.

## Layers

| MVT layer | Stored geometry | Native minimum zoom |
|---|---|---|
| water | MultiPolygon | 0, with low-zoom area threshold |
| landcover | MultiPolygon | 0 or 8, with low-zoom area threshold |
| waterways | LineString | 0 coastline, 8 major, 12 minor |
| boundaries | MultiLineString | depends on explicit integer admin_level |
| transport | LineString | 4-14 according to core road/rail rules |
| buildings | MultiPolygon | 14 |
| places | Point | 0-15 according to place type |
| pois | Point | 12 major, 16 others |
| detail_points | Point | 16 |
| detail_lines | LineString | 12 aerialways/transmission lines, otherwise 14 |
| detail_areas | MultiPolygon | 14 |

The exact executable rules are [catalog-core-v2.lua](catalog-core-v2.lua) and
[catalog-details.lua](catalog-details.lua). Closed natural ways are only filled for declared
area classes; a closed cliff/tree-row/ridge does not automatically become landcover. Unknown
classes remain auditable. Layer/admin-level parsing accepts explicit integers rather than
silently flooring decimal source values. Original text remains in tags.

## Independent detail families

| Stable family ID | Family | Supported geometry policy |
|---:|---|---|
| 1 | power | declared equipment points; line/minor_line/cable/portal lines; declared closed facility areas |
| 2 | barrier | declared barrier points and outlines; no inferred filled obstacle |
| 3 | aeroway | declared points, runway/taxiway lines and declared closed areas |
| 4 | aerialway | station/pylon points and declared cable-way lines |
| 5 | man_made | declared equipment points, linear structures and closed facility areas |
| 6 | natural | declared source points and linear natural features; area classes are handled in core |
| 7 | transport | declared node features; explicitly area=yes highway surfaces; ordinary road/rail lines remain in core |
| 8 | entrance | declared entrance nodes |
| 9 | address | source housenumber nodes; a building's housenumber remains a core attribute |

These overlays carry source annotations and geometry; a generic point symbol is not a claim
that all domain attributes have been interpreted or geographically verified. Values must meet
the explicit rule sets. In these detail overlays, unknown values, URL-like vandalism and
unsupported primitive/geometry combinations remain in the raw archive and per-family outcomes,
not automatically rendered as valid facilities. This is not a general vandalism detector for
every core tag or name. The platform does not fetch URLs appearing in OSM tags.

An object may produce several family features even when already represented by a core layer.
For example, highway=residential + power=line produces a road and a separate power line.
The observer only writes an object to `uncatalogued` after all declared rules have run and none
produced display output. Independent `detail_facets` report inserted, core-layer/attribute,
unsupported, unknown or rejected geometry cases, including secondary features on otherwise
rendered objects. This does not classify every possible OSM attribute.

Core MVT identities keep the supplied id*10+type scheme. Detail identities use
id*1000+type*100+stable_family_id, checked against JavaScript's safe integer range before insert.
Family IDs must never be reassigned. The same source feature can appear in several layers;
feature counts across layers are not a count of unique primitives.

MVT properties are explicit scalars: source identity, family/kind, names, ref and housenumber.
Raw JSON tags are not flattened into tile attributes, avoiding collisions with reserved fields.
The complete tags stay in private raw/render inspection data. Unknown source text is never
executed or treated as an instruction. Font/icon/style coverage and density still require
client-side acceptance before production use.

## Relation completeness and access boundary

[catalog-topology.sql](catalog-topology.sql) records every source relation. It blocks missing
node/way/relation references, unsupported geometric child relations, and their ancestors.
Recursive UNION terminates on cycles. For boundary relations, child roles subarea/admin_centre/
label are explicitly non-geometric; a missing reference still blocks the complete source object.
Multipolygon child relations and other boundary child roles are withheld because the current
assembler does not establish their full geometry. No child geometry is silently substituted.

`render.*` keeps the original successful output for diagnosis. `tiles.*` consists of eleven
materialized views, populated once with N/W rows and only relations with an existing, unblocked
topology record. A missing topology record fails closed at snapshot construction. Each snapshot
has its own GiST geometry index, B-tree minimum-zoom index and statistics. They are built before QA and sealing; no live
refresh is used. The tile login has SELECT on these snapshots and EXECUTE on the fixed tile
function, without direct read access to render/raw tables or permission to refresh snapshots.
The attempt's NOLOGIN owner owns them. The QA login can inspect the retained data.

This deliberately spends additional disk space to physically separate excluded rows from the
serving data. A security-barrier view prevented the non-leakproof PostGIS bounding-box operator
from reaching the base spatial index in the rejected real-Iran experiment. Replacing it with an
ordinary view would weaken isolation. See [PostgreSQL view security](https://www.postgresql.org/docs/17/rules-privileges.html)
and [materialized views](https://www.postgresql.org/docs/17/rules-materializedviews.html).
The catalog evidence includes the rejected plan and a measured indexed plan on the new snapshot.

The tile function locally sets `plan_cache_mode=force_custom_plan`. Viewport selectivity varies
widely across zooms; a generic plan underestimated a broad Iran tile and filtered high-zoom
roads only after scanning the spatial candidates. Both the zoom index and planning for the
actual viewport were verified on a separate copy of all filtered Iran layers before rebuilding.
The original failed snapshots remain unchanged. This setting is scoped to the fixed function;
it does not change the server-wide planner or increase query deadlines.

QA compares successful inserts with stored rows, compares expected eligible counts with materialized counts, records served and withheld rows, and rejects
blocked-row exposure or missing topology records. A review hold remains for incomplete source
references, unsupported nested geometry, unknown detail semantics and conversion problems.
Reference closure and valid geometry do not establish geographic truth.

OSM has an open vocabulary. A zero uncatalogued count is not by itself an acceptance target:
arbitrary generic rendering can conceal unsupported semantics. Production acceptance must
declare mandatory families, auditable retained-only cases, critical defects and baseline drift
thresholds. The current experimental profile holds unresolved cases for defining that policy;
it does not silently approve them or require inventing a display meaning for every tag.

## Water and source corrections

Missing members cannot be reconstructed from the supplied PBF. A source fix needs a complete,
versioned and verified extraction or declared supplementary source; mixing current API objects
into an older snapshot is not an automatic repair. Self-intersecting building rings remain
diagnosed, not force-converted with MakeValid into an assumed footprint.

Coastline-derived ocean masks are a distinct input from inland natural=water polygons. Their
provenance, date, checksum, license and compatibility with the map release must be recorded.
They do not replace missing lake, administrative or other relation members. No supplementary
water dataset is admitted by this stage.

References: [osm2pgsql geometry/relation behavior](https://osm2pgsql.org/doc/manual.html),
[vector layer schema reference](https://openmaptiles.org/docs/schema/),
[OSM-derived water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html).
