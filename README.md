# Atlas

Atlas is a reusable geospatial platform. This milestone is an end-to-end
vertical slice of it: a plain OpenStreetMap XML file is imported into an
Atlas-owned domain model, published as an immutable in-memory dataset, served as
GeoJSON over HTTP, and rendered in a browser-based inspector — including, for
each road, the direction of travel a car, a bicycle and a pedestrian may take.

```
OSM XML  →  Atlas importer  →  Atlas dataset  →  HTTP GeoJSON  →  MapLibre viewer
  oneway* tags  →  Atlas travel semantics  →  traversal member  →  direction arrows
```

Everything in that chain runs locally. There is no base-map tile server, no API
key, no database, and no network access during tests.

## Architecture

Four Rust crates and one TypeScript application, with dependencies pointing
strictly inward:

```
atlas-kernel          the domain: coordinates, bounding boxes, geometry, features
      ↑
atlas-engine          the use cases: import contracts, datasets, viewport queries
      ↑
atlas-osm             an input adapter: streaming OSM XML → Atlas features

atlas-server  →  atlas-kernel, atlas-engine, atlas-osm
atlas-studio  →  the HTTP API only
```

| Crate | Responsibility | Must not know about |
| --- | --- | --- |
| `atlas-kernel` | Validated value objects (`Longitude`, `Latitude`, `GeoCoordinate`, `BoundingBox`), `LineString` geometry with cached bounds and exact box intersection, `MapFeature` / `FeatureKind` / `RoadClass` / `SourceReference`, and the travel semantics `TravelMode` / `TravelDirection` / `RoadTraversal`. | OSM, HTTP, JSON, databases, async runtimes, renderers |
| `atlas-engine` | `MapSource` / `FeatureSink` / `ImportReport` contracts, `DatasetBuilder` → `Dataset` → `DatasetSnapshot`, atomic publication via `DatasetRegistry`, the `MapQuery` viewport use case. | OSM, HTTP, JSON |
| `atlas-osm` | Streaming, two-pass plain `.osm` XML import, and the direction-tag rules that turn `oneway*` into a `RoadTraversal`. `OsmNode`, `OsmWay`, `OsmRelation`, `OsmTags` are private to this crate. | HTTP, the wire format |
| `atlas-server` | Axum HTTP boundary: versioned response DTOs, query-parameter validation, structured errors, startup import orchestration. | — |
| `studio/` | TypeScript + MapLibre GL JS inspector. All presentation decisions. | Anything but the HTTP API |

Design decisions are recorded in [`docs/decisions/`](docs/decisions/).

## Prerequisites

- Rust 1.90 or newer (developed on 1.94.1) with `cargo`, `rustfmt` and `clippy`
- Node.js 20 or newer (developed on 22.22) with `npm`

Nothing else. No database, no Docker, no network access at run time.

## Running it

Two terminals, from the repository root.

**1. The Atlas server**

```bash
cargo run --release --package atlas-server -- \
  --source fixtures/synthetic/roads-basic.osm \
  --bind 127.0.0.1:8080
```

Both flags have those values as defaults, so `cargo run --package atlas-server`
on its own does the same thing.

**2. Atlas Studio**

```bash
cd studio
npm install        # first time only
npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` and `/health`
to `http://127.0.0.1:8080`, so Studio and the API share an origin and the
backend needs no CORS configuration. Point the proxy elsewhere with
`ATLAS_SERVER_URL=http://host:port npm run dev`.

To check a production build the same way:

```bash
cd studio
npm run build
npm run preview    # http://localhost:4173, same proxy
```

### Using your own `.osm` file

Pass any plain OSM XML file:

```bash
cargo run --package atlas-server -- --source /path/to/your-area.osm
```

Export one from <https://www.openstreetmap.org/export> or with Overpass. Only
uncompressed `.osm` XML is supported: `.osm.pbf`, `.gz` and network downloads
are out of scope for this milestone (see [Limitations](#limitations)).

If the file cannot be read or is malformed, the server still starts and still
answers `/health/live`. `/health/ready` reports not-ready and
`/api/v1/datasets/current` reports `status: "failed"` with a sanitised reason.

## The HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | The process is up. Always succeeds once listening. |
| `GET /health/ready` | A dataset is published and queryable. `503` otherwise. |
| `GET /api/v1/datasets/current` | Dataset id, status, bounds, source, attribution, import statistics and grouped warnings. Always `200`; `status` carries the truth. |
| `GET /api/v1/map/features` | Viewport query, returned as GeoJSON. |

### Feature query parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `bbox` | yes | `west,south,east,north` in degrees |
| `kind` | no | comma-separated feature kinds; currently `road` |
| `limit` | no | default 1000, server maximum 5000 |
| `include` | no | `source`, `diagnostics`, or both |
| `dataset` | no | pin a dataset id; a mismatch returns `DATASET_NOT_FOUND` |

```bash
curl "http://127.0.0.1:8080/api/v1/map/features?bbox=51.380,35.680,51.400,35.700&kind=road&limit=1000&include=source,diagnostics"
```

Responses are `application/geo+json`: a standard `FeatureCollection` whose
coordinates are numeric `[longitude, latitude]` pairs, with Atlas metadata in a
top-level `atlas` foreign member rather than inside `properties`.

Every road carries its travel semantics in `properties.traversal`, always, with
or without any `include` parameter:

```json
{
  "type": "Feature",
  "id": "osm:way:304",
  "geometry": {
    "type": "LineString",
    "coordinates": [[51.39, 35.6965], [51.3915, 35.6965], [51.393, 35.6965]]
  },
  "properties": {
    "kind": "road",
    "roadClass": "residential",
    "name": "Contraflow Cycle Street",
    "traversal": {
      "motorcar": { "direction": "forward" },
      "bicycle": { "direction": "both" },
      "foot": { "direction": "both" }
    }
  }
}
```

This is additive: the API is still version 1, and a client written against
Milestone 1 that ignores unknown members keeps working unchanged.

Errors are `application/json`, never GeoJSON:

```json
{
  "error": {
    "code": "INVALID_BOUNDING_BOX",
    "message": "west must not be greater than east",
    "requestId": "req-00000001",
    "details": { "parameter": "bbox" }
  }
}
```

Codes: `INVALID_QUERY`, `INVALID_BOUNDING_BOX`, `DATASET_NOT_FOUND`,
`DATASET_NOT_READY`, `INTERNAL_ERROR`. Messages never contain file system
paths, stack traces or parser internals.

## Travel direction

Atlas derives, per road, in which direction each of three modes travels it.

This is direction, not access. If access otherwise allows the mode, the value
describes the permitted direction relative to the geometry; it never says that
the mode may use the road in the first place. Atlas does not model access yet,
so a road can carry a direction for a mode that would in reality be barred
from it.

### Modes

| Mode | Wire name | Studio label |
| --- | --- | --- |
| Private motor car | `motorcar` | Car |
| Bicycle | `bicycle` | Bicycle |
| Pedestrian | `foot` | Foot |

### Direction values

Direction is always stated **relative to the geometry**, never in compass
terms. Atlas never reverses a geometry to express a direction.

| Value | Meaning |
| --- | --- |
| `both` | No directional restriction: neither way along the line is ruled out. |
| `forward` | Travel follows the coordinate order of the line. |
| `reverse` | Travel runs against the coordinate order of the line. |
| `reversible` | The direction the road runs changes, but infrequently. |
| `alternating` | Traffic alternates direction frequently. |
| `indeterminate` | Atlas cannot derive a safe static direction. |

`indeterminate` is a refusal to guess, not a default.

### Source values

The OSM adapter reads direction values with surrounding whitespace trimmed and
ASCII case ignored, so `oneway=" YES "` and `oneway=yes` are the same thing.

| Source value | Reads as |
| --- | --- |
| `yes`, `true`, `1` | `forward` |
| `no`, `false`, `0` | `both` |
| `-1`, `reverse` | `reverse` |
| `reversible` | `reversible` |
| `alternating` | `alternating` |
| anything else | `indeterminate`, with a warning |

The legacy aliases `true`, `1`, `false`, `0` and `reverse` are accepted in
silence: they are perfectly clear statements that happen to be spelled the old
way.

### Precedence

The first rule that applies wins. A present but unreadable override never falls
back to a less specific tag: `oneway:motorcar=sometimes` makes the car
`indeterminate`, it does not quietly become whatever plain `oneway` says.

| # | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- |
| 1 | applicable conditional tag → `indeterminate` | applicable conditional tag → `indeterminate` | `oneway:foot:conditional` → `indeterminate` |
| 2 | `oneway:motorcar` | `oneway:bicycle` | `oneway:foot` |
| 3 | `oneway:motor_vehicle` | `oneway` | class-specific reading of `oneway` |
| 4 | `oneway` | implied rule | `both` |
| 5 | implied rule | `both` | |
| 6 | `both` | | |

### Implied rules

Only two, and only when no plain `oneway` value overrides them:

- `junction=roundabout` implies `forward` for motorcar and bicycle.
- `highway=motorway` implies `forward` for motorcar and bicycle.

Foot stays `both` under both rules. An explicit `oneway=no`, `false` or `0`
reopens either.

### Plain `oneway` and pedestrians

A plain `oneway` is, by convention, a statement about vehicles. An explicit
`oneway:foot` always wins; otherwise the road class decides:

| Class | Effect of a plain `oneway` on foot |
| --- | --- |
| `steps` | Applies: a readable value becomes the pedestrian direction. |
| `path`, `footway` | `no` means `both`; a directional or dynamic value is ambiguous → `indeterminate` plus `AMBIGUOUS_ONEWAY_SCOPE`. |
| street-like classes, `track`, `cycleway` | No effect; foot stays `both`. |
| an unmodelled class | Treated like a shared way: directional or dynamic → `indeterminate` plus `AMBIGUOUS_ONEWAY_SCOPE`. |

An *unreadable* plain value never makes foot ambiguous on an ordinary street,
because a plain `oneway` there was never about pedestrians to begin with.

### Conditional tags

Atlas detects `oneway:conditional`, `oneway:motorcar:conditional`,
`oneway:motor_vehicle:conditional`, `oneway:bicycle:conditional` and
`oneway:foot:conditional`, and never parses their values. An applicable
conditional makes that mode `indeterminate` and records
`UNSUPPORTED_CONDITIONAL_ONEWAY`. A generic `oneway:conditional` reaches
motorcar and bicycle, not foot, exactly as a generic `oneway` does.

### Direction warnings

| Code | Recorded when |
| --- | --- |
| `UNKNOWN_ONEWAY_VALUE` | A direction tag carried a value Atlas cannot read. |
| `AMBIGUOUS_ONEWAY_SCOPE` | A plain `oneway` did not say whether it applies to pedestrians. |
| `UNSUPPORTED_CONDITIONAL_ONEWAY` | A direction depends on a condition Atlas does not evaluate. |

Each is recorded at most once per road, however many tags contributed to it, so
the counts are counts of roads rather than counts of tags. They use the same
bounded [`IssueLog`] as every other import warning: a total count plus a small
deterministic sample. Unknown or ambiguous direction data never fails the
import and never skips the road.

[`IssueLog`]: crates/atlas-engine/src/import.rs

## Atlas Studio

Studio is a debugging tool, not a product surface. It shows:

- connection, dataset and query state as status chips
- dataset id, source file, format, bounds and every import counter
- grouped import warnings with their bounded entity samples
- the current viewport, features examined, candidates found, features returned,
  query duration and truncation state
- a travel profile selector, and one-way arrows for the selected profile
- a feature inspector: id, kind, road class, name, the direction for all three
  profiles, source reference, coordinate count and bounds
- OpenStreetMap attribution with a working licence link

Pan and zoom trigger a debounced viewport query; an obsolete request is aborted
and a stale response is discarded. A selected road stays in the inspector even
after it leaves the queried viewport, flagged as out of view.

### Inspecting each profile

The **Travel profile** panel offers Car, Bicycle and Foot as a keyboard-navigable
radio group; Car is the default. Switching profile is entirely local: it issues
no HTTP request, does not alter or reverse any geometry, preserves hover and
selection, leaves the viewport diagnostics untouched, and immediately re-points
the arrows.

Arrows are drawn only for `forward` and `reverse`. A `both` road has no one-way
direction to draw, and `reversible`, `alternating` and `indeterminate` have no
direction Atlas is willing to state, so none of them gets an arrow — the
inspector names them instead. The inspector always lists all three profiles, not
just the selected one, because the interesting roads are the ones where the
profiles disagree.

The arrow itself is rasterised in the browser at runtime and handed to MapLibre
as a raw RGBA buffer. There is no sprite sheet, no glyph server and no icon CDN:
Studio still loads nothing over the network but the Atlas API.

The `include=source,diagnostics` checkbox is on by default in `npm run dev` and
off in a production build. In dev builds the map and app state are also exposed
on `window.atlasStudio` for console poking.

## Tests and checks

Rust, from the repository root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Studio, from `studio/`:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

No test touches the network. The HTTP contract tests drive the real Axum router
in-process through `tower`'s `oneshot`.

## The synthetic fixture

[`fixtures/synthetic/roads-basic.osm`](fixtures/synthetic/roads-basic.osm) is
hand written and deliberately imperfect, so every branch of the importer is
exercised exactly once. It contains a residential road with a Persian name, a
service road, a way with no `highway` tag, a way referencing a node that does
not exist, an unknown `highway` value, a node with an out-of-range latitude, a
duplicated coordinate, a single-node way, and two relations.

The expected outcome is asserted in full in
`crates/atlas-osm/tests/fixture_import.rs`:

| Counter | Value |
| --- | --- |
| nodes seen / indexed | 8 / 7 |
| ways seen | 8 |
| road ways selected | 7 |
| features emitted | 4 |
| features skipped | 3 |
| relations seen | 2 |

with warnings `INVALID_COORDINATE` (1), `MISSING_NODE_REFERENCE` (2),
`TOO_FEW_COORDINATES` (1), `UNKNOWN_HIGHWAY_CLASS` (1) and
`UNSUPPORTED_RELATION` (2).

Nothing in it was downloaded from OpenStreetMap; the coordinates are invented.

### The directionality fixture

[`fixtures/synthetic/roads-directionality.osm`](fixtures/synthetic/roads-directionality.osm)
covers the direction rules. Every road is a short straight segment on its own
row, except two roundabouts drawn as square loops to the east, so each rule can
be seen on its own in Studio without any road overlapping another.

Run it:

```bash
cargo run -p atlas-server -- --source fixtures/synthetic/roads-directionality.osm
# and, in another terminal, from studio/
npm run dev
```

Then open <http://localhost:5173> and switch between Car, Bicycle and Foot.

Everything in it imports cleanly, so the only warnings are the direction ones.
The expected outcome is asserted in full in
`crates/atlas-osm/tests/directionality_fixture.rs`:

| Counter | Value |
| --- | --- |
| nodes seen / indexed | 53 / 53 |
| ways seen | 17 |
| road ways selected | 17 |
| features emitted | 17 |
| features skipped | 0 |
| relations seen | 0 |

| Warning | Count | Samples |
| --- | --- | --- |
| `UNKNOWN_ONEWAY_VALUE` | 2 | `way/311`, `way/317` |
| `AMBIGUOUS_ONEWAY_SCOPE` | 2 | `way/312`, `way/316` |
| `UNSUPPORTED_CONDITIONAL_ONEWAY` | 1 | `way/313` |

| Way | Name | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- | --- |
| 301 | Two-Way Residential | `both` | `both` | `both` |
| 302 | Forward One-Way | `forward` | `forward` | `both` |
| 303 | Reverse One-Way | `reverse` | `reverse` | `both` |
| 304 | Contraflow Cycle Street | `forward` | `both` | `both` |
| 305 | Implicit Roundabout | `forward` | `forward` | `both` |
| 306 | Two-Way Roundabout | `both` | `both` | `both` |
| 307 | Implicit Motorway | `forward` | `forward` | `both` |
| 308 | Independent Overrides Road | `reverse` | `both` | `forward` |
| 309 | Reversible Ramp | `reversible` | `reversible` | `both` |
| 310 | Alternating Tunnel | `alternating` | `alternating` | `both` |
| 311 | Unsupported Value Street | `indeterminate` | `indeterminate` | `both` |
| 312 | Ambiguous Footway | `forward` | `forward` | `indeterminate` |
| 313 | Conditional Corridor | `indeterminate` | `indeterminate` | `both` |
| 314 | One-Way Steps | `forward` | `forward` | `forward` |
| 315 | Legacy Alias Lane | `forward` | `forward` | `both` |
| 316 | Ambiguous Path | `reverse` | `reverse` | `indeterminate` |
| 317 | Unknown Motorcar Override | `indeterminate` | `forward` | `both` |

Some of these are not sensible roads — a motorway is no place for a bicycle,
and a footway is no place for a car. Direction is not access, and access is not
modelled yet, so Atlas states the direction the source implies and says nothing
about who may use the road.

## Limitations

This milestone is deliberately narrow. Not implemented, and not stubbed:

- routing, shortest paths, road graphs, turn restrictions, route costs
- access rules: Atlas says which *direction* a mode may travel, never whether
  that mode may use the road at all. A motorway can report a bicycle direction
  and a footway a motorcar direction; both are direction facts, not permission
- `maxspeed`, `surface` and every other `highway` semantic — apart from travel
  direction, the `highway` value is used for display classification only
- `.osm.pbf`, compressed input, network downloads, file upload
- persistent storage; the dataset is rebuilt from the source file on every start
- spatial indexing; queries are a linear scan, with diagnostics to prove when
  that stops being acceptable
- vector tiles, authentication, geocoding, live traffic, external map tiles

Direction, specifically, is bounded as follows:

- Conditional direction expressions are **detected, never parsed**. Any
  applicable one makes that mode `indeterminate`. Time-dependent direction is
  not modelled.
- Only `junction=roundabout` and `highway=motorway` imply a direction. No other
  "everybody knows this is one-way" rule is applied, because a guess in a
  dataset is indistinguishable from a fact.
- `oneway:bus`, `oneway:psv`, `oneway:hgv`, `cycleway:*:oneway` and the rest of
  the long tail are not read.
- `TravelDirection::Reversible` and `TravelDirection::Alternating` are recorded
  faithfully and given no static direction; nothing yet consumes them.
- Lanes, `dual_carriageway` splitting and directional geometry repair are out of
  scope: a way's direction is a property of the way exactly as the source drew
  it.

Other known bounds:

- Bounding boxes that cross the antimeridian are rejected rather than
  mishandled. Studio widens such a viewport to the full longitude range before
  asking.
- Geometry is compared on a flat longitude/latitude plane, which is accurate
  enough at viewport scales and avoids a projection dependency in the kernel.
- Feature ids (`osm:way:101`) are deterministic across re-imports and are
  opaque: clients must not parse them.
- A dataset is capped at 5,000,000 features, and a single query at 5,000.

## Attribution

Any dataset imported from OpenStreetMap data must be displayed with:

> © OpenStreetMap contributors — <https://www.openstreetmap.org/copyright>

The server returns this in `GET /api/v1/datasets/current`, and Studio renders it
with a working link. The repository itself contains no OpenStreetMap data: the
only fixture is synthetic.
