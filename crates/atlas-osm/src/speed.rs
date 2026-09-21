//! Turning OSM `maxspeed` tags into Atlas speed-limit facts.
//!
//! This is where OSM's speed vocabulary stops. Everything above this module
//! sees [`RoadSpeedLimits`]: six Atlas facts, one per modelled mode per
//! geometry direction, with no tag map and no OSM key names in sight.
//!
//! What this module does *not* do is as important as what it does.
//!
//! * It never answers how fast anybody travels. `maxspeed` is a **legal
//!   maximum**, not an expected speed and not a routing cost. A road signed at
//!   50 may be crawling and a road with no limit may be empty.
//! * It never looks at [`atlas_kernel::RoadClass`], at a country, at a locale
//!   or at configuration. A residential street is not tagged with its
//!   country's urban default; it simply has one, and encoding that here would
//!   turn a legal default into a source fact that nothing downstream could
//!   tell apart from a surveyed sign. The signature is the proof:
//!   [`derive_speed_limits`] is given tags and nothing else.
//! * It never converts a unit. `30 mph` stays thirty miles per hour all the
//!   way to the wire. A routing layer may convert when it knows what it wants
//!   the number for; a conversion here would replace what the source said with
//!   an arithmetic result carrying a rounding error.
//! * It never reads a conditional expression, and never resolves an implicit
//!   country code to a number.
//!
//! Three rules shape the derivation, and the first two mirror the access and
//! direction modules deliberately:
//!
//! * **Specificity wins, and an unreadable specific value never falls back.**
//!   A way that says `maxspeed:motorcar=maybe` meant to say something about
//!   motorcars; quietly using the broader `maxspeed` instead would be Atlas
//!   inventing an answer the source never gave.
//! * **An absence is [`SpeedLimitValue::Unspecified`], never a number.**
//!   Silence is not a limit, and it is certainly not the country default.
//! * **Mode specificity precedes direction specificity.** This is OSM's own
//!   conflict order, and it is why `maxspeed:motorcar` out-ranks
//!   `maxspeed:forward` for a motorcar travelling forwards.
//!
//! The source semantics are documented at
//! <https://wiki.openstreetmap.org/wiki/Key:maxspeed>,
//! <https://wiki.openstreetmap.org/wiki/Key:maxspeed:conditional>,
//! <https://wiki.openstreetmap.org/wiki/Key:maxspeed:variable> and
//! <https://wiki.openstreetmap.org/wiki/Map_features/Units>.

use atlas_engine::IssueCode;
use atlas_kernel::{
    ConditionalSpeedLimit, DirectionalSpeedLimits, ImplicitSpeedCode, RoadSpeedLimits, Speed,
    SpeedDirection, SpeedLimitFact, SpeedLimitValue, SpeedUnit, TravelMode, VariableSpeedLimit,
};

use crate::model::OsmTags;

/// The general key, and the root every other key is built from.
const MAXSPEED: &str = "maxspeed";

/// The mode qualifiers, from broadest to narrowest.
///
/// `None` is the unqualified key. Each mode's chain is built from a slice of
/// these, so the precedence order is data rather than eighteen string
/// constants that could drift apart.
const VEHICLE: &str = "vehicle";
const MOTOR_VEHICLE: &str = "motor_vehicle";
const MOTORCAR: &str = "motorcar";
const BICYCLE: &str = "bicycle";
const FOOT: &str = "foot";

/// The mode qualifiers that apply to a motorcar, most specific first.
const MOTORCAR_QUALIFIERS: [Option<&str>; 4] =
    [Some(MOTORCAR), Some(MOTOR_VEHICLE), Some(VEHICLE), None];
/// A bicycle is a vehicle but not a motor vehicle, so that level is simply
/// absent rather than skipped at runtime.
const BICYCLE_QUALIFIERS: [Option<&str>; 3] = [Some(BICYCLE), Some(VEHICLE), None];
/// A pedestrian is not a vehicle, so no vehicle key reaches them.
const FOOT_QUALIFIERS: [Option<&str>; 2] = [Some(FOOT), None];

/// The direction suffixes, in the source's own spelling.
const FORWARD: &str = "forward";
const BACKWARD: &str = "backward";

/// The `maxspeed:variable` keys Atlas supports.
const VARIABLE: &str = "maxspeed:variable";
const VARIABLE_FORWARD: &str = "maxspeed:variable:forward";
const VARIABLE_BACKWARD: &str = "maxspeed:variable:backward";

/// The reasons `maxspeed:variable` documents for a varying limit.
const VARIABLE_REASONS: [&str; 6] = [
    "peak_traffic",
    "weather",
    "environment",
    "school_zone",
    "obstruction",
    "border_control",
];

/// Builds one static key: `maxspeed[:<qualifier>][:<direction>]`.
fn static_key(qualifier: Option<&str>, direction: Option<SpeedDirection>) -> String {
    let mut key = String::from(MAXSPEED);
    if let Some(qualifier) = qualifier {
        key.push(':');
        key.push_str(qualifier);
    }
    if let Some(direction) = direction {
        key.push(':');
        key.push_str(match direction {
            SpeedDirection::Forward => FORWARD,
            SpeedDirection::Backward => BACKWARD,
        });
    }
    key
}

/// Builds the conditional sibling of a static key.
fn conditional_key(qualifier: Option<&str>, direction: Option<SpeedDirection>) -> String {
    format!("{}:conditional", static_key(qualifier, direction))
}

/// The mode qualifiers that reach one mode, most specific first.
fn qualifiers_for(mode: TravelMode) -> &'static [Option<&'static str>] {
    match mode {
        TravelMode::Motorcar => &MOTORCAR_QUALIFIERS,
        TravelMode::Bicycle => &BICYCLE_QUALIFIERS,
        TravelMode::Foot => &FOOT_QUALIFIERS,
    }
}

/// One mode's precedence chain for one geometry direction, most specific first.
///
/// Each entry is one scope: its static key and the conditional sibling at the
/// same scope. The order is OSM's own conflict order — **mode specificity
/// first, direction specificity second** — which is why a mode-specific
/// non-directional key out-ranks a broader directional one. For a motorcar
/// travelling forwards it spells out, in order:
///
/// ```text
/// maxspeed:motorcar:forward
/// maxspeed:motorcar
/// maxspeed:motor_vehicle:forward
/// maxspeed:motor_vehicle
/// maxspeed:vehicle:forward
/// maxspeed:vehicle
/// maxspeed:forward
/// maxspeed
/// ```
fn chain(mode: TravelMode, direction: SpeedDirection) -> Vec<Scope> {
    qualifiers_for(mode)
        .iter()
        .flat_map(|qualifier| {
            // Within one mode level the directional key is the more specific
            // of the two, so it comes first.
            [Some(direction), None].map(|suffix| Scope {
                static_key: static_key(*qualifier, suffix),
                conditional_key: conditional_key(*qualifier, suffix),
            })
        })
        .collect()
}

/// One step of a precedence chain: a static key and its conditional sibling.
struct Scope {
    static_key: String,
    conditional_key: String,
}

/// Every static key the diagnostic scan reads a value from.
///
/// The union of all three modes' chains, in a stable order. The scan walks
/// this list; precedence walks the per-mode chains. The two are separate on
/// purpose — see [`scan_static_tags`].
fn valued_static_keys() -> Vec<String> {
    let mut keys = Vec::new();
    for qualifier in [
        None,
        Some(VEHICLE),
        Some(MOTOR_VEHICLE),
        Some(MOTORCAR),
        Some(BICYCLE),
        Some(FOOT),
    ] {
        for direction in [
            None,
            Some(SpeedDirection::Forward),
            Some(SpeedDirection::Backward),
        ] {
            keys.push(static_key(qualifier, direction));
        }
    }
    keys
}

/// One raw static `maxspeed` value, read.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StaticValue {
    /// A value Atlas recognises, and the limit it states.
    Read(SpeedLimitValue),
    /// A syntactically valid magnitude followed by a unit Atlas does not
    /// support, for example `50 furlongs`.
    ///
    /// Kept apart from [`StaticValue::Unknown`] because the two are different
    /// findings: this one says the number is fine and Atlas is short a unit,
    /// which is a far more actionable report than "we could not read it".
    UnsupportedUnit,
    /// A value Atlas cannot read at all, including a blank one.
    Unknown,
}

impl StaticValue {
    /// The Atlas limit this value states.
    ///
    /// Both error classes reach [`SpeedLimitValue::Indeterminate`], by
    /// different routes. Keeping the routes apart is what lets the diagnostics
    /// say which of the two happened.
    fn limit(self) -> SpeedLimitValue {
        match self {
            StaticValue::Read(limit) => limit,
            StaticValue::UnsupportedUnit | StaticValue::Unknown => SpeedLimitValue::Indeterminate,
        }
    }

    /// Reads one raw value.
    ///
    /// Surrounding whitespace is trimmed and keywords and units are matched
    /// without ASCII case sensitivity, so `" 50 KM/H "` and `50 km/h` are the
    /// same thing. Nothing else about the text is forgiven.
    fn parse(raw: &str) -> Self {
        let value = raw.trim();
        if value.is_empty() {
            // `<tag k="maxspeed"/>` arrives here as a blank value, exactly as
            // `<tag k="maxspeed" v=""/>` does. Both are a mapper's statement
            // Atlas cannot read — not the absence of one.
            return StaticValue::Unknown;
        }

        if value.eq_ignore_ascii_case("none") {
            // Knowledge, not the lack of it: somebody recorded that no number
            // applies.
            return StaticValue::Read(SpeedLimitValue::NoFixedLimit);
        }
        if value.eq_ignore_ascii_case("walk") {
            // Kept as a named fact. Walking pace is not 5 km/h in law, and
            // inventing a figure would put Atlas's guess where a legal limit
            // belongs.
            return StaticValue::Read(SpeedLimitValue::WalkingPace);
        }

        // An implicit code is the one value shaped like `COUNTRY:context`, so
        // the colon decides which grammar to try. `maxspeed=unknown` and the
        // deprecated `maxspeed=signals` reach neither and fall through to
        // `Unknown`, which is what earns them their warning.
        if value.contains(':') {
            return match ImplicitSpeedCode::new(value) {
                Ok(code) => StaticValue::Read(SpeedLimitValue::Implicit(code)),
                Err(_) => StaticValue::Unknown,
            };
        }

        Self::parse_numeric(value)
    }

    /// Reads a magnitude with an optional unit.
    ///
    /// A unitless value means km/h, as the source's units page says. Anything
    /// after the first whitespace run is the unit text; if the magnitude reads
    /// and the unit does not, that is an unsupported unit rather than an
    /// unreadable value.
    fn parse_numeric(value: &str) -> Self {
        let (magnitude, unit_text) = match value.split_once(char::is_whitespace) {
            Some((magnitude, rest)) => (magnitude, rest.trim()),
            None => (value, ""),
        };

        let Some(unit) = parse_unit(unit_text) else {
            // The magnitude decides which of the two findings this is.
            return if Speed::new(magnitude, SpeedUnit::KilometresPerHour).is_ok() {
                StaticValue::UnsupportedUnit
            } else {
                StaticValue::Unknown
            };
        };

        match Speed::new(magnitude, unit) {
            Ok(speed) => StaticValue::Read(SpeedLimitValue::Numeric(speed)),
            Err(_) => StaticValue::Unknown,
        }
    }
}

/// Reads a unit token, or `None` if it is not one Atlas supports.
///
/// An empty token means the value was unitless, which the source documents as
/// km/h. The three discouraged aliases are accepted and canonicalised to
/// `km/h`, because they are documented spellings of a unit Atlas already has,
/// not a unit of their own.
fn parse_unit(text: &str) -> Option<SpeedUnit> {
    let is = |candidate: &str| text.eq_ignore_ascii_case(candidate);
    if text.is_empty() || is("km/h") || is("kph") || is("kmh") || is("kmph") {
        Some(SpeedUnit::KilometresPerHour)
    } else if is("mph") {
        Some(SpeedUnit::MilesPerHour)
    } else if is("knots") {
        Some(SpeedUnit::Knots)
    } else {
        None
    }
}

/// Reads one `maxspeed:variable` value.
fn parse_variable(raw: &str) -> VariableSpeedLimit {
    let value = raw.trim();
    if value.eq_ignore_ascii_case("no") {
        return VariableSpeedLimit::Fixed;
    }
    if value.eq_ignore_ascii_case("yes") {
        return VariableSpeedLimit::Variable;
    }
    // A semicolon-separated list of documented reasons is a `yes` that says
    // why. One unrecognised entry makes the whole list unreadable rather than
    // partially believed — including the deprecated `signals`, which the
    // source replaced with this very key and which Atlas refuses to translate
    // silently.
    if !value.is_empty()
        && value.split(';').all(|reason| {
            let reason = reason.trim();
            VARIABLE_REASONS
                .iter()
                .any(|documented| reason.eq_ignore_ascii_case(documented))
        })
    {
        return VariableSpeedLimit::Variable;
    }
    VariableSpeedLimit::Indeterminate
}

/// Which warnings one way's speed tags earned.
///
/// Flags rather than a list: each problem is reported once per way, however
/// many tags contributed to it, so the counts stay counts of roads.
///
/// The four flags are raised by three passes, and the split is the point:
///
/// * `unknown_value` and `unsupported_unit` come from [`scan_static_tags`],
///   which reads every supported static key the way carries **regardless of
///   precedence**. They are findings about the *source data*: a broken
///   `maxspeed=bogus` is broken whether or not a more specific tag out-ranks
///   it, and a diagnostic that went quiet the moment something shadowed the
///   mistake would hide exactly the mistakes a mapper most needs to find.
/// * `unknown_variable_value` comes from the same kind of scan over the three
///   variable keys, for the same reason.
/// * `unsupported_conditional` comes from the precedence walk, and is raised
///   only when a conditional key is actually selected for some fact. That one
///   is not a finding about the file at all — the tag is perfectly valid — it
///   is a statement about a limitation of Atlas, and Atlas is only limited by
///   a condition that reaches an answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SpeedIssues {
    unknown_value: bool,
    unsupported_unit: bool,
    unsupported_conditional: bool,
    unknown_variable_value: bool,
}

impl SpeedIssues {
    /// The codes to record, in a fixed order.
    pub(crate) fn codes(self) -> impl Iterator<Item = IssueCode> {
        [
            self.unknown_value
                .then_some(IssueCode::UnknownMaxspeedValue),
            self.unsupported_unit
                .then_some(IssueCode::UnsupportedMaxspeedUnit),
            self.unsupported_conditional
                .then_some(IssueCode::UnsupportedConditionalMaxspeed),
            self.unknown_variable_value
                .then_some(IssueCode::UnknownVariableMaxspeedValue),
        ]
        .into_iter()
        .flatten()
    }
}

/// Derives the speed-limit facts of one way for every mode and direction.
///
/// Takes tags and nothing else. There is deliberately no `class` parameter, no
/// traversal, no access, no geometry, no country and no configuration: a speed
/// that Atlas did not read from a speed tag is a speed Atlas did not read. The
/// signature is the proof that no road-class or country default can have crept
/// in.
pub(crate) fn derive_speed_limits(tags: &OsmTags) -> (RoadSpeedLimits, SpeedIssues) {
    // Three passes, two concerns. The scans report what is wrong with the
    // source; the chains decide what the source says. Neither can change the
    // other's answer: a shadowed mistake is still reported, and reporting it
    // never moves a derived value.
    let mut issues = scan_static_tags(tags);
    issues.unknown_variable_value = scan_variable_tags(tags);

    let variable = DirectionalVariability::derive(tags);

    let mut directional = |mode| {
        let mut fact = |direction| {
            let (limit, conditional) = resolve(tags, mode, direction, &mut issues);
            SpeedLimitFact::new(limit, conditional, variable.of(direction))
        };
        DirectionalSpeedLimits::new(
            fact(SpeedDirection::Forward),
            fact(SpeedDirection::Backward),
        )
    };

    let motorcar = directional(TravelMode::Motorcar);
    let bicycle = directional(TravelMode::Bicycle);
    let foot = directional(TravelMode::Foot);

    (RoadSpeedLimits::new(motorcar, bicycle, foot), issues)
}

/// Reports what is wrong with a way's static `maxspeed` tags, precedence aside.
///
/// Walks every key in [`valued_static_keys`] that the way carries and asks one
/// question of each: could Atlas read the value, and if not, was the magnitude
/// at least sound? Both are properties of the tag itself, so neither depends
/// on which tag precedence went on to choose.
///
/// This deliberately does not look at the conditional keys. Their values are
/// never read, so there is nothing about them to find wrong.
fn scan_static_tags(tags: &OsmTags) -> SpeedIssues {
    let mut issues = SpeedIssues::default();

    for key in valued_static_keys() {
        let Some(raw) = tags.get(&key) else { continue };
        match StaticValue::parse(raw) {
            StaticValue::Unknown => issues.unknown_value = true,
            StaticValue::UnsupportedUnit => issues.unsupported_unit = true,
            StaticValue::Read(_) => {}
        }
    }

    issues
}

/// Reports whether any of the three variable keys carries an unreadable value.
///
/// Same discipline as the static scan: all three keys are read regardless of
/// which one precedence selects, so a shadowed malformed variable tag stays
/// visible.
fn scan_variable_tags(tags: &OsmTags) -> bool {
    [VARIABLE, VARIABLE_FORWARD, VARIABLE_BACKWARD]
        .iter()
        .filter_map(|key| tags.get(key))
        .any(|raw| parse_variable(raw) == VariableSpeedLimit::Indeterminate)
}

/// The variability the source declares, per geometry direction.
struct DirectionalVariability {
    forward: VariableSpeedLimit,
    backward: VariableSpeedLimit,
}

impl DirectionalVariability {
    /// Resolves the three variable keys into one answer per direction.
    ///
    /// The direction-specific key overrides the general one, and a
    /// present-but-unreadable specific value does **not** fall back — the same
    /// rule the static chains follow, for the same reason.
    ///
    /// There are no mode-specific variable keys in the source, so the answer
    /// applies to every modelled mode. That is a statement about the sign, not
    /// a claim that every traveller obeys it.
    fn derive(tags: &OsmTags) -> Self {
        let general = tags.get(VARIABLE).map(parse_variable);
        let resolve = |specific: &str| {
            tags.get(specific)
                .map(parse_variable)
                .or(general)
                .unwrap_or(VariableSpeedLimit::NotTagged)
        };
        Self {
            forward: resolve(VARIABLE_FORWARD),
            backward: resolve(VARIABLE_BACKWARD),
        }
    }

    fn of(&self, direction: SpeedDirection) -> VariableSpeedLimit {
        match direction {
            SpeedDirection::Forward => self.forward,
            SpeedDirection::Backward => self.backward,
        }
    }
}

/// Walks one mode's chain for one direction and reads the winning scope.
///
/// Two answers come out of one walk, because they are decided by the same
/// precedence order.
///
/// **The ordinary limit** is the first static key the way carries. Stopping
/// there is the whole point: once an applicable key has been found, no broader
/// key is consulted — not even when the value found was one Atlas could not
/// use. Falling through to a broader tag after an unreadable specific one
/// would replace a mapper's explicit statement about this mode with a
/// statement they made about something else.
///
/// **The conditional modifier** is present when the way carries a conditional
/// key at a scope at least as specific as the winning static one. That is
/// OSM's conflict order applied faithfully: mode specificity, then direction
/// specificity, then conditional over static *at the same scope* — which is
/// why a conditional at the winning scope counts and one below it does not. A
/// conditional that is out-ranked for every fact shaped nothing, so it
/// produces neither a modifier nor a warning.
fn resolve(
    tags: &OsmTags,
    mode: TravelMode,
    direction: SpeedDirection,
    issues: &mut SpeedIssues,
) -> (SpeedLimitValue, ConditionalSpeedLimit) {
    let chain = chain(mode, direction);

    // Where precedence stops for the static value. A chain with no applicable
    // static key at all stops past the end, so any conditional anywhere in the
    // chain is at least as specific as "nothing".
    let winning = chain
        .iter()
        .position(|scope| tags.get(&scope.static_key).is_some())
        .unwrap_or(chain.len());

    let limit = chain
        .get(winning)
        .and_then(|scope| tags.get(&scope.static_key))
        .map_or(SpeedLimitValue::Unspecified, |raw| {
            StaticValue::parse(raw).limit()
        });

    let conditional = if chain
        .iter()
        .take(winning + 1)
        .any(|scope| tags.get(&scope.conditional_key).is_some())
    {
        // Detection is by key. The expression is never read, so a blank or
        // unparseable one changes nothing: Atlas already knows all it is
        // willing to claim.
        issues.unsupported_conditional = true;
        ConditionalSpeedLimit::Present
    } else {
        ConditionalSpeedLimit::NotTagged
    };

    (limit, conditional)
}

#[cfg(test)]
mod tests {
    use super::*;

    use ConditionalSpeedLimit::{NotTagged as NoCondition, Present};
    use SpeedLimitValue::{Indeterminate, NoFixedLimit, Unspecified, WalkingPace};
    use SpeedUnit::{KilometresPerHour, Knots, MilesPerHour};
    use VariableSpeedLimit::{
        Fixed, Indeterminate as VariableIndeterminate, NotTagged as NoVariability,
        Variable as Varies,
    };

    const A_CONDITION: &str = "60 @ wet";

    fn tags(pairs: &[(&str, &str)]) -> OsmTags {
        let mut tags = OsmTags::default();
        for (key, value) in pairs {
            tags.insert((*key).to_owned(), (*value).to_owned());
        }
        tags
    }

    fn derive(pairs: &[(&str, &str)]) -> (RoadSpeedLimits, SpeedIssues) {
        derive_speed_limits(&tags(pairs))
    }

    fn limits(pairs: &[(&str, &str)]) -> RoadSpeedLimits {
        derive(pairs).0
    }

    fn codes(pairs: &[(&str, &str)]) -> Vec<IssueCode> {
        derive(pairs).1.codes().collect()
    }

    /// An exact numeric limit, for readable expectations.
    fn numeric(magnitude: &str, unit: SpeedUnit) -> SpeedLimitValue {
        SpeedLimitValue::Numeric(Speed::new(magnitude, unit).expect("a valid magnitude"))
    }

    fn kmh(magnitude: &str) -> SpeedLimitValue {
        numeric(magnitude, KilometresPerHour)
    }

    fn implicit(code: &str) -> SpeedLimitValue {
        SpeedLimitValue::Implicit(ImplicitSpeedCode::new(code).expect("a documented code"))
    }

    /// The ordinary limit of one mode in one direction.
    fn limit(
        derived: &RoadSpeedLimits,
        mode: TravelMode,
        direction: SpeedDirection,
    ) -> SpeedLimitValue {
        derived.fact(mode, direction).limit().clone()
    }

    /// All six ordinary limits, as
    /// `[car fwd, car bwd, bike fwd, bike bwd, foot fwd, foot bwd]`.
    fn six(pairs: &[(&str, &str)]) -> [SpeedLimitValue; 6] {
        let derived = limits(pairs);
        [
            (TravelMode::Motorcar, SpeedDirection::Forward),
            (TravelMode::Motorcar, SpeedDirection::Backward),
            (TravelMode::Bicycle, SpeedDirection::Forward),
            (TravelMode::Bicycle, SpeedDirection::Backward),
            (TravelMode::Foot, SpeedDirection::Forward),
            (TravelMode::Foot, SpeedDirection::Backward),
        ]
        .map(|(mode, direction)| limit(&derived, mode, direction))
    }

    /// All six conditional modifiers, in the same order as [`six`].
    fn six_conditionals(pairs: &[(&str, &str)]) -> [ConditionalSpeedLimit; 6] {
        let derived = limits(pairs);
        let mut index = 0;
        [(); 6].map(|()| {
            let (mode, direction) = [
                (TravelMode::Motorcar, SpeedDirection::Forward),
                (TravelMode::Motorcar, SpeedDirection::Backward),
                (TravelMode::Bicycle, SpeedDirection::Forward),
                (TravelMode::Bicycle, SpeedDirection::Backward),
                (TravelMode::Foot, SpeedDirection::Forward),
                (TravelMode::Foot, SpeedDirection::Backward),
            ][index];
            index += 1;
            derived.fact(mode, direction).conditional()
        })
    }

    fn uniform(value: SpeedLimitValue) -> [SpeedLimitValue; 6] {
        [
            value.clone(),
            value.clone(),
            value.clone(),
            value.clone(),
            value.clone(),
            value,
        ]
    }

    // -- the value table ----------------------------------------------------

    #[test]
    fn a_unitless_number_means_kilometres_per_hour() {
        assert_eq!(six(&[("maxspeed", "50")]), uniform(kmh("50")));
        assert_eq!(six(&[("maxspeed", "0")]), uniform(kmh("0")));
        assert_eq!(six(&[("maxspeed", "7.5")]), uniform(kmh("7.5")));
        assert!(codes(&[("maxspeed", "50")]).is_empty());
    }

    #[test]
    fn every_canonical_unit_is_read_and_preserved() {
        assert_eq!(six(&[("maxspeed", "50 km/h")]), uniform(kmh("50")));
        assert_eq!(
            six(&[("maxspeed", "30 mph")]),
            uniform(numeric("30", MilesPerHour))
        );
        assert_eq!(
            six(&[("maxspeed", "10 knots")]),
            uniform(numeric("10", Knots))
        );
        for value in ["50 km/h", "30 mph", "10 knots"] {
            assert!(codes(&[("maxspeed", value)]).is_empty(), "{value}");
        }
    }

    #[test]
    fn the_documented_discouraged_aliases_canonicalise_to_km_per_hour() {
        // `kph`, `kmh` and `kmph` are documented spellings of a unit Atlas
        // already has, not units of their own. They are read and canonicalised;
        // nothing about the magnitude changes.
        for alias in ["kph", "kmh", "kmph", "KPH", "KmH"] {
            let value = format!("50 {alias}");
            assert_eq!(six(&[("maxspeed", &value)]), uniform(kmh("50")), "{alias}");
            assert!(codes(&[("maxspeed", &value)]).is_empty(), "{alias}");
        }
    }

    #[test]
    fn units_are_never_converted() {
        // Thirty miles per hour is not 48.28 km/h here or anywhere downstream.
        let derived = limits(&[("maxspeed", "30 mph")]);
        let fact = derived.fact(TravelMode::Motorcar, SpeedDirection::Forward);
        let speed = fact.limit().speed().expect("a numeric limit");
        assert_eq!(speed.magnitude(), "30");
        assert_eq!(speed.unit(), MilesPerHour);
        assert_ne!(
            limit(&derived, TravelMode::Motorcar, SpeedDirection::Forward),
            kmh("30")
        );
    }

    #[test]
    fn magnitudes_are_canonicalised_without_rounding() {
        assert_eq!(six(&[("maxspeed", "050.500")]), uniform(kmh("50.5")));
        assert_eq!(six(&[("maxspeed", "0.0")]), uniform(kmh("0")));
        assert_eq!(
            six(&[("maxspeed", "30.0 mph")]),
            uniform(numeric("30", MilesPerHour))
        );
        for value in ["050.500", "0.0", "30.0 mph"] {
            assert!(codes(&[("maxspeed", value)]).is_empty(), "{value}");
        }
    }

    #[test]
    fn malformed_decimal_forms_are_unknown_values_not_guesses() {
        for value in [
            "-50", "+50", "5e1", "50,5", "1,000", "50.5.5", "fifty", "50kmh", "50;60", "50-60",
        ] {
            assert_eq!(
                six(&[("maxspeed", value)]),
                uniform(Indeterminate),
                "{value} should be indeterminate"
            );
            assert_eq!(
                codes(&[("maxspeed", value)]),
                vec![IssueCode::UnknownMaxspeedValue],
                "{value} should warn once"
            );
        }
    }

    #[test]
    fn the_keyword_values_are_facts_rather_than_numbers() {
        assert_eq!(six(&[("maxspeed", "none")]), uniform(NoFixedLimit));
        assert_eq!(six(&[("maxspeed", "walk")]), uniform(WalkingPace));
        // `none` is knowledge, not the lack of it, and `walk` is never turned
        // into a guessed figure.
        assert!(codes(&[("maxspeed", "none")]).is_empty());
        assert!(codes(&[("maxspeed", "walk")]).is_empty());
        assert_ne!(NoFixedLimit, Indeterminate);
        assert_ne!(NoFixedLimit, Unspecified);
    }

    #[test]
    fn implicit_codes_are_preserved_and_never_resolved_to_a_number() {
        for code in [
            "RO:urban",
            "GB:nsl_single",
            "GB-WLS:nsl_restricted",
            "DE:rural",
            "AT:motorway",
        ] {
            assert_eq!(
                six(&[("maxspeed", code)]),
                uniform(implicit(code)),
                "{code}"
            );
            assert!(codes(&[("maxspeed", code)]).is_empty(), "{code}");
            // Nothing turned the code into a magnitude.
            assert_eq!(
                limits(&[("maxspeed", code)])
                    .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                    .limit()
                    .speed(),
                None
            );
        }
        // Case is normalised; meaning is not touched.
        assert_eq!(
            six(&[("maxspeed", "ro:URBAN")]),
            uniform(implicit("RO:urban"))
        );
    }

    #[test]
    fn a_multi_segment_implicit_code_is_read_and_never_warns() {
        // The source documents implicit values whose context narrows more than
        // once. They are valid facts, so they derive as `Implicit` and earn no
        // diagnostic — the adapter must not call a correct value unreadable.
        for code in [
            "AR:urban:primary",
            "DE:zone:30",
            "GB-WLS:nsl_restricted:single",
        ] {
            assert_eq!(
                six(&[("maxspeed", code)]),
                uniform(implicit(code)),
                "{code}"
            );
            assert!(
                codes(&[("maxspeed", code)]).is_empty(),
                "{code} must not warn"
            );
            // Still no number invented from the rule the code names.
            assert_eq!(
                limits(&[("maxspeed", code)])
                    .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                    .limit()
                    .speed(),
                None
            );
        }
        // Case is normalised across every component; meaning is not touched.
        assert_eq!(
            six(&[("maxspeed", "ar:URBAN:Primary")]),
            uniform(implicit("AR:urban:primary"))
        );
        // A multi-segment code resolves through the chains like any other
        // value, and blocks fallback when it is the winning key.
        assert_eq!(
            six(&[("maxspeed", "50"), ("maxspeed:motorcar", "DE:zone:30")]),
            [
                implicit("DE:zone:30"),
                implicit("DE:zone:30"),
                kmh("50"),
                kmh("50"),
                kmh("50"),
                kmh("50"),
            ]
        );
    }

    #[test]
    fn a_malformed_implicit_code_is_an_unknown_value() {
        // `RO:urban:extra` is a valid multi-segment code and is covered by the
        // accepting test above; an empty component is the malformed shape.
        for value in [
            "R:urban",
            "RO:",
            "ROU:urban",
            "12:34",
            "RO::urban",
            "RO:urban:",
            "RO:urban::extra",
        ] {
            assert_eq!(
                six(&[("maxspeed", value)]),
                uniform(Indeterminate),
                "{value}"
            );
            assert_eq!(
                codes(&[("maxspeed", value)]),
                vec![IssueCode::UnknownMaxspeedValue],
                "{value}"
            );
        }
    }

    #[test]
    fn a_known_magnitude_in_an_unknown_unit_is_a_unit_problem_not_a_value_problem() {
        // The two findings are kept apart because "we are short a unit" is a
        // far more actionable report than "we could not read it".
        assert_eq!(six(&[("maxspeed", "50 furlongs")]), uniform(Indeterminate));
        assert_eq!(
            codes(&[("maxspeed", "50 furlongs")]),
            vec![IssueCode::UnsupportedMaxspeedUnit]
        );
        assert_eq!(
            codes(&[("maxspeed", "50 m/s")]),
            vec![IssueCode::UnsupportedMaxspeedUnit]
        );
        // A bad magnitude with a bad unit is an unknown value: there is no
        // sound number to report a missing unit for.
        assert_eq!(
            codes(&[("maxspeed", "fast furlongs")]),
            vec![IssueCode::UnknownMaxspeedValue]
        );
    }

    #[test]
    fn values_are_trimmed_and_matched_without_ascii_case() {
        for value in [" 50 ", "50", "\t50\n"] {
            assert_eq!(six(&[("maxspeed", value)]), uniform(kmh("50")), "{value:?}");
        }
        for value in ["NONE", "None", " none "] {
            assert_eq!(
                six(&[("maxspeed", value)]),
                uniform(NoFixedLimit),
                "{value}"
            );
        }
        for value in ["WALK", "Walk"] {
            assert_eq!(six(&[("maxspeed", value)]), uniform(WalkingPace), "{value}");
        }
        assert_eq!(
            six(&[("maxspeed", "30 MPH")]),
            uniform(numeric("30", MilesPerHour))
        );
        assert_eq!(six(&[("maxspeed", "50 KM/H")]), uniform(kmh("50")));
    }

    #[test]
    fn a_blank_value_is_indeterminate_and_warns() {
        // `<tag k="maxspeed"/>` reaches the adapter as an empty value through
        // the XML boundary, exactly as `<tag k="maxspeed" v=""/>` does. Both
        // are a statement Atlas cannot read, not the absence of one.
        for value in ["", " ", "\t"] {
            assert_eq!(
                six(&[("maxspeed", value)]),
                uniform(Indeterminate),
                "{value:?}"
            );
            assert_eq!(
                codes(&[("maxspeed", value)]),
                vec![IssueCode::UnknownMaxspeedValue],
                "{value:?}"
            );
        }
        // And an empty value is emphatically not silence.
        assert_ne!(six(&[("maxspeed", "")]), uniform(Unspecified));
    }

    #[test]
    fn a_road_with_no_speed_tags_says_nothing_at_all() {
        assert_eq!(six(&[]), uniform(Unspecified));
        assert_eq!(six(&[("highway", "residential")]), uniform(Unspecified));
        assert!(codes(&[("highway", "residential")]).is_empty());
        assert_eq!(limits(&[]), RoadSpeedLimits::unspecified());
    }

    // -- precedence ---------------------------------------------------------

    #[test]
    fn a_directional_key_beats_the_general_one_for_its_own_direction() {
        assert_eq!(
            six(&[
                ("maxspeed", "50"),
                ("maxspeed:forward", "60"),
                ("maxspeed:backward", "40"),
            ]),
            [
                kmh("60"),
                kmh("40"),
                kmh("60"),
                kmh("40"),
                kmh("60"),
                kmh("40")
            ]
        );
    }

    #[test]
    fn mode_specificity_precedes_direction_specificity() {
        // The rule this whole ordering exists for. `maxspeed:vehicle` is a
        // mode-specific non-directional key and out-ranks the broader
        // `maxspeed:forward` for every vehicle, because OSM resolves mode
        // conflicts before direction conflicts.
        let pairs = [
            ("maxspeed", "50"),
            ("maxspeed:forward", "60"),
            ("maxspeed:vehicle", "45"),
            ("maxspeed:vehicle:forward", "55"),
            ("maxspeed:motorcar", "35"),
        ];
        assert_eq!(
            six(&pairs),
            [
                // Motorcar stops at its own non-directional key, above every
                // vehicle and generic key, directional or not.
                kmh("35"),
                kmh("35"),
                // A bicycle is a vehicle: forward takes the directional
                // vehicle key, backward the plain one.
                kmh("55"),
                kmh("45"),
                // A pedestrian reaches neither vehicle key.
                kmh("60"),
                kmh("50"),
            ]
        );
    }

    #[test]
    fn the_full_motorcar_chain_is_walked_in_order() {
        // Peel the chain one level at a time; each removal must fall through
        // to exactly the next key and no further.
        let all = [
            ("maxspeed:motorcar:forward", "10"),
            ("maxspeed:motorcar", "20"),
            ("maxspeed:motor_vehicle:forward", "30"),
            ("maxspeed:motor_vehicle", "40"),
            ("maxspeed:vehicle:forward", "50"),
            ("maxspeed:vehicle", "60"),
            ("maxspeed:forward", "70"),
            ("maxspeed", "80"),
        ];
        for skip in 0..all.len() {
            let pairs = &all[skip..];
            let derived = limits(pairs);
            assert_eq!(
                limit(&derived, TravelMode::Motorcar, SpeedDirection::Forward),
                kmh(pairs[0].1),
                "with {} keys the winner should be {}",
                pairs.len(),
                pairs[0].0
            );
        }
    }

    #[test]
    fn the_bicycle_chain_never_sees_a_motor_vehicle_key() {
        let pairs = [
            ("maxspeed", "80"),
            ("maxspeed:motor_vehicle", "40"),
            ("maxspeed:motorcar", "20"),
        ];
        assert_eq!(
            six(&pairs),
            [
                kmh("20"),
                kmh("20"),
                // A bicycle is not a motor vehicle, so both of those keys are
                // simply absent from its chain.
                kmh("80"),
                kmh("80"),
                kmh("80"),
                kmh("80"),
            ]
        );
    }

    #[test]
    fn the_foot_chain_never_sees_a_vehicle_key() {
        let pairs = [("maxspeed", "80"), ("maxspeed:vehicle", "40")];
        assert_eq!(
            six(&pairs),
            [
                kmh("40"),
                kmh("40"),
                kmh("40"),
                kmh("40"),
                kmh("80"),
                kmh("80"),
            ]
        );
    }

    #[test]
    fn an_unreadable_specific_value_never_falls_back_to_a_broader_key() {
        // A mapper who wrote `maxspeed:motorcar` meant to say something about
        // motorcars. Quietly using the general 50 instead would replace their
        // statement with one they made about something else.
        assert_eq!(
            six(&[("maxspeed", "50"), ("maxspeed:motorcar", "maybe")]),
            [
                Indeterminate,
                Indeterminate,
                kmh("50"),
                kmh("50"),
                kmh("50"),
                kmh("50"),
            ]
        );
        // The same for a directional key, which blocks only its own direction.
        assert_eq!(
            six(&[("maxspeed", "50"), ("maxspeed:forward", "fast")]),
            [
                Indeterminate,
                kmh("50"),
                Indeterminate,
                kmh("50"),
                Indeterminate,
                kmh("50"),
            ]
        );
        // And for a blank specific value, which is a statement too.
        assert_eq!(
            six(&[("maxspeed", "50"), ("maxspeed:bicycle", "")]),
            [
                kmh("50"),
                kmh("50"),
                Indeterminate,
                Indeterminate,
                kmh("50"),
                kmh("50"),
            ]
        );
    }

    // -- static diagnostics -------------------------------------------------

    #[test]
    fn a_shadowed_malformed_value_is_still_reported() {
        // Precedence decides the value; the scan describes the source. A
        // diagnostic that went quiet the moment something shadowed the mistake
        // would hide exactly the mistakes a mapper most needs to find.
        let pairs = [
            ("maxspeed", "bogus"),
            ("maxspeed:motorcar", "30"),
            ("maxspeed:bicycle", "20"),
            ("maxspeed:foot", "walk"),
        ];
        assert_eq!(
            six(&pairs),
            [
                kmh("30"),
                kmh("30"),
                kmh("20"),
                kmh("20"),
                WalkingPace,
                WalkingPace,
            ]
        );
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownMaxspeedValue]);
    }

    #[test]
    fn a_shadowed_unsupported_unit_is_still_reported() {
        let pairs = [
            ("maxspeed", "50 furlongs"),
            ("maxspeed:motorcar", "30"),
            ("maxspeed:bicycle", "30"),
            ("maxspeed:foot", "30"),
        ];
        assert_eq!(six(&pairs), uniform(kmh("30")));
        assert_eq!(codes(&pairs), vec![IssueCode::UnsupportedMaxspeedUnit]);
    }

    #[test]
    fn several_bad_static_keys_warn_once_per_road_per_code() {
        // Counts are counts of roads, not of tags or of the six outputs.
        let pairs = [
            ("maxspeed", "bogus"),
            ("maxspeed:forward", "also bogus"),
            ("maxspeed:motorcar", "still bogus"),
            ("maxspeed:vehicle", "50 furlongs"),
            ("maxspeed:bicycle", "50 fathoms"),
        ];
        assert_eq!(
            codes(&pairs),
            vec![
                IssueCode::UnknownMaxspeedValue,
                IssueCode::UnsupportedMaxspeedUnit,
            ]
        );
    }

    #[test]
    fn the_scan_reads_every_supported_static_key() {
        // One broken value on each supported key in turn, each on its own.
        for qualifier in [
            None,
            Some("vehicle"),
            Some("motor_vehicle"),
            Some("motorcar"),
            Some("bicycle"),
            Some("foot"),
        ] {
            for direction in [
                None,
                Some(SpeedDirection::Forward),
                Some(SpeedDirection::Backward),
            ] {
                let key = static_key(qualifier, direction);
                assert_eq!(
                    codes(&[(key.as_str(), "bogus")]),
                    vec![IssueCode::UnknownMaxspeedValue],
                    "{key} was not scanned"
                );
            }
        }
    }

    #[test]
    fn a_diagnostic_never_changes_a_derived_value() {
        // The same six facts, with and without an extra broken key that the
        // scan reports and precedence never reaches.
        let sound = six(&[
            ("maxspeed:motorcar", "30"),
            ("maxspeed:bicycle", "20"),
            ("maxspeed:foot", "10"),
        ]);
        let with_noise = six(&[
            ("maxspeed", "bogus"),
            ("maxspeed:motorcar", "30"),
            ("maxspeed:bicycle", "20"),
            ("maxspeed:foot", "10"),
        ]);
        assert_eq!(sound, with_noise);
        assert!(codes(&[("maxspeed:motorcar", "30")]).is_empty());
    }

    // -- conditional --------------------------------------------------------

    #[test]
    fn a_generic_conditional_supplements_every_fact_without_erasing_it() {
        let pairs = [("maxspeed", "80"), ("maxspeed:conditional", A_CONDITION)];
        // The ordinary limit is untouched.
        assert_eq!(six(&pairs), uniform(kmh("80")));
        assert_eq!(six_conditionals(&pairs), [Present; 6]);
        assert_eq!(
            codes(&pairs),
            vec![IssueCode::UnsupportedConditionalMaxspeed]
        );
    }

    #[test]
    fn a_more_specific_static_key_shadows_a_generic_conditional_for_that_mode() {
        let pairs = [
            ("maxspeed", "80"),
            ("maxspeed:conditional", A_CONDITION),
            ("maxspeed:motorcar", "90"),
        ];
        assert_eq!(
            six(&pairs),
            [
                kmh("90"),
                kmh("90"),
                kmh("80"),
                kmh("80"),
                kmh("80"),
                kmh("80"),
            ]
        );
        assert_eq!(
            six_conditionals(&pairs),
            [NoCondition, NoCondition, Present, Present, Present, Present]
        );
        // One warning for the road, however many facts the conditional reached.
        assert_eq!(
            codes(&pairs),
            vec![IssueCode::UnsupportedConditionalMaxspeed]
        );
    }

    #[test]
    fn a_fully_shadowed_conditional_changes_no_fact_and_earns_no_warning() {
        // The tag is valid data Atlas chose not to evaluate. Out-ranked
        // everywhere, it shaped nothing, so there is no limitation to report.
        let pairs = [
            ("maxspeed", "80"),
            ("maxspeed:conditional", A_CONDITION),
            ("maxspeed:motorcar", "90"),
            ("maxspeed:bicycle", "25"),
            ("maxspeed:foot", "walk"),
        ];
        assert_eq!(
            six(&pairs),
            [
                kmh("90"),
                kmh("90"),
                kmh("25"),
                kmh("25"),
                WalkingPace,
                WalkingPace,
            ]
        );
        assert_eq!(six_conditionals(&pairs), [NoCondition; 6]);
        assert!(codes(&pairs).is_empty());
    }

    #[test]
    fn a_conditional_at_the_winning_scope_beats_the_static_beside_it() {
        // Rule three of the official order: conditional over static at the
        // same mode and direction.
        let pairs = [
            ("maxspeed:motorcar", "90"),
            ("maxspeed:motorcar:conditional", A_CONDITION),
        ];
        assert_eq!(
            limits(&pairs)
                .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                .conditional(),
            Present
        );
        assert_eq!(
            limits(&pairs)
                .fact(TravelMode::Bicycle, SpeedDirection::Forward)
                .conditional(),
            NoCondition
        );
    }

    #[test]
    fn a_directional_conditional_reaches_only_its_own_direction() {
        let pairs = [
            ("maxspeed", "80"),
            (
                "maxspeed:motorcar:forward:conditional",
                "30 @ (Mo-Fr 07:00-09:00)",
            ),
        ];
        assert_eq!(six(&pairs), uniform(kmh("80")));
        assert_eq!(
            six_conditionals(&pairs),
            [
                Present,
                NoCondition,
                NoCondition,
                NoCondition,
                NoCondition,
                NoCondition
            ]
        );
        assert_eq!(
            codes(&pairs),
            vec![IssueCode::UnsupportedConditionalMaxspeed]
        );
    }

    #[test]
    fn a_conditional_expression_is_never_read() {
        // Presence is the whole claim. A blank or nonsensical expression makes
        // no difference to anything Atlas records.
        for expression in ["", "60 @ wet", "nonsense", "@@@"] {
            let pairs = [("maxspeed", "80"), ("maxspeed:conditional", expression)];
            assert_eq!(six(&pairs), uniform(kmh("80")), "{expression:?}");
            assert_eq!(six_conditionals(&pairs), [Present; 6], "{expression:?}");
            // A conditional value is never scanned for readability, so an
            // empty one earns no unknown-value warning.
            assert_eq!(
                codes(&pairs),
                vec![IssueCode::UnsupportedConditionalMaxspeed],
                "{expression:?}"
            );
        }
    }

    #[test]
    fn a_conditional_can_stand_where_there_is_no_ordinary_limit() {
        let pairs = [("maxspeed:conditional", A_CONDITION)];
        assert_eq!(six(&pairs), uniform(Unspecified));
        assert_eq!(six_conditionals(&pairs), [Present; 6]);
    }

    // -- variable -----------------------------------------------------------

    #[test]
    fn variability_never_erases_the_ordinary_limit() {
        let derived = limits(&[("maxspeed", "100"), ("maxspeed:variable", "yes")]);
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                let fact = derived.fact(mode, direction);
                assert_eq!(fact.limit(), &kmh("100"));
                assert_eq!(fact.variable(), Varies);
                assert_eq!(fact.conditional(), NoCondition);
            }
        }
    }

    #[test]
    fn the_documented_variable_values_are_read() {
        let variability = |value: &str| {
            limits(&[("maxspeed:variable", value)])
                .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                .variable()
        };
        assert_eq!(variability("no"), Fixed);
        assert_eq!(variability("yes"), Varies);
        assert_eq!(variability("YES"), Varies);
        assert_eq!(variability(" no "), Fixed);
        for reason in VARIABLE_REASONS {
            assert_eq!(variability(reason), Varies, "{reason}");
        }
        assert_eq!(variability("peak_traffic;weather"), Varies);
        assert_eq!(variability("weather;school_zone;obstruction"), Varies);
        assert_eq!(variability(" weather ; environment "), Varies);
    }

    #[test]
    fn an_unreadable_variable_value_is_indeterminate_and_warns() {
        for value in ["", "perhaps", "signals", "weather;perhaps", "yes;no", ";"] {
            let pairs = [("maxspeed:variable", value)];
            assert_eq!(
                limits(&pairs)
                    .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                    .variable(),
                VariableIndeterminate,
                "{value:?}"
            );
            assert_eq!(
                codes(&pairs),
                vec![IssueCode::UnknownVariableMaxspeedValue],
                "{value:?}"
            );
        }
    }

    #[test]
    fn the_deprecated_signals_value_is_never_silently_translated() {
        // `maxspeed=signals` is deprecated in favour of `maxspeed:variable`.
        // Atlas records that it could not read it rather than quietly turning
        // it into a variability claim the mapper did not make here.
        assert_eq!(six(&[("maxspeed", "signals")]), uniform(Indeterminate));
        assert_eq!(
            codes(&[("maxspeed", "signals")]),
            vec![IssueCode::UnknownMaxspeedValue]
        );
        let derived = limits(&[("maxspeed", "signals")]);
        assert_eq!(
            derived
                .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                .variable(),
            NoVariability
        );
    }

    #[test]
    fn maxspeed_unknown_is_not_a_recognised_correct_value() {
        // The source says an unknown limit should be represented by omitting
        // `maxspeed` altogether, so `unknown` is a data problem rather than an
        // honest report of uncertainty.
        assert_eq!(six(&[("maxspeed", "unknown")]), uniform(Indeterminate));
        assert_eq!(
            codes(&[("maxspeed", "unknown")]),
            vec![IssueCode::UnknownMaxspeedValue]
        );
    }

    #[test]
    fn a_directional_variable_key_overrides_the_general_one() {
        let derived = limits(&[
            ("maxspeed", "100"),
            ("maxspeed:variable", "yes"),
            ("maxspeed:variable:forward", "no"),
        ]);
        for mode in TravelMode::ALL {
            assert_eq!(derived.limits(mode).forward().variable(), Fixed, "{mode}");
            assert_eq!(derived.limits(mode).backward().variable(), Varies, "{mode}");
        }
    }

    #[test]
    fn an_unreadable_directional_variable_value_does_not_fall_back() {
        let pairs = [
            ("maxspeed", "100"),
            ("maxspeed:variable", "weather"),
            ("maxspeed:variable:forward", "perhaps"),
        ];
        let derived = limits(&pairs);
        for mode in TravelMode::ALL {
            assert_eq!(
                derived.limits(mode).forward().variable(),
                VariableIndeterminate,
                "{mode}"
            );
            assert_eq!(derived.limits(mode).backward().variable(), Varies, "{mode}");
            // The ordinary limit is untouched in both directions.
            assert_eq!(derived.limits(mode).forward().limit(), &kmh("100"));
            assert_eq!(derived.limits(mode).backward().limit(), &kmh("100"));
        }
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownVariableMaxspeedValue]);
    }

    #[test]
    fn a_shadowed_malformed_variable_value_still_warns_once() {
        // The general key is out-ranked in both directions and is still
        // scanned, for the same reason a shadowed static mistake is.
        let pairs = [
            ("maxspeed:variable", "perhaps"),
            ("maxspeed:variable:forward", "yes"),
            ("maxspeed:variable:backward", "no"),
        ];
        let derived = limits(&pairs);
        assert_eq!(derived.motorcar().forward().variable(), Varies);
        assert_eq!(derived.motorcar().backward().variable(), Fixed);
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownVariableMaxspeedValue]);

        // Three malformed variable keys still warn exactly once.
        assert_eq!(
            codes(&[
                ("maxspeed:variable", "perhaps"),
                ("maxspeed:variable:forward", "maybe"),
                ("maxspeed:variable:backward", "possibly"),
            ]),
            vec![IssueCode::UnknownVariableMaxspeedValue]
        );
    }

    #[test]
    fn variability_applies_to_every_modelled_mode() {
        // There are no mode-specific variable keys in the source, so the sign
        // speaks for every mode. Whether a particular traveller obeys it is a
        // routing question Atlas does not answer.
        let derived = limits(&[("maxspeed:variable", "yes")]);
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                assert_eq!(derived.fact(mode, direction).variable(), Varies);
            }
        }
    }

    #[test]
    fn a_road_with_no_variable_tag_says_nothing_about_variability() {
        let derived = limits(&[("maxspeed", "50")]);
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                assert_eq!(derived.fact(mode, direction).variable(), NoVariability);
            }
        }
        // "Nobody tagged it" is not "somebody said it is fixed".
        assert_ne!(NoVariability, Fixed);
    }

    // -- modifier independence ----------------------------------------------

    #[test]
    fn the_three_members_of_a_fact_are_independent() {
        let pairs = [
            ("maxspeed", "80"),
            ("maxspeed:conditional", A_CONDITION),
            ("maxspeed:variable", "no"),
        ];
        let derived = limits(&pairs);
        let fact = derived.fact(TravelMode::Motorcar, SpeedDirection::Forward);
        assert_eq!(fact.limit(), &kmh("80"));
        assert_eq!(fact.conditional(), Present);
        assert_eq!(fact.variable(), Fixed);
        assert_eq!(
            codes(&pairs),
            vec![IssueCode::UnsupportedConditionalMaxspeed]
        );
    }

    #[test]
    fn all_four_codes_can_be_earned_by_one_road_each_exactly_once() {
        let pairs = [
            ("maxspeed", "bogus"),
            ("maxspeed:vehicle", "50 furlongs"),
            ("maxspeed:motorcar", "30"),
            ("maxspeed:motorcar:conditional", A_CONDITION),
            ("maxspeed:variable", "perhaps"),
        ];
        assert_eq!(
            codes(&pairs),
            vec![
                IssueCode::UnknownMaxspeedValue,
                IssueCode::UnsupportedMaxspeedUnit,
                IssueCode::UnsupportedConditionalMaxspeed,
                IssueCode::UnknownVariableMaxspeedValue,
            ]
        );
    }

    // -- deferred keys ------------------------------------------------------

    #[test]
    fn the_deferred_keys_change_nothing_and_warn_about_nothing() {
        // A deliberate scope boundary, not an accidental omission: these keys
        // are read by nothing in this milestone, so they can neither move a
        // derived value nor produce a diagnostic.
        let baseline = six(&[("maxspeed", "50")]);
        for (key, value) in [
            ("maxspeed:type", "RO:urban"),
            ("maxspeed:type", "sign"),
            ("source:maxspeed", "RO:urban"),
            ("source:maxspeed", "survey"),
            ("zone:maxspeed", "DE:30"),
            ("maxspeed:advisory", "40"),
            ("minspeed", "20"),
            ("maxspeed:lanes", "50|70"),
            ("maxspeed:hgv", "60"),
        ] {
            let pairs = [("maxspeed", "50"), (key, value)];
            assert_eq!(six(&pairs), baseline, "{key}={value} moved a limit");
            assert!(codes(&pairs).is_empty(), "{key}={value} produced a warning");
        }

        // And on their own they leave the road silent about speed.
        assert_eq!(
            six(&[
                ("maxspeed:type", "RO:urban"),
                ("source:maxspeed", "DE:urban")
            ]),
            uniform(Unspecified)
        );
    }

    #[test]
    fn no_country_or_road_class_default_is_ever_invented() {
        // `derive_speed_limits` is given tags and nothing else, which is the
        // structural proof. This is the behavioural one: a motorway and a
        // residential street with no speed tags say exactly the same thing.
        assert_eq!(
            six(&[("highway", "motorway")]),
            six(&[("highway", "residential")])
        );
        assert_eq!(six(&[("highway", "motorway")]), uniform(Unspecified));
        // An implicit code is preserved, never resolved into the number it
        // would imply.
        assert_eq!(
            limits(&[("maxspeed", "DE:rural")])
                .fact(TravelMode::Motorcar, SpeedDirection::Forward)
                .limit()
                .speed(),
            None
        );
    }

    // -- key construction ---------------------------------------------------

    #[test]
    fn the_motorcar_forward_chain_is_exactly_the_documented_keys() {
        let keys: Vec<String> = chain(TravelMode::Motorcar, SpeedDirection::Forward)
            .into_iter()
            .map(|scope| scope.static_key)
            .collect();
        assert_eq!(
            keys,
            vec![
                "maxspeed:motorcar:forward",
                "maxspeed:motorcar",
                "maxspeed:motor_vehicle:forward",
                "maxspeed:motor_vehicle",
                "maxspeed:vehicle:forward",
                "maxspeed:vehicle",
                "maxspeed:forward",
                "maxspeed",
            ]
        );
    }

    #[test]
    fn every_chain_pairs_each_static_key_with_its_conditional_sibling() {
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                for scope in chain(mode, direction) {
                    assert_eq!(
                        scope.conditional_key,
                        format!("{}:conditional", scope.static_key),
                        "{mode} {direction}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_scanned_keys_are_exactly_the_union_of_every_chain() {
        use std::collections::BTreeSet;

        let scanned: BTreeSet<String> = valued_static_keys().into_iter().collect();
        let mut from_chains = BTreeSet::new();
        for mode in TravelMode::ALL {
            for direction in SpeedDirection::ALL {
                for scope in chain(mode, direction) {
                    from_chains.insert(scope.static_key);
                }
            }
        }
        assert_eq!(scanned, from_chains);
        assert_eq!(scanned.len(), 18);
    }
}
