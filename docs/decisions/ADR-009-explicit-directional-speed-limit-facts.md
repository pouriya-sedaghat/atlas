# ADR-009: Explicit directional speed-limit facts, and what Atlas refuses to compute

- Status: accepted
- Date: 2026-09-20

## Context

[ADR-007](ADR-007-profile-aware-road-directionality.md) derived which *way*
along a road each mode travels. [ADR-008](ADR-008-explicit-access-facts-and-routing-policy.md)
derived what the source says about *who may use it*. This milestone answers a
third, independent question: **what the source says the legal maximum speed
is** — per mode, and per geometry direction.

OpenStreetMap says this through the `maxspeed` key and a family of narrower and
directional keys below it — `maxspeed:motorcar`, `maxspeed:vehicle`,
`maxspeed:forward`, `maxspeed:bicycle:backward` and so on — each of which can
also carry a `:conditional` sibling. Beside them sits `maxspeed:variable`,
which says whether the limit is displayed by a variable sign. Values range from
plain numbers through `none` and `walk` to jurisdiction codes such as
`GB-WLS:nsl_restricted`, `AR:urban:primary` and `DE:zone:30`, with three units,
three discouraged unit aliases, and a deprecated `signals` value the source has
since replaced.

The reference material for the semantics summarised here:

- <https://wiki.openstreetmap.org/wiki/Key:maxspeed>
- <https://wiki.openstreetmap.org/wiki/Key:maxspeed:conditional>
- <https://wiki.openstreetmap.org/wiki/Key:maxspeed:variable>
- <https://wiki.openstreetmap.org/wiki/Conditional_restrictions>
- <https://wiki.openstreetmap.org/wiki/Map_features/Units>

This milestone derives speed-limit facts only. Routing, graphs, travel-time
estimation, country default tables, `maxspeed:type`, `zone:maxspeed`, advisory
and minimum speeds, per-lane speeds and live traffic are all deliberately out
of scope.

## Decision

### A legal maximum is not a travel speed

This is the distinction the whole ADR exists to protect, and it is the one that
is cheapest to lose and most expensive to get back.

`maxspeed=50` says that the law forbids exceeding fifty kilometres per hour. It
does not say that anybody travels at fifty, that a router should assume fifty,
or that this road takes a kilometre divided by fifty to traverse. A road signed
at 50 may be gridlocked; a road with `maxspeed=none` may be crawling; a
`walk`-signed alley may be the fastest way across a square.

Atlas therefore records the limit and computes nothing from it. There is no
`expected_speed`, no `travel_time`, no cost and no colour ramp. A future
routing profile may combine a limit with a road class, a country, a surface, a
vehicle and a time of day to *estimate* a speed — and that estimate will be a
routing decision, made where routing decisions belong, traceable to inputs a
reader can inspect. It will not be something an import quietly decided in 2026.

The same rule governs the presentation layer, which is why Studio gained no
speed overlay. A colour scale needs thresholds; thresholds mean "fast" and
"slow"; "fast" is a journey-time claim. The inspector shows the number in
words, and the map draws nothing.

### Exact magnitudes, preserved units, no floats

A `Speed` holds a **validated canonical decimal string** and a `SpeedUnit`. Two
properties follow, and both are about being able to trust the value later.

**Exactness.** `50.5` is `50.5`, not `50.49999999999999289457264239899814`. A
legal limit is a number somebody wrote on a sign, and an import's job is to
repeat it. Canonicalisation strips only what carries no information —
`050.500` becomes `50.5`, `0.0` becomes `0` — and never rounds or rescales.

**Determinism.** Equality, ordering, hashing and serialisation are decided by
the canonical digits, so two imports of one file produce values that are equal,
sort identically and serialise byte for byte the same. Float equality could not
promise any of that, and the wire member is a JSON **string** for exactly the
same reason: a JSON number becomes a double on most clients, and `50.5` stops
being `50.5`.

The unit is the one the source stated, and **Atlas does not convert**.
`30 mph` reaches the wire and the inspector as `30` and `mph`. Converting would
replace what the source said with an arithmetic result carrying a rounding
error, and would erase the only evidence that the road was surveyed in a
country that signs in miles. A routing layer may convert when it knows what it
wants the number for. The three documented discouraged aliases — `kph`, `kmh`,
`kmph` — are accepted and canonicalised to `km/h`, because they are documented
spellings of a unit Atlas already has, not units of their own.

Ordering across units is deliberately *not* a physical comparison: `Ord` sorts
by unit first and by magnitude only within a unit, so it is a stable total order
for collections and never a claim that one road is faster than another.

### An implicit code is preserved whole, not resolved and not flattened

Some sources state the limit by naming the rule that applies rather than the
number it produces. Atlas validates the shape, normalises case, and stops
there:

```text
COUNTRY[-REGION]:segment[:segment...]
```

The country is two ASCII letters, an optional region is one to three ASCII
alphanumerics after a hyphen, and the context is **one or more** colon-
separated components of `[A-Za-z0-9_]+`. `RO:urban` and `GB-WLS:nsl_restricted`
are codes; so are `AR:urban:primary` and `DE:zone:30`, where a jurisdiction's
rule is further qualified by a road class or a zone.

Supporting several components is the point rather than an accident. A grammar
that allowed only one would turn documented, correct source values into
`Indeterminate` and raise `UNKNOWN_MAXSPEED_VALUE` against them — Atlas telling
a mapper their valid tag is broken, which is the worst thing a diagnostic can
do. The components are what the rule *is*, so they are kept whole, with the
colon structure between them intact: flattening `DE:zone:30` to `DE:zone` or
`DE:zone30` would record a different rule from the one the mapper named.

Accepting *more* components is not accepting *missing* ones. An empty component
names nothing, so `RO::urban`, `RO:urban:` and `RO:urban::extra` stay malformed
and are diagnosed as unreadable values.

Normalisation is case and nothing else: the jurisdiction upper-cases, every
context component lower-cases, and `ar:URBAN:Primary` and `AR:urban:primary`
become one code. The number the code implies is still **not** derived — that
would need a table of every jurisdiction's defaults, kept current, and a record
of which edition of the law each extract was surveyed under.

### Mode specificity, then direction specificity

Each of the six facts — three modes × two geometry directions — resolves down
its own chain, most specific key first. For a motorcar travelling forwards:

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

The ordering is OSM's own conflict order — **transportation-mode specificity
first, direction specificity second** — and it has a consequence worth stating
out loud, because it surprises people: a mode-specific *non-directional* key
beats a broader *directional* one. On a road carrying both `maxspeed:motorcar`
and `maxspeed:forward`, a car travelling forwards takes the motorcar value.
Fixture way 510 exists solely to hold that rule still.

A bicycle is a vehicle but not a motor vehicle, so the `motor_vehicle` level is
simply absent from its chain rather than skipped at runtime. A pedestrian is
neither, so no vehicle key reaches them.

### An unreadable specific value never falls back

If a way says `maxspeed:motorcar=maybe`, the mapper meant to say something
about motorcars. Quietly using the broader `maxspeed=50` instead would replace
their explicit statement with one they made about something else, and nothing
downstream could tell the substitution had happened. Atlas records
`Indeterminate` for that mode, in both directions, and leaves the other modes
alone. A directional key blocks only its own direction.

A `<tag k="maxspeed"/>` with no `v` at all reaches the adapter as a blank value
through the XML boundary corrected in Milestone 2B, and blocks fallback exactly
as `v=""` does. It is a statement Atlas cannot read, not the absence of one.

### Conditional and variable are modifiers, not limit variants

`SpeedLimitValue` deliberately has no `Conditional` and no `Variable` variant.
They live beside it on `SpeedLimitFact`:

```rust
pub struct SpeedLimitFact {
    limit: SpeedLimitValue,
    conditional: ConditionalSpeedLimit,
    variable: VariableSpeedLimit,
}
```

The reason is that neither erases the ordinary limit. A road signed at 80 with
`maxspeed:conditional=60 @ wet` still has an ordinary limit of 80, and a road
signed at 100 with `maxspeed:variable=yes` still has an ordinary limit of 100.
If they were variants, a client reading a `Conditional` road would have lost
the 80 entirely — the very number that applies most of the time.

`Conditional` is a two-state fact because Atlas detects a conditional
**by key** and never reads the expression. Reading `60 @ wet` honestly would
need a weather model and a clock; recording a rainy-Tuesday limit as a
permanent fact would be worse than saying nothing. `Variable` has four states
because the source distinguishes "nobody tagged it" from "somebody said it does
not vary", and those are different states of knowledge.

Two more values earn their own treatment rather than a silent translation.
`maxspeed=unknown` is **not** a recognised correct value — the source says an
unknown limit should be represented by omitting `maxspeed` — so it is
indeterminate *and* diagnosed. `maxspeed=signals` is deprecated in favour of
`maxspeed:variable=*`; translating it into a variability claim the mapper did
not make at that key would be Atlas guessing, so it too is indeterminate and
diagnosed.

### Malformed static diagnostics ignore precedence; unsupported conditionals do not

The same two-pass split Milestone 2B settled on, for the same reason, and it is
worth restating because the asymmetry looks arbitrary until you name what each
warning is *about*.

`UNKNOWN_MAXSPEED_VALUE`, `UNSUPPORTED_MAXSPEED_UNIT` and
`UNKNOWN_VARIABLE_MAXSPEED_VALUE` are **findings about the source file**. A
scan reads every supported static key and all three variable keys the road
carries, regardless of precedence, and asks whether the value is readable and —
when it is not — whether the magnitude at least was. Neither question depends
on which key precedence went on to choose. A `maxspeed=bogus` behind three
valid mode keys is still broken, and a diagnostic that went quiet the moment
something shadowed the mistake would hide exactly the mistakes a mapper most
needs to find: the broken value would appear in no report Atlas publishes.

`UNSUPPORTED_CONDITIONAL_MAXSPEED` is the deliberate exception and stays
**selected-only**. A conditional tag is not a defect — it is valid, correct
data that Atlas has chosen not to evaluate — so the warning describes a
limitation of *Atlas*, not a flaw in the *source*. Atlas is only limited by a
condition that reaches one of the six facts. A conditional out-ranked for every
mode and direction shaped nothing, so it produces neither a modifier nor a
warning. Fixture ways 517, 518, 519 and 520 pin all four cases.

In both cases a shadowed tag **never changes a derived value**. The scan
reports; only the precedence walk decides. That split is a split in the code as
well as in the prose: `scan_static_tags` and `scan_variable_tags` build the
diagnostics, `resolve` builds the facts, and neither reads the other's output.
Every code is recorded at most once per road, so the counts are counts of
roads — not of tags, modes or directions.

### Forward and backward are relative to the geometry

`SpeedDirection::Forward` means "along the coordinate order of the line",
exactly as `TravelDirection::Forward` does. It is not the compass, and it is
not the direction the traffic is allowed to run.

Two consequences follow. A **one-way road still has two speed facts**, because
the source is describing the road rather than the traffic; fixture way 524 is a
reverse one-way signed 70 forward and 30 backward, and publishes both. And
**Atlas never reverses a geometry**, because doing so would silently invert the
meaning of every speed fact attached to it — the same rule direction has
followed since ADR-007, now with a second reason behind it.

### Four independent records on one road

`FeatureKind::Road` now carries `{ class, traversal, access, speed_limits }`.
They are inseparable from a road and independent of one another: none is a view
of, or derivable from, any other.

The combinations that look contradictory are the point. **A prohibited road may
carry a speed limit**, because the sign is on the post whether or not anyone may
drive past it — and a router that wanted to know whether to use the road was
always going to read `access`, not guess from the absence of a number. A
motorway's class implies no limit, because a country's legal default is not
something the source said; encoding one here would put a legal default where a
surveyed fact belongs, and nothing downstream could tell the two apart.

The signature is the structural proof: `derive_speed_limits(tags: &OsmTags)`
takes tags and nothing else — no class, no traversal, no access, no geometry,
no country, no configuration. A country default cannot have crept in because
there is nothing to compute one from.

### No `Default` on a source-derived record

`SpeedLimitValue`, `SpeedLimitFact`, `DirectionalSpeedLimits` and
`RoadSpeedLimits` deliberately implement no `Default`, matching `RoadAccess`
and `RoadTraversal` before them.

"The source said nothing about speed" is a **claim about a source**. A
`Default` impl would let a half-built feature, a forgotten field or an older
adapter make that claim by accident, and the result would be indistinguishable
from a real import that read the tags and found none. Whoever says it calls
`RoadSpeedLimits::unspecified()` and says it out loud. A kernel test asserts the
absence of the impls, using the same method-resolution probe the access module
introduced.

### An additive v1 wire member

The kernel keeps speed strictly apart from traversal and access. At the DTO
boundary — and only there — the three per-mode records are zipped into the
existing `traversal.<mode>` object:

```json
{
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
}
```

The API version stays `1`. This is exactly the extension the object shape in
ADR-007 was chosen to allow and ADR-008 used once already: a client reading
`traversal.foot.direction` or `traversal.motorcar.access` is unaffected. A
second top-level profile map would have been the alternative, and it would have
put three facts about one mode in two places on the wire for no gain.

Speed is not gated behind `include`, for the same reason `traversal` and
`access` are not: it is what the feature *is*, not optional diagnostics about
it. Both directions and all three modes are published on every road.

### Studio degrades an older server to `indeterminate`, never to `unspecified`

Studio validates every speed value at runtime and displays nothing it did not
recognise — not an unknown kind, not an unknown unit, not a magnitude that is
not exact decimal text, not a code that is not shaped like one, and not a
hostile string. Anything else becomes `indeterminate`, which is the one answer
that cannot be wrong.

A **missing** speed block degrades the same way, and that is the important
half. A Milestone 2B server that never sent one has not established that the
source lacked speed tags — it has only failed to say. `unspecified` is a claim
about a source, and a client must not make it on a server's behalf. The client
therefore carries a three-state conditional (`not-tagged`, `present`,
`indeterminate`) where the wire has only a boolean, so that an absent `false`
is not silently rendered as a present one.

## Consequences

- The v1 wire format gains an additive `speedLimits` member inside each
  existing `traversal.<mode>` object. The API version and the
  `application/geo+json` media type do not change.
- Every road the new server produces carries both directions for all three
  modes. Roads from a source with no speed tags serialise
  `{ "kind": "unspecified" }` everywhere, which is why the Milestone 1, 2A and
  2B fixtures are untouched and assert exactly that.
- `FeatureKind::Road` grew a fourth field. Every construction site had to be
  updated explicitly with `RoadSpeedLimits::unspecified()`, which is the
  compile-time review this change wanted; there is no default or compatibility
  shortcut to fall back on.
- Four new stable issue codes join the public warning contract —
  `UNKNOWN_MAXSPEED_VALUE`, `UNSUPPORTED_MAXSPEED_UNIT`,
  `UNSUPPORTED_CONDITIONAL_MAXSPEED` and `UNKNOWN_VARIABLE_MAXSPEED_VALUE`.
  They are appended after the Milestone 1, 2A and 2B codes so the deterministic
  group order a client already sees does not shuffle. Each is recorded at most
  once per road.
- `Speed` is the first kernel value that is `Clone` but not `Copy`, because it
  owns a string. `RoadSpeedLimits` accessors therefore return references where
  the traversal and access accessors return values.
- Studio gains an inspector-only module. Speed is **not** flattened into the
  MapLibre properties, because no layer consumes it: flattening would ship
  twelve unused string properties per feature and invite the colour scale this
  ADR argues against. `toMapCollection` still strips the nested block and
  `indexFeatures` still keeps the original wire feature for the inspector.
- The inspector's selected profile now owns **four** highlighted rows —
  direction, access, forward speed, backward speed — and the other eight
  semantic rows stay visible. The Milestone 2B tests that expected two active
  rows were strengthened to expect four rather than relaxed.
- Switching profile in Studio stays a local recomputation with no third map
  update: there is no speed layer to re-filter. No request, no source update,
  no geometry change, and the selected road stays selected.
- `maxspeed:type`, `source:maxspeed`, `zone:maxspeed`, `maxspeed:advisory`,
  `minspeed`, lane-specific speed keys and country defaults are read by
  nothing. Unit tests assert that `maxspeed:type` and `source:maxspeed` change
  no derived limit, so the boundary is a tested decision rather than an
  accidental omission.
- `Knots` is recorded faithfully and consumed by nothing yet, like
  `Reversible`, `Alternating`, `AgriculturalOnly`, `ForestryOnly` and
  `MilitaryOnly` before it.
