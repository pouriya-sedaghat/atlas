# ADR-010: Source-derived road topology, and why it is not a routing graph

- Status: accepted
- Date: 2026-09-21

## Context

Atlas already records four independent facts about every road it imports.
[ADR-002](ADR-002-osm-as-an-input-adapter.md) established how a road becomes a
feature and what its classification means.
[ADR-007](ADR-007-profile-aware-road-directionality.md) derived which *way*
along a road each mode travels.
[ADR-008](ADR-008-explicit-access-facts-and-routing-policy.md) derived what the
source says about *who may use it*.
[ADR-009](ADR-009-explicit-directional-speed-limit-facts.md) derived what the
source says the *legal maximum speed* is.

All four describe one road in isolation. None of them says anything about how
roads relate to one another, and a map made only of unrelated line strings can
be drawn but cannot be reasoned about. This milestone answers the next question
and only the next question: **which road paths are structurally connected, and
into which stable segments are they split?**

OpenStreetMap answers that question through node identity. A way is an ordered
list of `<nd ref>` references, and two ways are joined precisely where they name
the same node. The reference material for the semantics summarised here:

- <https://wiki.openstreetmap.org/wiki/Elements>
- <https://wiki.openstreetmap.org/wiki/Node>
- <https://wiki.openstreetmap.org/wiki/Relation:restriction>

This milestone derives structural topology only. Routing, costs, turn
restrictions, travel-time estimation, shortest paths, mode-specific graph
pruning and any notion of a "usable" edge are deliberately out of scope.

## Decision

### Topology is not a routing graph

This is the distinction the whole ADR exists to protect, and it is the one that
is cheapest to lose and most expensive to get back.

A `RoadSegment` says that two source points are joined by one part of one road
geometry. It does **not** say:

- that any mode may travel it — that is `RoadAccess`, on the road;
- which way a mode travels it — that is `RoadTraversal`, on the road;
- how fast the law allows — that is `RoadSpeedLimits`, on the road;
- what it costs, how long it takes, or whether a route should use it.

A routing graph is a topology *plus* a policy: a decision about which segments a
particular mode may traverse, in which direction, at what cost. That policy is a
routing profile's job. Atlas has no routing profiles, so it has no routing
graph, and calling this one would invite exactly the mistake of treating a
structural connection as permission to travel.

Prominent rustdoc on `RoadSegment` says so, the wire DTO says so, the Studio
inspector says so in words the reader sees, and the segment type carries no
member that could be mistaken for a cost or a permission.

### Topology belongs to the `Dataset`, not to `FeatureKind::Road`

`FeatureKind::Road` remains exactly the owner of
`{ class, traversal, access, speed_limits }`. Topology is not a fifth member,
and the reason is structural rather than stylistic.

Those four are facts *about one road*. They can be derived from that road's own
tags, they are true whether or not any other road was imported, and a road that
is deleted takes them with it. Connectivity is none of those things. Whether a
point is a junction depends on how many *other* roads use it, which cannot be
known while looking at one way. Putting topology on the road variant would
either mean a road that cannot be constructed until every other road is known,
or a mutable field filled in later — and a mutable field on a value whose whole
promise is immutability.

Connectivity is a relationship across features, so it belongs to the thing that
owns the set of features: the `Dataset`.

The split within topology follows the same logic. `atlas-kernel` owns the
*value objects* — `RoadNodeId`, `RoadSegmentId`, `RoadNode`, `RoadSegment` —
because a validated node means the same thing everywhere. `atlas-engine` owns
the *aggregate* `RoadTopology`, its deterministic collections and its adjacency
index, because "which segments meet here" is a fact about one dataset, and
datasets are the engine's business.

### Identity is the only connectivity key

Two road paths are connected where they share a **source point identity**, and
nowhere else. In particular:

- **Equal coordinates with different identities do not connect.** Two nodes at
  one position are two topology positions. Merging them would invent a
  connection the source never described — and mappers place coincident nodes
  deliberately, for example where a bridge deck meets a separately mapped path.
- **Geometric crossings do not connect.** Two lines that cross on the page share
  no node, which is precisely how OSM distinguishes a junction from an overpass.
  Joining them would create turns that do not exist, at a scale that grows with
  every extract.
- **No tag decides connectivity.** `oneway*`, `access*`, `maxspeed*`, road
  class, `barrier`, `layer`, `level`, `bridge`, `tunnel` and relation membership
  are never consulted. Those are either road facts (already modelled elsewhere)
  or routing policy (not modelled at all). `layer` and `bridge` are tempting —
  they *describe* the overpass — but they are redundant: the absence of a shared
  node has already said it, and consulting them would mean a mistagged bridge
  silently changes the graph.

The one thing coordinates *are* used for is validation: a segment's geometry
must begin at its start node's position and end at its end node's position. That
checks the derivation against itself; it never decides a join.

### Segments are undirected, and reference road facts rather than copying them

A segment's `start` and `end` name the first and last point **in geometry
order**. They are not an origin and a destination. Nothing ever reverses a road
or a segment geometry to match a direction of travel: a reverse one-way is
stored exactly as the source drew it, and its direction is read from the road.

Two reasons. First, direction is per mode — a road can be forward for cars and
two-way on foot — so there is no single direction a segment could be oriented
to. Second, orienting geometry to travel would make the segment's coordinates
disagree with the feature's, and a client joining the two would draw one road
twice, in two directions.

For the same reason a segment stores a `FeatureId` and not a copy of the road's
class, direction, access or speed. Copying would create a second home for a fact
that has one, and a second thing to keep in step with the source. The wire
format makes the join explicit as `roadFeatureId`, and a client that wants a
road fact asks the feature endpoint for that feature.

### Split-point rules, loops and degree

A source point becomes a public `RoadNode` when at least one rule applies:

1. it is the first point of an accepted road path;
2. it is the last point of an accepted road path;
3. its source identity occurs more than once across accepted road paths;
4. its source identity repeats inside one accepted path.

Rules 3 and 4 are one rule in the implementation — total occurrence count
greater than one — because a junction between two roads and a road revisiting
its own point are the same underlying fact: the identity was seen more than
once. All other points remain geometry shape points and never become nodes.

Each path is then split at **every occurrence** of a public node, and each
consecutive pair of split occurrences becomes one segment, retaining every
intermediate shape coordinate in source order.

The consequences are deliberate:

- A **closed way** whose only split point is its repeated endpoint becomes one
  self-loop segment. A roundabout with approaches splits at the approach nodes
  instead, into as many segments as it has split points.
- A **repeated internal point** splits every occurrence, so the part of the way
  between the two visits becomes a segment that starts and ends at the same
  node. A self-loop is legitimate structural topology, not a degenerate case to
  reject.
- **Degree counts incident segment ends**, so a self-loop contributes two. That
  is the multigraph definition and the only one that keeps the invariant that
  the degree sum equals twice the segment count.
- **Parallel segments remain distinct.** Two roads joining the same pair of
  nodes are two segments, because they are two roads.
- Degree is a **shape, not a rank**. A junction of five alleys has a higher
  degree than a motorway running through. Studio's styling and wording are
  chosen so a reader cannot mistake one for the other.

Segment identifiers are deterministic from the owning feature identity and the
segment's ordinal within that road — today, `osm:way:10:segment:0`. The text is
stable and tested, and clients are told explicitly to treat it as opaque:
`roadFeatureId` is the join, not string surgery on an id.

### Paths are import-time, and keep more than the display geometry

The importer collapses adjacent duplicate coordinates when it builds a feature's
`LineString`, because two copies of one position draw nothing extra. That
behaviour predates this milestone and is unchanged.

A `RoadPath` does **not** collapse. Two source identities at one position are
two topology positions, and dropping one would either merge two distinct nodes
or delete a zero-length structural connection the source described. The
`roads-basic` fixture exercises exactly this: way 106 renders with two
coordinates and its segment carries three.

Paths exist only for the duration of an import and are discarded by
`DatasetBuilder::finish` as soon as the topology is derived, so nothing
downstream can come to depend on import-time detail.

### Atomic publication and capacity bounds

Features and topology are produced by one call to `DatasetBuilder::finish` and
published inside one `Dataset`, in one `DatasetRegistry::publish`. There is no
window in which a client can see a feature whose segments do not exist yet.

This is why the import handoff is an `ImportedRoad` — a feature *and* its path —
rather than a bare feature, and why there is deliberately no feature-only sink
method beside it. An adapter that could hand over a road without its path would
produce a dataset whose topology silently omits roads its feature collection
contains, and nothing in the types would say so.

#### The envelope guarantees correspondence, not just co-presence

Co-presence on its own is too weak. It would let an adapter pair a road drawn
in one place with a path running through another, and the dataset would then
publish segments whose coordinates fall outside the bounds of the very road
they name — a graph that validates internally, because each segment does begin
and end at its own nodes, while disagreeing with the feature collection beside
it. Nothing downstream could detect that: the topology build checks segments
against nodes and nodes against paths, and every one of those checks would
pass.

`ImportedRoad::new` therefore also verifies that the path describes **the same
ordered geometry** as the feature. This is the only point in the system where
both are in one hand, so it is the only place the check can be made once rather
than inferred repeatedly.

The comparison is on **canonical positions**: the coordinate sequence with
adjacent duplicates collapsed, on both sides. That is precisely the freedom the
two representations are meant to have, and no more:

- a display line of two coordinates and a path of three identities, where two
  identities share one position, **corresponds** — this is the documented
  `roads-basic` way 106 case, and it is accepted;
- an adjacent duplicate on the *feature* side is collapsed for the comparison
  too, symmetrically;
- a **reversed** line does not correspond, because coordinate order is the
  source's own and direction of travel is a road fact, not a licence to
  re-order;
- an **unrelated** line, a line **missing an intermediate** position, or one
  carrying an invented bend does not correspond;
- a **non-adjacent** repeat is not a duplicate to collapse. A way that returns
  to a position it already visited describes a genuine shape, and flattening it
  would make two different roads look alike.

The path's identities are never mutated or collapsed by this check; only a
throwaway comparison form is derived from them. A `RoadPath` that reaches the
builder is exactly the one the adapter produced.

A topology that cannot be derived is a **dataset build failure**, not a bounded
warning. Bad source data — a way naming a node the file never defined — is
ordinary and becomes a skipped road with a warning, exactly as before. But one
identity claiming two different coordinates, a duplicate public identifier, or a
segment pointing at a node nobody built means Atlas itself produced something
incoherent, and publishing it would be worse than publishing nothing. The
registry treats such a failure like any other failed import: the previously
published dataset stays in place and queryable, and the failure is recorded with
a safe public category while the detail goes to the logs.

Topology memory is bounded separately from feature count, because the two grow
differently. Feature geometry is handed to the sink and forgotten; path points
are retained for the whole import so the cross-road occurrence count can be
taken at `finish`, and one pathological way can carry tens of thousands of them.
`DatasetBuilder::DEFAULT_TOPOLOGY_POINT_CAPACITY` bounds that, is configurable
in tests, and fails the import atomically when exceeded.

### Relations and turn restrictions stay deferred

Relations are still counted and reported as `UNSUPPORTED_RELATION`, and never
interpreted. A turn restriction says that a particular manoeuvre *through* a
junction is forbidden for some mode. That is a statement about permitted travel,
which is the routing policy this milestone deliberately does not model — and it
cannot even be expressed before the junction it constrains exists. Topology is
the prerequisite, not the consumer. The synthetic fixture pins the boundary with
a restriction-shaped relation that is counted and ignored.

### The feature endpoint is unchanged, and the new endpoint is additive

`/api/v1/map/features` produces exactly the JSON it produced before, for every
pre-existing fixture, with the same API version, media type, warning order and
warning semantics. A client that has never heard of topology cannot tell that
this milestone happened.

Topology is served by a new route, `/api/v1/map/topology`, as
`application/json` rather than `application/geo+json`. The payload is a graph —
nodes with degrees, undirected segments with endpoints — and a GeoJSON
`FeatureCollection` would be a lie about its shape even though the segment
geometries inside it are GeoJSON `LineString` objects. Folding topology into the
feature endpoint would have meant a response whose shape changes with a flag,
and a client that wants roads paying for a graph it never asked for.

Only two members were added to an existing payload: `topologyNodes` and
`topologySegments` on the current-dataset statistics. Both are final dataset
counts, not source-element counters, and every existing counter keeps its exact
meaning.

### Atlas Studio makes topology opt-in

Topology is off by default, has its own toggle separate from the diagnostics
one, and issues **zero** requests while off. It uses its own MapLibre sources
and its own leaf layer module, which is a separate composition root from the
road stack: neither imports the other, so the overlay cannot reintroduce a
circular import and cannot be flattened into road properties.

Switching travel profile makes no topology request, because a profile is a
question about who may travel and topology is a question about what is joined.
A topology query failure is shown and never removes or corrupts the road map.
Disabling the overlay removes its own layers and sources and refetches no road
features.

## Consequences

- Atlas can now answer "what is connected to what" without being able to answer
  "may I go this way", which is the correct order to learn the two.
- A future routing milestone has a stable, tested substrate to build a profile
  on, and the substrate carries no policy it would have to unlearn.
- Topology counts are not feature counts and not source counts, and the three
  will routinely disagree. That is expected: `nodesIndexed` counts what the file
  defined, `topologyNodes` counts what turned out to be a junction or an end.
- Datasets cost more memory than before, bounded explicitly rather than
  implicitly.

## Alternatives considered and rejected

**Ship a shortest-path API directly.** It would have needed a traversal policy,
a cost model and turn handling, all invented at once and all untestable against
a source file — and a bug in any of them would have been indistinguishable from
a bug in the connectivity underneath. Topology is separately verifiable against
the source: a fixture states which nodes exist and a test pins exactly which
segments and degrees follow.

**Join on coordinates instead of identity.** Tempting because it needs no node
index, and wrong at both ends. It merges coincident nodes that the source
deliberately kept apart, and it joins overpasses to the roads beneath them. It
also introduces a tolerance, and every tolerance is a knob whose correct value
varies by extract, by latitude and by source precision.

**Split the road features themselves at junctions.** This would change every
existing feature id, every `/api/v1/map/features` payload and every client that
pinned an id — to solve a problem that a separate segment collection solves
without touching anything. It would also destroy information: a road is a road
even where it crosses another, and a name, a class and a speed limit belong to
the whole of it.

**Check feature/path correspondence later, or not at all.** Trusting the
adapter was the original shape and it was too weak: an envelope that only
guaranteed co-presence still allowed a dataset whose topology and features
describe different roads, and no downstream check could have caught it. Doing
the comparison in the topology build instead would mean holding both forms
further than necessary and reporting a whole-dataset failure for what is one
adapter's bug on one road.

**Copy direction, access, speed and class onto segments.** It would make
segments self-sufficient for a router and create four duplicated facts that
drift from the road the moment anything is re-derived. Worse, it would make a
segment *look* like a routing edge, which is exactly the confusion this ADR
exists to prevent. A `FeatureId` reference costs one lookup and keeps one home
per fact.

**Interpret turn restrictions now.** A restriction constrains a manoeuvre
through a junction, and before this milestone there were no junctions to
constrain. Interpreting them first would have meant inventing an ad-hoc notion
of a junction inside the OSM adapter, in a crate whose types are private for
good reason, and then reconciling it with the real one later.

**Derive topology in a third XML pass.** Rejected because it is unnecessary.
Deciding whether a point is a junction needs the occurrence count across all
accepted roads, which no single-way pass can have; but the dataset builder
already materialises every accepted road, so retaining their source-neutral
paths until `finish` gives the cross-road view without reading the file again.
