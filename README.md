# Atlas

Atlas is a reusable geospatial platform. This milestone is the first end-to-end
vertical slice of it: a plain OpenStreetMap XML file is imported into an
Atlas-owned domain model, published as an immutable in-memory dataset, served as
GeoJSON over HTTP, and rendered in a browser-based inspector.

```
OSM XML  →  Atlas importer  →  Atlas dataset  →  HTTP GeoJSON  →  MapLibre viewer
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
| `atlas-kernel` | Validated value objects (`Longitude`, `Latitude`, `GeoCoordinate`, `BoundingBox`), `LineString` geometry with cached bounds and exact box intersection, `MapFeature` / `FeatureKind` / `RoadClass` / `SourceReference`. | OSM, HTTP, JSON, databases, async runtimes, renderers |
| `atlas-engine` | `MapSource` / `FeatureSink` / `ImportReport` contracts, `DatasetBuilder` → `Dataset` → `DatasetSnapshot`, atomic publication via `DatasetRegistry`, the `MapQuery` viewport use case. | OSM, HTTP, JSON |
| `atlas-osm` | Streaming, two-pass plain `.osm` XML import. `OsmNode`, `OsmWay`, `OsmRelation`, `OsmTags` are private to this crate. | HTTP, the wire format |
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

## Atlas Studio

Studio is a debugging tool, not a product surface. It shows:

- connection, dataset and query state as status chips
- dataset id, source file, format, bounds and every import counter
- grouped import warnings with their bounded entity samples
- the current viewport, features examined, candidates found, features returned,
  query duration and truncation state
- a feature inspector: id, kind, road class, name, source reference, coordinate
  count and bounds
- OpenStreetMap attribution with a working licence link

Pan and zoom trigger a debounced viewport query; an obsolete request is aborted
and a stale response is discarded. A selected road stays in the inspector even
after it leaves the queried viewport, flagged as out of view.

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

## Limitations

This milestone is deliberately narrow. Not implemented, and not stubbed:

- routing, shortest paths, road graphs, turn restrictions
- access rules, and any `oneway`, `maxspeed` or `surface` semantics — the
  `highway` value is used for display classification only
- `.osm.pbf`, compressed input, network downloads, file upload
- persistent storage; the dataset is rebuilt from the source file on every start
- spatial indexing; queries are a linear scan, with diagnostics to prove when
  that stops being acceptable
- vector tiles, authentication, geocoding, live traffic, external map tiles

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
