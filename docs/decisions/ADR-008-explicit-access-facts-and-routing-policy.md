# ADR-008: Explicit access facts, and where routing policy begins

- Status: accepted
- Date: 2026-09-20

## Context

[ADR-007](ADR-007-profile-aware-road-directionality.md) derived which *way*
along a road each mode travels, and said plainly that it said nothing about
whether the mode may use the road at all. This milestone answers the second
half: what the source says about who may use a road.

OpenStreetMap says this through the `access` key and a family of narrower keys
below it — `vehicle`, `motor_vehicle`, `motorcar`, `bicycle`, `foot` and many
more — each of which can also carry a `:conditional` sibling. The values range
from `yes` and `no` through `destination`, `customers`, `permit` and
`use_sidepath` to `variable` and `unknown`. Countries then layer legal defaults
on top of all of it, which is where most of the real complexity lives.

The reference material for the semantics summarised here:

- <https://wiki.openstreetmap.org/wiki/Key:access>
- <https://wiki.openstreetmap.org/wiki/Key:access:conditional>
- <https://wiki.openstreetmap.org/wiki/Key:motorcar>
- <https://wiki.openstreetmap.org/wiki/Key:bicycle>
- <https://wiki.openstreetmap.org/wiki/Key:foot>
- <https://wiki.openstreetmap.org/wiki/OSM_tags_for_routing/Access_restrictions>

This milestone derives access only. Routing, graphs, costs, country default
tables, barriers, vehicle dimensions and directional or per-lane access are all
deliberately out of scope.

## Decision

### Access is not a boolean

`AccessRule` has nineteen variants, not two, because the source genuinely makes
nineteen different statements and a router will genuinely need to tell them
apart.

Collapsing them to a `bool` would have to answer "may this mode use this road?"
at import time. That question does not have an import-time answer. A delivery
van and a private car disagree about `delivery`. A resident and a through
driver disagree about `destination`. A permit holder and everyone else disagree
about `permit`. A cyclist who is willing to push their bike and one who is not
disagree about `dismount`. Every one of those disagreements is real, and every
one of them is destroyed by a `bool` — irrecoverably, because the dataset no
longer holds the fact that would let a later reader disagree.

So the import records the statement and refuses to evaluate it. Nineteen
variants is the cost of not having to re-import the world when the first
routing profile turns up and asks a question the boolean cannot answer.

### `Unspecified` is not `Allowed`

`AccessRule::Unspecified` means no applicable access tag was present. It is
neither permission nor prohibition, and it is a separate variant from
`Allowed`, which means the source said `yes`.

The two are easy to conflate and expensive to conflate. Most roads in
OpenStreetMap carry no access tag at all; almost all of them are in fact
usable, and it is tempting to short-circuit that. But "nobody has said" and
"somebody checked and said yes" are different states of knowledge, and only the
first one can be improved by surveying. If the import folded silence into
`Allowed`:

- a data-quality tool could no longer find the roads nobody has surveyed,
  because they would be indistinguishable from surveyed open ones;
- a routing profile could no longer apply a country default, because the
  country default only applies where the source is silent, and it would no
  longer be able to tell where that was;
- a wrong `Allowed` would look exactly like a right one.

The same distinction survives all the way to the client. Studio draws no
overlay for either — a map with an overlay on every untagged road would be a
map of OpenStreetMap's completeness, not of access — but the inspector says
"Not stated", never "Allowed".

### `RoadAccess` has no `Default`

`RoadAccess::unspecified()` is a named constructor, and `RoadAccess`
deliberately does not implement `Default`.

A `Default` would make "the source said nothing about access" the value that
appears wherever nobody said otherwise: in a half-built feature, in a test
fixture nobody looked at, in an adapter that forgot a field, in a
`..Default::default()` struct update. And "the source said nothing" is a claim
about a source. It is exactly the claim the previous section says must stay
distinguishable from a real answer — so it must not be something a forgotten
field can assert by accident. Whoever states it has read the tags and says so
out loud.

`AccessRule` has no `Default` either, for the same reason and one more: there
is no neutral rule. Every variant is a statement, including `Unspecified`.

This follows `RoadTraversal`, which refused a `Default` in Milestone 2A on the
same grounds. A kernel test asserts the absence of both impls, because the
language cannot state a negative bound and a comment is not a test.

### Access is separate from traversal direction

`FeatureKind::Road` now carries `class`, `traversal` and `access` as three
distinct values. None is derived from another, and none can be reconstructed
from another.

They are separate because the road facts they describe are separate, and the
combinations are not hypothetical:

- a forward one-way that bars motorcars — direction `Forward`, access
  `Prohibited`;
- a two-way private drive — direction `Both`, access `Private`;
- a designated cycleway that is also one-way — access `Designated`, direction
  `Forward`.

The rule with teeth is the rendering one: **a direction arrow never disappears
because access is prohibited.** The two live in different MapLibre layers,
driven by different flattened properties, and neither filter reads the other's.
A map that hid the arrow on a closed road would be answering a routing question
it has not been asked, and it would hide the arrow from the one reader who most
needs it — the person checking whether the road was mapped correctly.

Way 403 in the access fixture exists to keep that true: prohibited to
everybody, and still drawn with its one-way arrows.

### No access is inferred from highway class or country

`derive_access` takes tags and nothing else. It never reads `highway`, it is
never given the `RoadClass`, and there is no country table anywhere.

This is a real restraint, not an oversight. A motorway usually bars pedestrians
and a footway usually bars cars, and it would be easy to encode that. But those
are *legal defaults*, and legal defaults are:

- **jurisdictional** — the German motorway rule is not the Brazilian one, and
  the import has no idea which country a way is in;
- **not facts about the way** — they are facts about the law where the way
  happens to be, which changes without the way changing;
- **indistinguishable once stored** — an inferred `Prohibited` and a surveyed
  `Prohibited` would be the same value, so nothing downstream could apply a
  different default, and nothing could tell a surveyor what still needs
  surveying.

Contrast this with direction, where the classification *is* an input
(ADR-007: a motorway implies `Forward`, and the class decides whether a plain
`oneway` reaches pedestrians). That asymmetry is deliberate. The motorway
direction rule is close to universal and is about the road's physical design.
The motorway access rule is a traffic law, and traffic laws vary.

A routing profile knows its jurisdiction and its vehicle. It is the right place
for the default, and it can only apply one if the import left `Unspecified`
where the source was silent. Deferring the table is what makes the table
possible later.

### Specificity wins, and an unreadable specific value never falls back

Each mode has its own precedence chain, most specific first:

| Mode | Chain |
| --- | --- |
| Motorcar | `motorcar:conditional`, `motorcar`, `motor_vehicle:conditional`, `motor_vehicle`, `vehicle:conditional`, `vehicle`, `access:conditional`, `access` |
| Bicycle | `bicycle:conditional`, `bicycle`, `vehicle:conditional`, `vehicle`, `access:conditional`, `access` |
| Foot | `foot:conditional`, `foot`, `access:conditional`, `access` |

Within one specificity level the conditional form comes first, so
`motorcar:conditional` beats `motorcar`. Across levels specificity wins, so a
plain `motorcar` beats a `vehicle:conditional`: the mapper said something about
cars in particular, and a broader statement — however dynamic — does not
out-rank it.

A present but unreadable value stops the chain. `motorcar=maybe` makes the car
`Indeterminate`; it does not quietly become whatever `access` says. Falling
through would replace a mapper's explicit statement about this mode with a
statement they made about something else, and the result would be
indistinguishable from a real derivation. This mirrors ADR-007's rule for
`oneway:motorcar=sometimes` exactly.

### Conditionals are detected, not parsed

`access:conditional` and its five siblings are recognised by key. Their values
are never read.

Parsing an opening-hours or weight expression is a real piece of work with real
edge cases, and it would produce a *time-dependent* or *vehicle-dependent*
answer that a static `RoadAccess` has no way to hold. Half-parsing one would be
worse than not parsing it: reading `no @ (Mo-Fr 07:00-09:00)` as a plain `no`
would encode a rush-hour restriction as a permanent closure, and reading it as
`yes` would drop the restriction entirely. Both would look exactly like facts.

`AccessRule::Conditional` says what Atlas actually knows: a condition applies,
and Atlas has not evaluated it. Detection is cheap, honest and
forward-compatible — when Atlas grows a time model, these roads are already
flagged and already listed in the warnings.

A conditional that is out-ranked for every modelled mode changes nothing and
warns about nothing. It decided no answer, so there is nothing to report.

### Some values need a named mode

`designated`, `dismount` and `use_sidepath` each name something a particular
mode does. On the general `access` key there is no mode to name: designated for
whom, who dismounts, which mode uses the sidepath? Any mode that reaches such a
value on `access` gets `Indeterminate` and the road earns `INVALID_ACCESS_SCOPE`.

The check stops at the general key. `vehicle=designated` is unusual but it is
an explicit source fact with a subject, and Atlas records it. Deciding that a
mapper's explicit statement on a vehicle key is *wrong* would be routing policy
wearing a validator's hat, and this milestone is not a policy validator. The
line is "can this value mean anything here at all?", not "would a router like
it?".

### Dynamic and malformed states are represented, not hidden

Four variants exist to avoid lying:

- `Variable` — the source explicitly says access varies. That is a fact, and it
  is not the same as Atlas being unable to read one.
- `Conditional` — a condition applies and Atlas has not evaluated it.
- `Indeterminate` — Atlas saw access information and cannot derive a
  trustworthy rule, either because it could not read the value or because the
  value cannot mean what it says where it was written.
- `Unspecified` — nothing applicable was said.

`unknown` is a recognised OSM value meaning the surveyor could not tell. It
maps to `Indeterminate` and raises **no** warning, because there is nothing
wrong with the data: the source reported uncertainty accurately, and
complaining about it would train readers to ignore the warning list.

No legacy aliases are folded in. `public` and `restricted` appear in the wild
and mean different things to different people, so they stay unreadable and
visible in the diagnostics rather than being guessed at.

### Diagnostics are not precedence

Deriving a value and reporting a problem are two different questions, and they
are answered by two separate passes over the tags.

`scan_static_tags` walks every recognised static access key the road carries —
`access`, `vehicle`, `motor_vehicle`, `motorcar`, `bicycle`, `foot` — and asks
two questions of each value: could Atlas read it, and could it mean what it
says on the key it sits on? Both are properties of that tag alone. Neither
depends on which key precedence went on to choose, so **a mistake that a more
specific tag shadows is still reported**:

```
access=bogus
motorcar=yes
bicycle=yes
foot=yes
```

derives `Allowed` for all three modes and records `UNKNOWN_ACCESS_VALUE` once.

The first draft of this module raised those two codes only when the offending
key was the one precedence landed on, reasoning that a shadowed tag decided
nothing so complaining about it would be noise. That was wrong, and the example
above is why: the broken value would appear in no report Atlas publishes. A
mapper looking at the warnings would see a clean import of a file that contains
a typo. The whole point of keeping unlisted values unreadable rather than
guessing at them — stated above — is that they stay *visible*, and visibility
that switches off whenever something else out-ranks the mistake is not
visibility at all. `access=designated` behind three valid overrides is the same
story for `INVALID_ACCESS_SCOPE`.

`UNSUPPORTED_CONDITIONAL_ACCESS` is the deliberate exception and remains
selected-only, because it is not the same kind of finding. A conditional tag is
not a defect: it is valid, correct data that Atlas has chosen not to evaluate.
The warning therefore describes a limitation of *Atlas*, not a flaw in the
*source* — and Atlas is only limited by a condition that reaches the modelled
result. A conditional out-ranked for all three modes shaped nothing, so it
produces neither a `Conditional` rule nor a warning.

The dividing line, then:

| Finding | About | Recorded |
| --- | --- | --- |
| `UNKNOWN_ACCESS_VALUE` | the source data | wherever the value appears |
| `INVALID_ACCESS_SCOPE` | the source data | wherever the value appears |
| `UNSUPPORTED_CONDITIONAL_ACCESS` | Atlas's own limits | only when it decides something |

In every case the scan only ever *reports*. It cannot move a derived rule, and
`resolve` cannot raise a data-quality flag: the two functions do not read each
other's output. That separation is what makes the rule above checkable rather
than a convention, and
`a_shadowed_diagnostic_never_changes_a_derived_rule` keeps it honest.

### How a future routing profile uses all this

Nothing here answers "can a router use this road?". A routing profile will,
roughly:

1. take a `RoadAccess` and a mode;
2. where the rule is `Unspecified`, apply its own jurisdiction-and-class
   default table — which it can only do because the import left the silence
   intact;
3. where the rule is a purpose limit (`DestinationOnly`, `DeliveryOnly`,
   `CustomersOnly`, `AgriculturalOnly`, `ForestryOnly`, `MilitaryOnly`,
   `PermitRequired`), decide against the journey's own purpose and credentials
   — a delivery profile routes over `DeliveryOnly`, a tourist does not;
4. where the rule is `Permissive` or `Discouraged`, apply a cost penalty rather
   than a hard exclusion;
5. where the rule is `DismountRequired` or `UseSidepath`, switch mode or
   penalise rather than exclude — a cyclist who will push can use the way;
6. where the rule is `Conditional` or `Variable`, decide its own risk posture:
   avoid, penalise, or (once a time model exists) evaluate;
7. where the rule is `Indeterminate`, decide whether to trust the road at all.

Every one of those steps needs a distinction the import preserved and a
`bool` would have destroyed. That is the whole argument of this ADR in one
list.

## Consequences

- The v1 wire format gains an additive `access` member inside each existing
  `traversal.<mode>` object. The API version does not change: this is exactly
  the extension the object shape in ADR-007 was chosen to allow, and a client
  reading only `traversal.foot.direction` is unaffected.
- `access` is not gated behind `include`, for the same reason `traversal` is
  not: it is what the feature *is*, not optional diagnostics about it.
- Every road the new server produces carries access for all three modes. Roads
  from a source with no access tags serialise `unspecified` everywhere, which
  is why the Milestone 1 and 2A fixtures are untouched and assert exactly that.
- `FeatureKind::Road` grew a third field. Every construction site had to be
  updated, which is the compile-time review this change wanted.
- Three new stable issue codes join the public warning contract —
  `UNKNOWN_ACCESS_VALUE`, `INVALID_ACCESS_SCOPE` and
  `UNSUPPORTED_CONDITIONAL_ACCESS`. They are appended after the Milestone 1 and
  2A codes so the deterministic group order a client already sees does not
  shuffle. Each is recorded at most once per road.
- Diagnostics and precedence are answered in **two separate passes**, because
  they are two different questions. `UNKNOWN_ACCESS_VALUE` and
  `INVALID_ACCESS_SCOPE` come from a static scan of every recognised static
  access key the road carries, **independent of precedence**: whether a value
  is readable, and whether it can mean what it says on the key it sits on, are
  properties of that tag alone. A mistake a more specific tag shadows is still
  a mistake in the file, and a diagnostic that fell silent the moment something
  out-ranked it would hide precisely the errors a mapper needs to find — the
  broken value would appear in no report Atlas publishes. This matches the
  direction module, which likewise scans every direction key it reads.
- `UNSUPPORTED_CONDITIONAL_ACCESS` is the deliberate exception and stays
  **selected-only**. A conditional tag is not a defect: it is valid, correct
  data that Atlas has chosen not to evaluate, so the warning describes a
  limitation of *Atlas* rather than a flaw in the *source*. Atlas is only
  limited by a condition that reaches the modelled result, so a conditional
  out-ranked for all three modes produces neither a `Conditional` rule nor a
  warning.
- In both cases a shadowed tag **never changes a derived value**. The scan
  reports; only the precedence walk decides. This is why the split is a split
  in the code as well as in the prose: `scan_static_tags` builds the
  diagnostics and `resolve` builds the rules, and neither reads the other's
  output.
- Studio flattens access to one property per profile alongside the direction
  properties, in the same GeoJSON adapter and under the same boundary
  discipline: a rendering detail that stops at the adapter, with the wire
  format staying nested and the inspector reading the original feature.
- Studio treats a *missing* access member as `Indeterminate`, not
  `Unspecified`. An older server that never sent one has not established that
  the source lacked access tags — it has only failed to say. `Unspecified` is a
  claim about a source, and a client must not make it on a server's behalf.
- Switching profile in Studio stays a local recomputation: three overlay filter
  swaps beside the existing arrow filter and rotation swap. No request, no
  source update, no geometry change, and the selected road stays selected.
- The overlay collapses nineteen rules into four drawing categories, because
  four is about as many as a reader can hold at once on a map that is already
  coloured by road class. The collapse is presentation only; the inspector
  always shows the exact rule, in words, for all three profiles.
- `AgriculturalOnly`, `ForestryOnly` and `MilitaryOnly` are recorded faithfully
  and consumed by nothing yet, like `Reversible` and `Alternating` before them.
