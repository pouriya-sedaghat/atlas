# Atlas

Atlas is a reusable geospatial platform. This milestone is an end-to-end
vertical slice of it: a plain OpenStreetMap XML file is imported into an
Atlas-owned domain model, published as an immutable in-memory dataset, served as
GeoJSON over HTTP, and rendered in a browser-based inspector — including, for
each road, the direction of travel a car, a bicycle and a pedestrian may take,
what the source says about their access to it, and what the source says the
legal maximum speed is in each direction.

```
OSM XML  →  Atlas importer  →  Atlas dataset  →  HTTP GeoJSON  →  MapLibre viewer
  oneway* tags     →  Atlas travel semantics  →  traversal member  →  direction arrows
  access* tags     →  Atlas access facts      →  access member     →  access overlay
  maxspeed* tags   →  Atlas speed facts       →  speedLimits member →  inspector rows
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
| `atlas-kernel` | Validated value objects (`Longitude`, `Latitude`, `GeoCoordinate`, `BoundingBox`), `LineString` geometry with cached bounds and exact box intersection, `MapFeature` / `FeatureKind` / `RoadClass` / `SourceReference`, and the four road records: `TravelMode` / `TravelDirection` / `RoadTraversal`, `AccessRule` / `RoadAccess`, and `Speed` / `SpeedUnit` / `SpeedLimitValue` / `SpeedLimitFact` / `RoadSpeedLimits`. | OSM, HTTP, JSON, databases, async runtimes, renderers |
| `atlas-engine` | `MapSource` / `FeatureSink` / `ImportReport` contracts, `DatasetBuilder` → `Dataset` → `DatasetSnapshot`, atomic publication via `DatasetRegistry`, the `MapQuery` viewport use case. | OSM, HTTP, JSON |
| `atlas-osm` | Streaming, two-pass plain `.osm` XML import, and the tag rules that turn `oneway*` into a `RoadTraversal`, `access*` into a `RoadAccess` and `maxspeed*` into a `RoadSpeedLimits`. `OsmNode`, `OsmWay`, `OsmRelation`, `OsmTags` are private to this crate. | HTTP, the wire format |
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
or without any `include` parameter. Each mode gets a `direction`, an `access`
and a `speedLimits` block, which are independent facts:

```json
{
  "type": "Feature",
  "id": "osm:way:524",
  "geometry": {
    "type": "LineString",
    "coordinates": [[51.39, 35.7085], [51.3915, 35.7085], [51.393, 35.7085]]
  },
  "properties": {
    "kind": "road",
    "roadClass": "residential",
    "name": "Orthogonality Street",
    "traversal": {
      "motorcar": {
        "direction": "reverse",
        "access": "private",
        "speedLimits": {
          "forward": {
            "limit": { "kind": "numeric", "value": "70", "unit": "km/h" },
            "conditional": false,
            "variable": "not-tagged"
          },
          "backward": {
            "limit": { "kind": "numeric", "value": "30", "unit": "km/h" },
            "conditional": false,
            "variable": "not-tagged"
          }
        }
      },
      "bicycle": { "direction": "both", "access": "permissive", "speedLimits": {} },
      "foot": { "direction": "both", "access": "allowed", "speedLimits": {} }
    }
  }
}
```

The `bicycle` and `foot` blocks are abbreviated above for readability; on the
wire they carry the same two-direction shape as `motorcar`, always.

This is additive: the API is still version 1 and the media type is still
`application/geo+json`, so a client written against Milestone 1, 2A or 2B that
ignores unknown members keeps working unchanged. A road whose source carried no
access tags reports `unspecified` for every mode, which is not the same as
`allowed`; a road whose source carried no speed tags reports
`{ "kind": "unspecified" }` in both directions for every mode, which is not the
same as "unlimited" and not the same as a country default.

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

This is direction, not access. The value describes which way along the road the
mode travels; it never says that the mode may use the road in the first place.
What the source said about that is [a separate fact](#road-access), derived from
separate tags and recorded beside this one — and a road can carry a direction
for a mode that the very same road prohibits.

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

## Road access

Atlas derives, per road, what the source says about each of three modes' access
to it.

### Direction, access and routing policy

Three different questions, deliberately kept apart:

| Question | Answered by | Status |
| --- | --- | --- |
| Which way along this road does the mode travel? | `traversal.<mode>.direction` | Milestone 2A |
| What did the source say about the mode using it? | `traversal.<mode>.access` | Milestone 2B |
| May a route actually send someone down it? | a routing profile | **not implemented** |

Access is not direction. A forward one-way road may prohibit motorcars; a
bidirectional road may be private; a bicycle-designated way still has a
direction of its own. The two never affect each other, and **a direction arrow
never disappears because access is prohibited** — Studio draws them in separate
layers from separate properties.

Access is not a routing answer either. `destination` records that the source
limits the road to destination traffic; whether *your* journey counts as
destination traffic depends on where you are going, which country you are in
and what vehicle you are driving. That is a routing profile's decision, and
Atlas has no routing profiles yet. See
[ADR-008](docs/decisions/ADR-008-explicit-access-facts-and-routing-policy.md).

### Access values

| Value | Meaning |
| --- | --- |
| `unspecified` | No applicable explicit access tag was present. Not permission, not prohibition. |
| `allowed` | Explicitly allowed by the source. |
| `designated` | Legally or officially designated for the mode. |
| `permissive` | Permitted by the owner, and potentially revocable. |
| `discouraged` | Legal access exists but use is discouraged. |
| `destination-only` | Limited to traffic whose destination is on the way. |
| `customers-only` | Limited to customers of whatever the way serves. |
| `delivery-only` | Limited to deliveries. |
| `agricultural-only` | Limited to agricultural traffic. |
| `forestry-only` | Limited to forestry traffic. |
| `military-only` | Limited to military traffic. |
| `private` | An explicit private access restriction. |
| `permit-required` | Access requires a permit. |
| `dismount-required` | The mode must be dismounted or handled as the restriction says. |
| `use-sidepath` | The mode is expected or required to use a separate path. |
| `prohibited` | An explicit no-access fact. |
| `variable` | The source explicitly declares access to be variable. |
| `conditional` | A condition applies that Atlas detected and does not evaluate. |
| `indeterminate` | Atlas saw access information and cannot derive a trustworthy rule. |

`unspecified` is the one to read carefully. It is **not** `allowed`: most roads
in OpenStreetMap carry no access tag, and "nobody has said" is a different state
of knowledge from "somebody checked and said yes". Only the first can be
improved by surveying, and only the first is where a future country-default
table would apply.

### Source values

The OSM adapter reads access values with surrounding whitespace trimmed and
ASCII case ignored, so `access=" NO "` and `access=no` are the same thing.

| Source value | Reads as |
| --- | --- |
| `yes` | `allowed` |
| `no` | `prohibited` |
| `designated` | `designated` |
| `permissive` | `permissive` |
| `discouraged` | `discouraged` |
| `destination` | `destination-only` |
| `customers` | `customers-only` |
| `delivery` | `delivery-only` |
| `agricultural` | `agricultural-only` |
| `forestry` | `forestry-only` |
| `military` | `military-only` |
| `private` | `private` |
| `permit` | `permit-required` |
| `dismount` | `dismount-required` |
| `use_sidepath` | `use-sidepath` |
| `variable` | `variable` |
| `unknown` | `indeterminate`, **without** a warning |
| anything else, or blank | `indeterminate`, with `UNKNOWN_ACCESS_VALUE` |

`unknown` is a recognised OSM value: a surveyor saying they could not tell.
Atlas records that faithfully and does not complain about it.

No legacy aliases are folded in. `public` and `restricted` appear in the wild
and mean different things to different people, so Atlas refuses to pick one:
they stay `indeterminate` and visible in the warnings.

### Hierarchy and precedence

Each mode has its own chain, most specific first. The first key the way
actually carries wins, and nothing below it is consulted.

| # | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- |
| 1 | `motorcar:conditional` | `bicycle:conditional` | `foot:conditional` |
| 2 | `motorcar` | `bicycle` | `foot` |
| 3 | `motor_vehicle:conditional` | `vehicle:conditional` | `access:conditional` |
| 4 | `motor_vehicle` | `vehicle` | `access` |
| 5 | `vehicle:conditional` | `access:conditional` | `unspecified` |
| 6 | `vehicle` | `access` | |
| 7 | `access:conditional` | `unspecified` | |
| 8 | `access` | | |
| 9 | `unspecified` | | |

Two rules decide the interleaving:

- **Specificity wins across levels.** A plain `motorcar` beats a
  `vehicle:conditional`: the mapper said something about cars in particular.
- **The conditional form wins within one level.** `motorcar:conditional` beats
  `motorcar`.

And three rules apply throughout:

- A present but unreadable value **stops the chain**. `motorcar=maybe` makes the
  car `indeterminate`; it never falls through to a broader tag that happens to
  be readable.
- Absence produces `unspecified`, never `allowed`.
- Access derivation never changes geometry and never reverses coordinate order.

#### Precedence examples

| Tags | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- |
| `access=no` + `foot=yes` | `prohibited` | `prohibited` | `allowed` |
| `vehicle=no` + `bicycle=yes` | `prohibited` | `allowed` | `unspecified` |
| `access=yes` + `vehicle=permissive` + `motorcar=private` | `private` | `permissive` | `allowed` |
| `access:conditional="no @ (…)"` + `foot=yes` | `conditional` | `conditional` | `allowed` |
| `vehicle:conditional="no @ (…)"` + `motorcar=yes` | `allowed` | `conditional` | `unspecified` |
| `motorcar=yes` + `motorcar:conditional="no @ (…)"` | `conditional` | `unspecified` | `unspecified` |
| `access=yes` + `motorcar=maybe` | `indeterminate` | `allowed` | `allowed` |

### Access is never inferred from highway class

`derive_access` is given tags and nothing else. It never reads `highway`, it is
never handed the `RoadClass`, and there is no country default table anywhere in
Atlas.

A motorway usually bars pedestrians and a footway usually bars cars — but those
are *legal defaults*, not facts about the way. They vary by jurisdiction, they
change without the road changing, and once stored they would be
indistinguishable from a surveyed fact. Nothing downstream could then apply a
different default, and no surveyor could find out what still needs surveying.

This is deliberately the opposite of the direction rules, where the
classification *is* an input: a motorway implies `forward` for vehicles, and the
class decides whether a plain `oneway` reaches pedestrians. The motorway
direction rule is near-universal and is about the road's physical design; the
motorway access rule is a traffic law. Leaving `unspecified` intact is what
makes a jurisdiction-aware routing profile possible later.

### Conditional tags

Atlas recognises `access:conditional`, `vehicle:conditional`,
`motor_vehicle:conditional`, `motorcar:conditional`, `bicycle:conditional` and
`foot:conditional`.

**Detection is by key. The value is never parsed.** If a conditional key is the
one precedence lands on for a mode, that mode becomes `conditional` and the road
records `UNSUPPORTED_CONDITIONAL_ACCESS`.

A conditional is never read as an unconditional `yes` or `no`. Reading
`no @ (Mo-Fr 07:00-09:00)` as a plain `no` would encode a rush-hour restriction
as a permanent closure; reading it as `yes` would drop the restriction. Both
would look exactly like facts.

Limitations that follow: time-dependent access is not modelled, opening hours,
dates and weight expressions are not evaluated, and `access:lanes`,
`access:forward` and `access:backward` are not read at all. A conditional that
is out-ranked for every modelled mode decided nothing and warns about nothing.

### Values that need a named mode

`designated`, `dismount` and `use_sidepath` each name something a particular
mode does. On the general `access` key there is no mode to name — designated for
whom? — so any mode that reaches one of them there becomes `indeterminate` and
the road records `INVALID_ACCESS_SCOPE`. A more specific override still wins.

| Tags | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- |
| `access=designated` | `indeterminate` | `indeterminate` | `indeterminate` |
| `access=designated` + `bicycle=yes` | `indeterminate` | `allowed` | `indeterminate` |
| `bicycle=designated` | `unspecified` | `designated` | `unspecified` |

The check stops at the general key. `vehicle=designated` is unusual, but it is an
explicit source fact with a subject, so Atlas records it: deciding a mapper is
wrong about a vehicle key would be routing policy, and this milestone is not a
policy validator.

### Access warnings

| Code | Recorded when | Scope |
| --- | --- | --- |
| `UNKNOWN_ACCESS_VALUE` | Any of `access`, `vehicle`, `motor_vehicle`, `motorcar`, `bicycle` or `foot` carried a value Atlas cannot read, including a blank one. | every such key on the road, **regardless of precedence** |
| `INVALID_ACCESS_SCOPE` | The general `access` key carried `designated`, `dismount` or `use_sidepath`. | the `access` key, **regardless of precedence** |
| `UNSUPPORTED_CONDITIONAL_ACCESS` | A conditional key was **selected by precedence** for at least one mode. | selected keys only |

Each is recorded at most once per road, however many tags contributed to it, so
the counts are counts of roads rather than counts of tags. They use the same
bounded [`IssueLog`] as every other import warning and are appended after the
Milestone 1 and 2A codes, so the group order a client already sees does not
shuffle. All three are evaluated only for ways that actually become road
features; a way with no `highway` tag, or one skipped for broken geometry,
contributes nothing.

#### Precedence decides the value; diagnostics describe the source

These are two different questions and Atlas answers them in two separate
passes.

`UNKNOWN_ACCESS_VALUE` and `INVALID_ACCESS_SCOPE` are **data-quality findings
about the file**. A static scan reads every recognised static access key the
road carries and asks whether the value is readable and whether it can mean
what it says there. Neither question depends on which key precedence went on to
choose, so a mistake that a more specific tag happens to shadow is still
reported:

```
access=bogus
motorcar=yes
bicycle=yes
foot=yes
```

derives `allowed` for all three modes — precedence is untouched — **and**
records `UNKNOWN_ACCESS_VALUE` once. Staying quiet here would hide exactly the
mistakes a mapper most needs to find: the broken value would be invisible in
every diagnostic Atlas publishes. The same holds for `access=designated` behind
three valid overrides, which records `INVALID_ACCESS_SCOPE`.

`UNSUPPORTED_CONDITIONAL_ACCESS` is different, and stays **selected-only**. A
conditional tag is not a defect — it is valid, correct data that Atlas has
chosen not to evaluate. The warning is a statement about a limitation of Atlas,
and Atlas is only limited by a condition that reaches the answer. A conditional
out-ranked for all three modes shaped nothing, so it produces neither a
`conditional` rule nor a warning.

In short: a shadowed **malformed or misplaced** value still warns and never
changes a derived rule; a shadowed **conditional** does neither.

The recognised value `unknown` never warns in any position, shadowed or not: it
is a surveyor reporting uncertainty accurately, not a data problem.

An access problem never fails the import, never skips a road, never mutates
geometry and never reverses coordinate order. Only malformed XML or attribute
decoding is still fatal.

## Road speed limits

Atlas derives, per road, what the source says the **legal maximum speed** is —
for each of three modes, in each of two geometry directions. Six facts per
road, always.

### A legal maximum is not a travel speed

Four different questions, deliberately kept apart:

| Question | Answered by | Status |
| --- | --- | --- |
| Which way along this road does the mode travel? | `traversal.<mode>.direction` | Milestone 2A |
| What did the source say about the mode using it? | `traversal.<mode>.access` | Milestone 2B |
| What did the source say the legal maximum is? | `traversal.<mode>.speedLimits` | Milestone 2C |
| How fast will a traveller actually move, and how long will the route take? | a routing profile | **not implemented** |

`maxspeed=50` says the law forbids exceeding fifty kilometres per hour. It does
**not** say that anybody travels at fifty, that a router should assume fifty, or
how long the road takes to traverse. A road signed at 50 may be gridlocked; a
road with no fixed limit may be crawling.

Atlas therefore records the limit and computes nothing from it. There is no
expected speed, no travel time, no cost and no colour scale — a colour scale
needs thresholds, thresholds mean "fast" and "slow", and "fast" is a
journey-time claim this milestone does not make. See
[ADR-009](docs/decisions/ADR-009-explicit-directional-speed-limit-facts.md).

Speed is also not access and not direction. **A prohibited road still carries
its speed limits**, because the sign is on the post whether or not anyone may
drive past it, and **a one-way road still carries both directions**, because the
source describes the road rather than the traffic. `forward` and `backward` are
relative to the **coordinate order of the geometry**, exactly as the direction
arrows are, which is one more reason Atlas never reverses a geometry.

### Limit kinds

| Kind | Wire shape | Meaning |
| --- | --- | --- |
| `unspecified` | `{ "kind": "unspecified" }` | No applicable explicit limit was present. Not "unlimited", not a country default. |
| `numeric` | `{ "kind": "numeric", "value": "50.5", "unit": "km/h" }` | An exact magnitude in the unit the source stated. |
| `no-fixed-limit` | `{ "kind": "no-fixed-limit" }` | OSM `none`. Knowledge, not its absence. |
| `walking-pace` | `{ "kind": "walking-pace" }` | OSM `walk`, kept as a named fact rather than a guessed number. |
| `implicit` | `{ "kind": "implicit", "code": "AR:urban:primary" }` | A named jurisdiction rule, preserved whole and **not** resolved to a number. |
| `indeterminate` | `{ "kind": "indeterminate" }` | A limit was stated and Atlas could not read it safely. |

`unspecified` is the one to read carefully. It is **not** a number and **not**
"unlimited": most roads in OpenStreetMap carry no `maxspeed`, and "nobody has
said" is a different state of knowledge from "somebody checked". Only the first
can be improved by surveying, and only the first is where a future
country-default table would apply.

`value` is a **string**, deliberately. It is exact decimal text — `50`, `50.5`,
`0` — with no sign, no exponent and no redundant zeroes. A JSON number would be
a double on most clients and `50.5` would stop being `50.5`; a legal limit is a
number somebody wrote on a sign, and Atlas repeats it exactly.

### Source values and units

The OSM adapter reads values with surrounding whitespace trimmed and keywords
and units matched without ASCII case sensitivity, so `maxspeed=" 50 KM/H "` and
`maxspeed=50 km/h` are the same thing.

| Source value | Reads as |
| --- | --- |
| `50` | `numeric` `50` `km/h` — a unitless value means km/h |
| `50 km/h` | `numeric` `50` `km/h` |
| `30 mph` | `numeric` `30` `mph` |
| `10 knots` | `numeric` `10` `knots` |
| `50 kph`, `50 kmh`, `50 kmph` | `numeric` `50` `km/h` — documented discouraged aliases, canonicalised |
| `none` | `no-fixed-limit` |
| `walk` | `walking-pace` |
| `RO:urban`, `GB:nsl_single`, `GB-WLS:nsl_restricted` | `implicit`, code preserved |
| `AR:urban:primary`, `DE:zone:30` | `implicit`, every context component preserved |
| `50 furlongs` | `indeterminate` + `UNSUPPORTED_MAXSPEED_UNIT` |
| `unknown`, `signals`, `bogus`, blank | `indeterminate` + `UNKNOWN_MAXSPEED_VALUE` |

**Atlas does not convert between units.** `30 mph` stays `30 mph` on the wire
and in Studio. Converting would replace what the source said with an arithmetic
result carrying a rounding error, and would erase the only evidence that the
road was surveyed where signs are in miles. A future routing layer may convert
when it knows what it wants the number for.

Magnitudes are canonicalised without rounding: `050.500` becomes `50.5` and
`0.0` becomes `0`. Negative values, exponent notation, comma decimals, several
decimal points and any other text are refused rather than guessed at. Zero is
allowed.

#### Implicit codes

An implicit code names the rule that applies rather than the number it
produces. Atlas validates its shape, normalises case and stops there:

```text
COUNTRY[-REGION]:segment[:segment...]
```

The country is two ASCII letters, an optional region is one to three ASCII
alphanumerics after a hyphen, and the context is **one or more**
colon-separated components of `[A-Za-z0-9_]+`. The context may narrow more than
once: `AR:urban:primary` and `DE:zone:30` are as valid as `RO:urban`, and every
component is kept, with the colon structure between them intact. Flattening
`DE:zone:30` to `DE:zone` or `DE:zone30` would record a different rule from the
one the mapper named.

Accepting more components is not accepting missing ones. An empty component
names nothing, so these stay malformed and earn `UNKNOWN_MAXSPEED_VALUE`:

```text
RO::urban
RO:urban:
RO:urban::extra
```

Normalisation is case and nothing else — the jurisdiction upper-cases, every
context component lower-cases, so `ar:URBAN:Primary` and `AR:urban:primary` are
one code. The number the code implies is still not derived; see
[Deferred on purpose](#deferred-on-purpose).

Two values are refused on purpose rather than translated. `maxspeed=unknown` is
**not** a recognised correct value — the source says an unknown limit should be
represented by omitting `maxspeed` — so it is indeterminate and diagnosed.
`maxspeed=signals` is deprecated in favour of `maxspeed:variable=*`, and
turning it into a variability claim the mapper did not make at that key would be
Atlas guessing, so it too is indeterminate and diagnosed.

### Hierarchy and precedence

Each of the six facts resolves down its own chain of keys, most specific first.
For a motorcar travelling forwards:

```text
maxspeed:motorcar:forward
maxspeed:motorcar
maxspeed:motor_vehicle:forward
maxspeed:motor_vehicle
maxspeed:vehicle:forward
maxspeed:vehicle
maxspeed:forward
maxspeed
```

A bicycle uses `maxspeed:bicycle:<direction>`, `maxspeed:bicycle`,
`maxspeed:vehicle:<direction>`, `maxspeed:vehicle`, `maxspeed:<direction>`,
`maxspeed`. A pedestrian uses `maxspeed:foot:<direction>`, `maxspeed:foot`,
`maxspeed:<direction>`, `maxspeed`. A bicycle is a vehicle but not a motor
vehicle; a pedestrian is neither.

Two rules govern the walk, and they mirror direction and access exactly:

**Mode specificity precedes direction specificity.** This is OSM's own conflict
order, and it surprises people: a mode-specific *non-directional* key beats a
broader *directional* one. On a road carrying both `maxspeed:motorcar=35` and
`maxspeed:forward=60`, a car travelling forwards gets **35**.

**An unreadable specific value never falls back.** A way that says
`maxspeed:motorcar=maybe` meant to say something about motorcars; quietly using
the broader `maxspeed=50` instead would replace an explicit statement with one
the mapper made about something else. That mode becomes `indeterminate` in both
directions, and the other modes are untouched. A `<tag k="maxspeed"/>` with no
`v` at all arrives as a blank value and blocks fallback exactly as `v=""` does.

#### Precedence examples

```
maxspeed=50
maxspeed:forward=60
maxspeed:vehicle=45
maxspeed:vehicle:forward=55
maxspeed:motorcar=35
```

gives car `35`/`35`, bicycle `55`/`45` and foot `60`/`50`, as forward/backward.

```
maxspeed=50
maxspeed:motorcar=maybe
```

gives car `indeterminate`/`indeterminate` and leaves bicycle and foot at
`50`/`50`.

### Conditional and variable are modifiers

Neither replaces the ordinary limit. A road signed at 80 with a wet-weather
conditional still has an ordinary limit of 80, and a road signed at 100 with a
variable sign still has an ordinary limit of 100. They sit beside the limit on
the wire:

```json
{ "limit": { "kind": "numeric", "value": "80", "unit": "km/h" }, "conditional": true, "variable": "not-tagged" }
```

**Conditional** (`maxspeed[:<mode>][:forward|backward]:conditional`) is detected
**by key**; the expression is never parsed. Reading `60 @ wet` honestly would
need a weather model and a clock, and recording a rainy-Tuesday limit as a
permanent fact would be worse than saying nothing. A conditional is marked
`true` for a fact only when its mode/direction scope is at least as specific as
the winning static scope, following the official order: mode specificity,
direction specificity, then conditional over static at the same scope.

**Variable** (`maxspeed:variable`, `maxspeed:variable:forward`,
`maxspeed:variable:backward`) has four wire values:

| Wire | Source | Meaning |
| --- | --- | --- |
| `not-tagged` | — | Atlas found no applicable variability tag. |
| `fixed` | `no` | Somebody explicitly said the limit does not vary. |
| `variable` | `yes`, or a `;`-list of documented reasons | The limit varies. |
| `indeterminate` | anything else, including `signals` | A statement Atlas could not read. |

The documented reasons are `peak_traffic`, `weather`, `environment`,
`school_zone`, `obstruction` and `border_control`. The direction-specific key
overrides the general one, and a present-but-unreadable specific value does not
fall back. There are no mode-specific variable keys in the source, so the answer
applies to every modelled mode — a statement about the sign, not a claim that
every traveller obeys it.

`not-tagged` is a statement about the *source record*, not a routing
assumption, and it is not the same fact as `fixed`.

### Speed warnings

| Code | Recorded when | Scope |
| --- | --- | --- |
| `UNKNOWN_MAXSPEED_VALUE` | Any supported static `maxspeed` key carried a value Atlas cannot read, including a blank one. | every such key on the road, **regardless of precedence** |
| `UNSUPPORTED_MAXSPEED_UNIT` | A sound magnitude was followed by a unit Atlas does not support. | every such key, **regardless of precedence** |
| `UNSUPPORTED_CONDITIONAL_MAXSPEED` | A conditional key was **selected by precedence** for at least one of the six facts. | selected keys only |
| `UNKNOWN_VARIABLE_MAXSPEED_VALUE` | Any of the three variable keys carried a value Atlas cannot read. | all three keys, **regardless of precedence** |

Each is recorded at most once per road, however many tags or facts contributed
to it, so the counts are counts of **roads** — not of tags, modes or directions.
They use the same bounded `IssueLog` as every other import warning and are
appended after the Milestone 1, 2A and 2B codes, so the group order a client
already sees does not shuffle. All four are evaluated only for ways that
actually become road features.

#### Precedence decides the value; diagnostics describe the source

Two different questions, answered in separate passes — the same split
Milestone 2B settled on.

The three *malformed-value* codes are **data-quality findings about the file**.
A scan reads every supported static key and all three variable keys the road
carries and asks whether each value is readable. That does not depend on which
key precedence chose, so a mistake a more specific tag shadows is still
reported:

```
maxspeed=bogus
maxspeed:motorcar=30
maxspeed:bicycle=20
maxspeed:foot=walk
```

derives `30`, `20` and walking pace — precedence is untouched — **and** records
`UNKNOWN_MAXSPEED_VALUE` once. Staying quiet would hide exactly the mistakes a
mapper most needs to find.

`UNSUPPORTED_CONDITIONAL_MAXSPEED` is different and stays **selected-only**. A
conditional tag is not a defect: it is valid, correct data that Atlas has chosen
not to evaluate, so the warning is a statement about a limitation of *Atlas*,
and Atlas is only limited by a condition that reaches an answer. A conditional
out-ranked for all six facts shaped nothing, so it produces neither a modifier
nor a warning.

In short: a shadowed **malformed** value still warns and never changes a derived
fact; a shadowed **conditional** does neither.

### Deferred on purpose

`maxspeed:type`, `source:maxspeed`, `zone:maxspeed`, `maxspeed:advisory`,
`minspeed`, lane-specific speed keys and country or road-class defaults are read
by nothing in this milestone. Unit tests assert that `maxspeed:type` and
`source:maxspeed` change no derived limit, so this is a tested boundary rather
than an accidental omission.

A speed problem never fails the import, never skips a road, never mutates
geometry and never reverses coordinate order. Only malformed XML or attribute
decoding is still fatal.

## Atlas Studio

Studio is a debugging tool, not a product surface. It shows:

- connection, dataset and query state as status chips
- dataset id, source file, format, bounds and every import counter
- grouped import warnings with their bounded entity samples
- the current viewport, features examined, candidates found, features returned,
  query duration and truncation state
- a travel profile selector, with one-way arrows and an access overlay for the
  selected profile, and a legend for the overlay
- a feature inspector: id, kind, road class, name, the direction, the access
  and both geometry directions' speed limits for all three profiles, source
  reference, coordinate count and bounds
- OpenStreetMap attribution with a working licence link

Pan and zoom trigger a debounced viewport query; an obsolete request is aborted
and a stale response is discarded. A selected road stays in the inspector even
after it leaves the queried viewport, flagged as out of view.

### Inspecting each profile

The **Travel profile** panel offers Car, Bicycle and Foot as a keyboard-navigable
radio group; Car is the default. Switching profile is entirely local: it issues
no HTTP request, does not alter or reverse any geometry, preserves hover and the
selected feature, leaves the viewport diagnostics untouched, and immediately
re-points the arrows and re-filters the access overlay.

Arrows are drawn only for `forward` and `reverse`. A `both` road has no one-way
direction to draw, and `reversible`, `alternating` and `indeterminate` have no
direction Atlas is willing to state, so none of them gets an arrow — the
inspector names them instead. The inspector always lists all three profiles, not
just the selected one, because the interesting roads are the ones where the
profiles disagree.

A profile now owns **four** rows — direction, access, forward speed and backward
speed — and all four are highlighted for the selected profile while the other
eight stay visible and unmarked:

```text
Car direction          Car access          Car forward speed          Car backward speed
Bicycle direction      Bicycle access      Bicycle forward speed      Bicycle backward speed
Foot direction         Foot access         Foot forward speed         Foot backward speed
```

Both speed directions are shown on every road, including the one-ways: `forward`
and `backward` are relative to the coordinate order of the geometry, not to the
way the traffic runs.

### Reading a speed row

Speed is **inspector-only**. There is no speed overlay, no colour scale and no
change to road colours, widths, z-order, arrows or the access overlay. A colour
scale would need thresholds, and thresholds would imply that a legal maximum is
a travel speed.

Rows are plain text, assembled from validated values only:

```text
50 km/h
30 mph · conditional
100 km/h · variable
80 km/h · explicitly fixed
No fixed limit
Walking pace
Implicit · RO:urban
Not stated
Indeterminate · not derived
```

Modifier text is appended only when it says something: a conditional that is
present, a limit that varies, a limit somebody explicitly called fixed, or a
modifier Studio could not read. `not-tagged` on either modifier is the ordinary
case on almost every road and adds no text.

Units are shown exactly as the server sent them — `mph` and `knots` are never
silently converted — and `Not stated` never reads as a number or a default.

If an older server omits the speed block, Studio reads it as `indeterminate`,
not as `unspecified`. A server that never sent the member has not established
that the source lacked speed tags; `unspecified` is a claim about a source, and
a client must not make it on a server's behalf. Studio therefore carries a
three-state conditional internally (`not-tagged`, `present`, `indeterminate`)
where the wire has only a boolean, so an absent `false` is not rendered as a
present one. An unrecognised future kind, unit, magnitude or code degrades the
same way and is never displayed.

### The access overlay

The overlay is a thin dashed line drawn *over* each road and *under* everything
that highlights one. It is narrower than the road and dashed, so the road-class
colour still shows on both sides of it and through the gaps: the overlay adds a
fact, it does not replace one.

Nineteen access values collapse into four drawing categories — four is about as
many as a reader can hold at once on a map that is already coloured by road
class. The inspector always shows the exact value in words.

| Overlay | Colour | Dash | Values |
| --- | --- | --- | --- |
| none | — | — | `unspecified`, `allowed`, `designated` |
| Restricted or special purpose | amber `#ffb02e` | long dashes | `permissive`, `discouraged`, `destination-only`, `customers-only`, `delivery-only`, `agricultural-only`, `forestry-only`, `military-only`, `private`, `permit-required`, `dismount-required`, `use-sidepath` |
| Prohibited | red `#ff5d5d` | tight beads | `prohibited` |
| Dynamic or unresolved | purple `#c79bf2` | long-short | `variable`, `conditional`, `indeterminate` |

`unspecified` draws nothing, alongside `allowed` and `designated`. An overlay on
every untagged road would map how complete OpenStreetMap is, not how accessible
the roads are. The inspector still calls it "Not stated", never "Allowed".

The overlay sits below the hover and selection highlights and below the
direction arrows, so **a prohibited one-way still shows its arrow**. Access and
direction are separate facts drawn by separate layers, and neither layer's
filter reads the other's property.

A compact legend in the same panel shows the four categories, drawn as inline
SVG with the same colours and dash rhythms the map uses. Nothing is fetched for
it: no sprite, no icon font, no image.

If an older server omits `access`, Studio reads it as `indeterminate` — the
purple overlay — and not as `unspecified`. A server that never sent the member
has not established that the source lacked access tags; `unspecified` is a claim
about a source, and a client must not make it on a server's behalf. An
unrecognised future value degrades the same way.

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
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

`--locked` makes a command fail rather than quietly update `Cargo.lock`. Drop it
when you are deliberately changing dependencies.

The minimum supported Rust version is checked separately, and needs its own
toolchain: `cargo +1.90.0` fails unless 1.90.0 has been installed through
`rustup` first.

```bash
rustup toolchain install 1.90.0 --profile minimal
cargo +1.90.0 check --workspace --all-targets --locked
```

Studio, from `studio/`. The first command is dependency installation, not a
quality gate; the five after it are the gates:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm ci` installs exactly `studio/package-lock.json` and fails rather than
rewriting it. Use `npm install` only when you mean to change dependencies.

No test touches the network. The HTTP contract tests drive the real Axum router
in-process through `tower`'s `oneshot`.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull
request and on every push to the default Atlas branch,
`claude/atlas-geospatial-mvp-r3xj00`. It is deliberately read-only: top-level
`permissions: contents: read`, `persist-credentials: false` on checkout, no
repository secrets, no artifact uploads, and only first-party `actions/*`
actions. Runs for the same ref cancel each other.

Three independent jobs, all on `ubuntu-24.04`:

| Job | Commands | What it protects |
| --- | --- | --- |
| **Rust quality** | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` | Formatting, lint cleanliness at `-D warnings`, and the whole workspace test suite. Stable Rust with `rustfmt` and `clippy`, installed through the `rustup` already on the runner. |
| **Rust MSRV** | `cargo +1.90.0 check --workspace --all-targets --locked` | The `rust-version = "1.90"` contract in `Cargo.toml`. A type check on the minimal profile; it does not duplicate the test suite. |
| **Atlas Studio** | `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | Prettier formatting, ESLint, `tsc --noEmit`, the Vitest suite and a real production build. Node.js 22, with npm caching keyed to `studio/package-lock.json`. |

CI runs no gate you cannot run yourself. It executes the same project checks
listed under [Tests and checks](#tests-and-checks), in a controlled
`ubuntu-24.04` environment with locked dependency resolution — `--locked` and
`npm ci` fail rather than quietly update `Cargo.lock` or
`studio/package-lock.json` — and it adds the explicit Rust 1.90.0 MSRV check as
a job of its own. A clean local run is a good predictor of CI rather than a
guarantee of it: the runner brings its own operating system, its own toolchain
versions and a dependency tree built from scratch.

Repository text is normalized to LF through the root
[`.gitattributes`](.gitattributes). `* text=auto eol=lf` lets Git detect text
automatically and then stores and checks it out with LF on every platform, and
common binary assets (`*.png`, `*.woff2`, `*.zip` and friends) are marked
`binary` so they are never inspected or converted.

Generated build directories stay untracked: `/target`, `node_modules/` and
`dist/` are listed in [`.gitignore`](.gitignore), and CI recreates them from
the lockfiles on every run.

Review patches and archives are operational artifacts rather than repository
content. Git does not stop you from adding one — `*.zip`, `*.patch` and
`*.diff` are not ignored — so keep them outside the working tree by
convention, alongside the repository and not inside it.

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
and a footway is no place for a car. Direction is not access: this fixture
carries no access tags at all, so every road in it reports `unspecified` access
for every mode, and Atlas states the direction the source implies without
claiming anything about who may use the road.

### The access fixture

[`fixtures/synthetic/roads-access.osm`](fixtures/synthetic/roads-access.osm)
covers the access rules. Every road is a short straight segment on its own row,
running west to east, with the rows in way-id order from north to south, so each
rule can be seen on its own in Studio without any road overlapping another.

Run it:

```bash
cargo run -p atlas-server -- --source fixtures/synthetic/roads-access.osm
# and, in another terminal, from studio/
npm run dev
```

Then open <http://localhost:5173> and switch between Car, Bicycle and Foot. The
overlay changes and the arrows stay put.

Everything in it imports cleanly, so the only warnings are the access ones. The
expected outcome is asserted in full in
`crates/atlas-osm/tests/access_fixture.rs` and repeated in the fixture header:

| Counter | Value |
| --- | --- |
| nodes seen / indexed | 69 / 69 |
| ways seen | 23 |
| road ways selected | 23 |
| features emitted | 23 |
| features skipped | 0 |
| relations seen | 0 |

| Warning | Count | Samples |
| --- | --- | --- |
| `UNKNOWN_ACCESS_VALUE` | 1 | `way/417` |
| `INVALID_ACCESS_SCOPE` | 1 | `way/423` |
| `UNSUPPORTED_CONDITIONAL_ACCESS` | 4 | `way/418`, `way/419`, `way/420`, `way/421` |

| Way | Name | Tags | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- | --- | --- |
| 401 | Untagged Lane | — | `unspecified` | `unspecified` | `unspecified` |
| 402 | Open Access Street | `access=yes` | `allowed` | `allowed` | `allowed` |
| 403 | Closed Access Street | `access=no` | `prohibited` | `prohibited` | `prohibited` |
| 404 | Foot Exception Street | `access=no` `foot=yes` | `prohibited` | `prohibited` | `allowed` |
| 405 | Cycle Exception Street | `vehicle=no` `bicycle=yes` | `prohibited` | `allowed` | `unspecified` |
| 406 | Destination Motor Road | `motor_vehicle=destination` | `destination-only` | `unspecified` | `unspecified` |
| 407 | Layered Override Street | `access=yes` `vehicle=permissive` `motorcar=private` | `private` | `permissive` | `allowed` |
| 408 | Designated Cycleway | `bicycle=designated` | `unspecified` | `designated` | `unspecified` |
| 409 | Permissive Footpath | `foot=permissive` | `unspecified` | `unspecified` | `permissive` |
| 410 | Customers Car Park Road | `access=customers` | `customers-only` | `customers-only` | `customers-only` |
| 411 | Delivery Service Road | `motor_vehicle=delivery` | `delivery-only` | `unspecified` | `unspecified` |
| 412 | Dismount Bridge Path | `bicycle=dismount` | `unspecified` | `dismount-required` | `unspecified` |
| 413 | Sidepath Cycle Street | `bicycle=use_sidepath` | `unspecified` | `use-sidepath` | `unspecified` |
| 414 | Permit Motorcar Track | `motorcar=permit` | `permit-required` | `unspecified` | `unspecified` |
| 415 | Discouraged Cycle Lane | `bicycle=discouraged` | `unspecified` | `discouraged` | `unspecified` |
| 416 | Unknown Access Road | `access=unknown` | `indeterminate` | `indeterminate` | `indeterminate` |
| 417 | Unreadable Motorcar Street | `access=yes` `motorcar=maybe` | `indeterminate` | `allowed` | `allowed` |
| 418 | Conditional Access Street | `access:conditional="no @ (…)"` | `conditional` | `conditional` | `conditional` |
| 419 | Conditional With Foot Exception | `access:conditional="no @ (…)"` `foot=yes` | `conditional` | `conditional` | `allowed` |
| 420 | Conditional Vehicle Street | `vehicle:conditional="no @ (…)"` `motorcar=yes` | `allowed` | `conditional` | `unspecified` |
| 421 | Conditional Motorcar Street | `motorcar=yes` `motorcar:conditional="no @ (…)"` | `conditional` | `unspecified` | `unspecified` |
| 422 | Variable Access Street | `access=variable` | `variable` | `variable` | `variable` |
| 423 | Invalid Scope Street | `access=designated` | `indeterminate` | `indeterminate` | `indeterminate` |

Way 416 raises no warning: `unknown` is a recognised value, not a data problem.

Four rows carry an orthogonal `oneway` tag so that the overlay and the arrows
can be watched together. Neither derivation reads the other's tags, and these
directions are exactly what the same `oneway` values produce with no access tag
present:

| Way | `oneway` | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- | --- |
| 403 Closed Access Street | `yes` | `forward` | `forward` | `both` |
| 407 Layered Override Street | `-1` | `reverse` | `reverse` | `both` |
| 408 Designated Cycleway | `yes` | `forward` | `forward` | `both` |
| 418 Conditional Access Street | `yes` | `forward` | `forward` | `both` |

Every other row is two-way for every mode. Way 403 is the one to look at: it is
prohibited for everybody and still draws its one-way arrows.

Sixteen of the nineteen access values appear in this table.
`agricultural-only`, `forestry-only` and `military-only` are left out because
they behave identically to the purpose limits already shown — same key, same
precedence, same overlay — and three more near-identical rows would cost a
screen of height to demonstrate nothing new. They are covered by the adapter's
value-table unit test and serialised by an HTTP contract test, and
`fixture_shows_every_rule_but_the_three_activity_restrictions` fails if a
twentieth value is ever added without a decision about whether the fixture
should grow a row for it.

None of these rules says whether a router may use the road. They record what the
source said.

### The speed fixture

[`fixtures/synthetic/roads-speed.osm`](fixtures/synthetic/roads-speed.osm)
covers the speed-limit facts. Every road is a short straight segment on its own
row, running west to east, with the rows in way-id order from north to south, so
each fact can be seen on its own in Studio without any road overlapping another.

Run it:

```bash
cargo run -p atlas-server -- --source fixtures/synthetic/roads-speed.osm
# and, in another terminal, from studio/
npm run dev
```

Then open <http://localhost:5173> and click each road. The inspector lists all
six speed rows for every road; the map deliberately looks the same whichever
profile is selected, because no layer draws a speed.

Everything in it imports cleanly, so the only warnings are the speed ones. The
expected outcome is asserted in full in
`crates/atlas-osm/tests/speed_fixture.rs` and repeated in the fixture header:

| Counter | Value |
| --- | --- |
| nodes seen / indexed | 72 / 72 |
| ways seen | 24 |
| road ways selected | 24 |
| features emitted | 24 |
| features skipped | 0 |
| relations seen | 0 |

| Warning | Count | Samples |
| --- | --- | --- |
| `UNKNOWN_MAXSPEED_VALUE` | 4 | `way/512`, `way/513`, `way/515`, `way/516` |
| `UNSUPPORTED_MAXSPEED_UNIT` | 1 | `way/514` |
| `UNSUPPORTED_CONDITIONAL_MAXSPEED` | 3 | `way/517`, `way/518`, `way/520` |
| `UNKNOWN_VARIABLE_MAXSPEED_VALUE` | 1 | `way/523` |

Ordinary limits, as forward / backward. Where the three modes agree one row is
given; where they differ, all three are listed.

| Way | Name | Key tags | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- | --- | --- |
| 501 | Untagged Speed Lane | — | `unspecified` / `unspecified` | same | same |
| 502 | Fifty Street | `maxspeed=50` | `50 km/h` / `50 km/h` | same | same |
| 503 | Thirty Mph Street | `maxspeed=30 mph` | `30 mph` / `30 mph` | same | same |
| 504 | Ten Knots Channel Road | `maxspeed=10 knots` | `10 knots` / `10 knots` | same | same |
| 505 | No Fixed Limit Road | `maxspeed=none` | `no-fixed-limit` / `no-fixed-limit` | same | same |
| 506 | Walking Pace Lane | `maxspeed=walk` | `walking-pace` / `walking-pace` | same | same |
| 507 | Implicit Urban Street | `maxspeed=RO:urban` | `RO:urban` / `RO:urban` | same | same |
| 508 | Directional Speed Street | `maxspeed=50` `:forward=60` `:backward=40` | `60` / `40` | same | same |
| 509 | Layered Mode Street | `maxspeed:{vehicle=45,motor_vehicle=40,motorcar=35,bicycle=25,foot=walk}` | `35` / `35` | `25` / `25` | `walk` / `walk` |
| 510 | Mode Before Direction Street | `maxspeed=50` `:forward=60` `:vehicle=45` `:vehicle:forward=55` `:motorcar=35` | `35` / `35` | `55` / `45` | `60` / `50` |
| 511 | Mixed Specificity Street | `maxspeed=50` `:motorcar=40` `:motorcar:forward=30` `:bicycle:backward=20` | `30` / `40` | `50` / `20` | `50` / `50` |
| 512 | Unreadable Motorcar Speed Street | `maxspeed=50` `:motorcar=maybe` | `indeterminate` / `indeterminate` | `50` / `50` | `50` / `50` |
| 513 | Unreadable Forward Speed Street | `maxspeed=50` `:forward=fast` | `indeterminate` / `50` | same | same |
| 514 | Unsupported Unit Road | `maxspeed=50 furlongs` | `indeterminate` / `indeterminate` | same | same |
| 515 | Missing Value Road | `<tag k="maxspeed"/>` | `indeterminate` / `indeterminate` | same | same |
| 516 | Shadowed Bad Speed Street | `maxspeed=bogus` `:motorcar=30` `:bicycle=20` `:foot=walk` | `30` / `30` | `20` / `20` | `walk` / `walk` |
| 517 | Conditional Speed Street | `maxspeed=80` `:conditional="60 @ wet"` | `80` / `80` **conditional** | same | same |
| 518 | Partly Shadowed Conditional Street | as 517, plus `:motorcar=90` | `90` / `90` | `80` / `80` **conditional** | `80` / `80` **conditional** |
| 519 | Fully Shadowed Conditional Street | as 517, plus `:motorcar=90` `:bicycle=25` `:foot=walk` | `90` / `90` | `25` / `25` | `walk` / `walk` |
| 520 | Car Forward Conditional Street | `maxspeed=80` `:motorcar:forward:conditional="30 @ (…)"` | `80` **conditional** / `80` | `80` / `80` | `80` / `80` |
| 521 | Variable Speed Street | `maxspeed=100` `:variable=yes` | `100` / `100` **variable** | same | same |
| 522 | Forward Fixed Variable Street | as 521, plus `:variable:forward=no` | `100` **fixed** / `100` **variable** | same | same |
| 523 | Unreadable Variable Street | `maxspeed=100` `:variable=weather` `:variable:forward=perhaps` | `100` **indeterminate** / `100` **variable** | same | same |
| 524 | Orthogonality Street | `maxspeed:forward=70` `:backward=30` plus direction and access tags | `70` / `30` | same | same |

Way 519 is the one to look at for the conditional rule: it carries the same
conditional as 517 and 518 and is out-ranked for every mode, so it produces
**no** conditional fact and **no** warning. Way 516 is the one to look at for
the diagnostic rule: its broken general value changes nothing and is still
reported.

Way 524 carries orthogonal direction and access tags so that all four records
can be watched together. None of the four derivations reads another's tags, and
524's direction and access are exactly what the same tags produce with no speed
tag present:

| Way | Tags | Motorcar | Bicycle | Foot |
| --- | --- | --- | --- | --- |
| 524 direction | `oneway=-1` `oneway:bicycle=no` | `reverse` | `both` | `both` |
| 524 access | `access=private` `bicycle=permissive` `foot=yes` | `private` | `permissive` | `allowed` |

Every other row is two-way for every mode and says nothing about access. All 24
roads keep the same three longitudes in the same order: a backward speed limit
is a second number, never a reversed line.

None of these facts says how fast anybody travels or how long a route takes.
They record what the source said.

## Limitations

This milestone is deliberately narrow. Not implemented, and not stubbed:

- routing, shortest paths, road graphs, turn restrictions, route costs
- routing policy of any kind: Atlas records what the source said about access,
  never whether a route may use the road. A motorway can report a bicycle
  direction and a footway a motorcar direction, and both may report
  `unspecified` access; these are source facts, not permissions
- country-specific default access and speed tables, and either inferred from
  highway class. Both are jurisdictional legal defaults rather than facts about
  the way, and storing one would make it indistinguishable from a surveyed fact
- travel-time estimation, expected or assumed travel speeds, route costs and
  live traffic. Atlas records a **legal maximum**, and computes nothing from it
- `surface` and every other `highway` semantic — apart from travel direction,
  the `highway` value is used for display classification only
- `.osm.pbf`, compressed input, network downloads, file upload
- persistent storage; the dataset is rebuilt from the source file on every start
- spatial indexing; queries are a linear scan, with diagnostics to prove when
  that stops being acceptable
- vector tiles, authentication, geocoding, live traffic, external map tiles

Access, specifically, is bounded as follows:

- Conditional access expressions are **detected, never parsed**. Any applicable
  one makes that mode `conditional`. Opening hours, dates, weights and every
  other condition are unevaluated, and time-dependent access is not modelled.
- `access:lanes`, `access:forward`, `access:backward` and every other
  directional or per-lane access key are not read. Access is derived for the
  whole way.
- Barriers, gates, bollards and node-level access are not read. Vehicle
  dimensions, weight, height and axle restrictions are not modelled.
- `hgv`, `psv`, `bus`, `horse`, `motorcycle`, `ski`, `inline_skates` and the
  rest of the long tail of mode keys are not read: only `access`, `vehicle`,
  `motor_vehicle`, `motorcar`, `bicycle`, `foot` and their conditional
  siblings.
- No legacy aliases are accepted. `public`, `restricted`, `official` and
  anything else outside the documented table stay `indeterminate` and visible
  in the warnings.
- `AgriculturalOnly`, `ForestryOnly` and `MilitaryOnly` are recorded faithfully
  and consumed by nothing yet.
- Access says nothing about direction and direction says nothing about access.
  A road can be one-way and prohibited, and Atlas records both without letting
  either qualify the other.

Speed, specifically, is bounded as follows:

- A `maxspeed` is a **legal maximum**, never a travel speed, a routing
  assumption or a journey time. Nothing in Atlas derives a speed from a road
  class, a country, a surface or a time of day.
- Conditional speed expressions are **detected, never parsed**. An applicable
  one sets `conditional` and leaves the ordinary limit alone. Opening hours,
  weather, dates, weights and every other condition are unevaluated.
- Implicit codes such as `RO:urban`, `AR:urban:primary` and `DE:zone:30` are
  preserved whole — every context component, in the order and structure the
  source gave — and **not resolved** to a number. Doing so would need a table
  of every jurisdiction's defaults, kept current, and a record of which edition
  of the law each extract was surveyed under.
- Units are never converted. `30 mph` stays `30 mph` end to end.
- `maxspeed:type`, `source:maxspeed`, `zone:maxspeed`, `maxspeed:advisory`,
  `minspeed` and every lane-specific speed key are not read.
- `maxspeed:hgv`, `maxspeed:psv`, `maxspeed:bus` and the rest of the long tail
  of mode keys are not read: only `maxspeed`, `maxspeed:vehicle`,
  `maxspeed:motor_vehicle`, `maxspeed:motorcar`, `maxspeed:bicycle`,
  `maxspeed:foot`, their `forward`/`backward` and `:conditional` siblings, and
  the three `maxspeed:variable` keys.
- `maxspeed=unknown` and the deprecated `maxspeed=signals` are recorded as
  indeterminate and diagnosed rather than translated into something the mapper
  did not say.
- `SpeedUnit::Knots` is recorded faithfully and consumed by nothing yet.
- Speed says nothing about access or direction, and neither says anything about
  speed. A prohibited road still carries a limit and a one-way road still
  carries both directions, and Atlas records all of it without letting any one
  fact qualify another.
- Studio shows speed in the inspector only. There is no speed overlay and no
  colour scale, because a colour scale would need thresholds and thresholds
  would imply a travel speed.

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
