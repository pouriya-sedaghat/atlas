# ADR-007: Profile-aware road directionality

- Status: accepted
- Date: 2026-09-20

## Context

A road is not equally traversable in both directions, and it is not equally
traversable by everyone. A one-way street is one-way for cars and usually not
for pedestrians; a contraflow cycle lane makes it two-way for bicycles only; a
tidal-flow ramp is not statically one-way at all.

OpenStreetMap says all of this through a family of `oneway` tags with
overlapping scopes, legacy spellings, per-mode suffixes and conditional
expressions. Those tags are the first thing a router needs and the first thing
a naive importer gets wrong, usually by collapsing everything into a boolean
and quietly attributing it to every mode.

This milestone derives direction only. Access, speed, graph construction, turn
restrictions and routing are all deliberately out of scope.

## Decision

### Source facts are separate from routing policy

`atlas-kernel` gains `TravelMode`, `TravelDirection` and an immutable
`RoadTraversal` holding one direction per mode. These describe what the source
said about the road. They are not a cost model, not a permission and not a
routing decision.

A router will later have policy of its own — a cyclist who dismounts, a
delivery profile that ignores a restriction, a pedestrian routed along a
carriageway with no pavement. That policy belongs to the router. If it were
baked into the import, two routers could not disagree, and the dataset could
not be re-used for anything but the one policy that happened to be compiled in.

The OSM vocabulary stops inside `atlas-osm`. The kernel never learns what a
`oneway` tag is; it only knows what a direction of travel means. A raw tag map
still cannot escape the adapter.

`FeatureKind::Road` becomes a struct variant carrying `class` and `traversal`
together, so a classification and its travel semantics cannot drift apart and
neither can be attached to a feature that is not a road.

### Direction is relative to geometry

`Forward` means "along the coordinate order of the `LineString`" and `Reverse`
means "against it". Nothing is expressed in compass terms, because a road bends
and a compass bearing would be true only at one point on it.

The consequence is a rule with teeth: **Atlas never reverses a geometry.**
Reversing a line would silently invert the meaning of every direction attached
to it. The importer emits coordinates exactly as the source drew them, the API
serves them unchanged, and Studio renders a reverse one-way by rotating its
arrow 180°, never by reordering its coordinates. The fixture test
`geometry_is_never_reversed_to_express_a_direction` exists to keep that true.

### Profile-specific overrides

Each mode has its own precedence chain, from the most specific tag to the least:
`oneway:motorcar` then `oneway:motor_vehicle` then `oneway` for a car,
`oneway:bicycle` then `oneway` for a bicycle, `oneway:foot` then a
class-specific reading of `oneway` for a pedestrian.

A present but unreadable override never falls back to a broader tag. If a
mapper wrote `oneway:motorcar=sometimes`, they meant to say something specific
about cars; substituting the plain `oneway` would be Atlas inventing an answer
the source never gave, and it would be indistinguishable from a real one.

### Indeterminate is conservative, and it is not a default

`TravelDirection::Indeterminate` records that Atlas cannot state a direction
safely. It is chosen over `Both` wherever the source is unreadable or dynamic.

`Both` is a claim: it states that the source imposed no directional
restriction. Making it the fallback for anything Atlas fails to parse would
turn every parse failure into a confident wrong statement, and a wrong
direction is far more dangerous than a missing one — it is exactly how a
router sends someone the wrong way up a street. A missing direction is
visible, warned about and easy to fix; a wrong one looks like data.

Unknown and ambiguous direction data never fails the import and never skips the
road. It produces a bounded warning — `UNKNOWN_ONEWAY_VALUE`,
`AMBIGUOUS_ONEWAY_SCOPE` or `UNSUPPORTED_CONDITIONAL_ONEWAY` — through the same
`IssueLog` as every other import problem, recorded at most once per road per
code so the counts stay meaningful.

### Foot does not blindly inherit plain `oneway`

A plain `oneway` is, by long convention, a statement about vehicles. Applying
it to pedestrians everywhere would turn every one-way street into a one-way
pavement, which is simply false and would be false on a very large number of
roads. Ignoring it everywhere would lose the one-way stairwells and passages
where it is the only thing said.

So the road class decides, and where the class cannot decide, Atlas says so:

- `steps` — the tag really is about the people using them, because nothing
  else does. It applies to foot.
- `path` and `footway` — the tag may be about the pedestrians or about the
  cyclists sharing the way. A directional or dynamic value without an explicit
  `oneway:foot` becomes `Indeterminate` plus `AMBIGUOUS_ONEWAY_SCOPE`.
- street-like classes, `track` and `cycleway` — a vehicle statement. Foot stays
  `Both`.
- `RoadClass::Other` — a class Atlas does not model cannot be reasoned about,
  so it is treated like a shared way rather than assumed to be a street.

An explicit `oneway:foot` always wins, including an `oneway:foot=no` that
reopens what a plain value closed. And an *unreadable* plain value never makes
foot ambiguous on an ordinary street: the scope question does not arise where
the tag was never about pedestrians.

Only two implied rules are applied — `junction=roundabout` and
`highway=motorway`, both forward for vehicles only, both overridable by an
explicit `oneway=no`. Every other "everybody knows this is one-way" convention
is a guess, and a guess stored in a dataset is indistinguishable from a fact.

### Conditional expressions are detected, not parsed

`oneway:conditional` and its per-mode siblings are recognised by key. Their
values are never read.

Parsing an opening-hours expression is a real piece of work with real edge
cases, and it would produce a *time-dependent* answer that a static
`RoadTraversal` has no way to hold. Half-parsing one would be worse than not
parsing it: picking whichever branch happened to look plausible would encode a
Tuesday-morning restriction as a permanent fact. Detection is cheap, honest and
forward-compatible — when Atlas grows a time model, these tags are already
flagged and the affected roads are already listed in the warnings.

A generic `oneway:conditional` reaches motorcar and bicycle but not foot, for
the same reason a generic `oneway` does.

### Access, speed, graph and routing stay deferred

Direction is the smallest useful piece of road semantics and it is worth
shipping alone.

Access (`access`, `motor_vehicle`, `bicycle`, `foot`, and their conditional
forms) is a larger tag family with its own inheritance rules and its own
ambiguities; mixing it into this milestone would mean two half-done models
instead of one finished one. Speed brings unit parsing, implied national
defaults and a country lookup. A graph brings way splitting at junctions, node
deduplication and turn restrictions. Routing brings cost models, which are
precisely the policy this ADR just finished separating from source facts.

Until access exists, direction says nothing about permission. A motorway will
report a bicycle direction and a footway a motorcar direction. Both are
statements about which way the road runs, not about who may use it. This is a
known and accepted consequence of shipping direction first, documented in the
README limitations and visible on purpose in the directionality fixture.

## Consequences

- The v1 wire format gains an additive `properties.traversal` member on every
  road, nested one object per mode. The API version does not change: a
  Milestone 1 client that ignores unknown members is unaffected.
- `traversal` is not gated behind `include`. It is what the feature *is*, not
  optional diagnostics about it.
- The kernel's `FeatureKind::Road` is now a struct variant. Every construction
  site had to be updated, which is the compile-time review this change wanted.
- Three new stable issue codes join the public warning contract. They are
  appended after the Milestone 1 codes so that the deterministic group order a
  client already sees does not shuffle.
- Studio flattens the nested block to one property per profile inside its
  GeoJSON adapter, because a MapLibre expression cannot read into a nested
  object. That flattening is a rendering detail and stops at the adapter; the
  wire format stays nested and the inspector reads the original feature.
- Switching profile in Studio is a local recomputation: a filter swap and a
  rotation-expression swap on one symbol layer. No request, no source update, no
  geometry change.
- `RoadTraversal` deliberately has no `Default`. A default would have to pick a
  direction without knowing the road class, the implied motorway and roundabout
  rules, or whether the source said something unreadable — and `Both` is a
  claim about a road, not a neutral zero value. Every traversal is constructed
  explicitly, `RoadTraversal::bidirectional()` included.
- `Reversible` and `Alternating` are recorded faithfully and consumed by
  nothing yet. They are deliberately not collapsed into `Both` or `Forward`,
  because a later scheduler will need to know which roads they are.
