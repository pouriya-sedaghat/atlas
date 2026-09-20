//! Turning OSM direction tags into Atlas travel semantics.
//!
//! This is where OSM's `oneway` vocabulary stops. Everything above this module
//! sees [`RoadTraversal`]: three Atlas directions, one per modelled mode, with
//! no tag map and no OSM key names in sight.
//!
//! Two rules shape the whole file:
//!
//! * A value Atlas cannot read never falls back to a less specific tag. If a
//!   way says `oneway:motorcar=sometimes`, the mapper meant to say something
//!   specific about motorcars, and quietly using the plain `oneway` instead
//!   would be Atlas inventing an answer the source never gave.
//! * A direction Atlas cannot state safely is
//!   [`TravelDirection::Indeterminate`], not [`TravelDirection::Both`]. Being
//!   unable to describe a road is a much smaller problem than describing it
//!   wrongly.

use atlas_engine::IssueCode;
use atlas_kernel::{RoadClass, RoadTraversal, TravelDirection};

use crate::model::OsmTags;

/// The plain, mode-agnostic direction key.
const ONEWAY: &str = "oneway";
/// Mode-specific direction keys, most specific first per mode.
const ONEWAY_MOTORCAR: &str = "oneway:motorcar";
const ONEWAY_MOTOR_VEHICLE: &str = "oneway:motor_vehicle";
const ONEWAY_BICYCLE: &str = "oneway:bicycle";
const ONEWAY_FOOT: &str = "oneway:foot";

/// Conditional direction keys. Their values are deliberately never parsed.
const ONEWAY_CONDITIONAL: &str = "oneway:conditional";
const ONEWAY_MOTORCAR_CONDITIONAL: &str = "oneway:motorcar:conditional";
const ONEWAY_MOTOR_VEHICLE_CONDITIONAL: &str = "oneway:motor_vehicle:conditional";
const ONEWAY_BICYCLE_CONDITIONAL: &str = "oneway:bicycle:conditional";
const ONEWAY_FOOT_CONDITIONAL: &str = "oneway:foot:conditional";

/// Every direction key whose *value* Atlas reads.
///
/// Used to decide whether a way carries a direction value Atlas cannot read,
/// independently of which key precedence happened to consult.
const VALUED_KEYS: [&str; 5] = [
    ONEWAY,
    ONEWAY_MOTORCAR,
    ONEWAY_MOTOR_VEHICLE,
    ONEWAY_BICYCLE,
    ONEWAY_FOOT,
];

/// One OSM direction value, normalised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnewayValue {
    /// `yes`, and the legacy aliases `true` and `1`.
    Forward,
    /// `no`, and the legacy aliases `false` and `0`.
    Both,
    /// `-1` and `reverse`.
    Reverse,
    /// `reversible`.
    Reversible,
    /// `alternating`.
    Alternating,
    /// Anything else, including a blank value.
    Unsupported,
}

impl OnewayValue {
    /// Reads one value, trimming whitespace and ignoring ASCII case.
    ///
    /// The legacy aliases are accepted in silence: `true`, `1`, `false`, `0`
    /// and `reverse` are perfectly readable statements about direction that
    /// happen to be spelled the old way. Warning about them would train
    /// readers to ignore the warning list.
    fn parse(raw: &str) -> Self {
        let value = raw.trim();
        let is = |candidate: &str| value.eq_ignore_ascii_case(candidate);

        if is("yes") || is("true") || is("1") {
            OnewayValue::Forward
        } else if is("no") || is("false") || is("0") {
            OnewayValue::Both
        } else if is("-1") || is("reverse") {
            OnewayValue::Reverse
        } else if is("reversible") {
            OnewayValue::Reversible
        } else if is("alternating") {
            OnewayValue::Alternating
        } else {
            OnewayValue::Unsupported
        }
    }

    /// The Atlas direction this value states.
    fn direction(self) -> TravelDirection {
        match self {
            OnewayValue::Forward => TravelDirection::Forward,
            OnewayValue::Both => TravelDirection::Both,
            OnewayValue::Reverse => TravelDirection::Reverse,
            OnewayValue::Reversible => TravelDirection::Reversible,
            OnewayValue::Alternating => TravelDirection::Alternating,
            OnewayValue::Unsupported => TravelDirection::Indeterminate,
        }
    }

    /// Whether the value restricts direction at all.
    ///
    /// `no` does not; everything Atlas can read apart from `no` does.
    fn restricts_direction(self) -> bool {
        matches!(
            self,
            OnewayValue::Forward
                | OnewayValue::Reverse
                | OnewayValue::Reversible
                | OnewayValue::Alternating
        )
    }
}

/// Which modes a way's conditional direction tags reach.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ConditionalScope {
    motorcar: bool,
    bicycle: bool,
    foot: bool,
}

impl ConditionalScope {
    /// Detects conditional direction tags by key alone.
    ///
    /// The value is never read: an opening-hours expression is a dynamic
    /// restriction, and the only honest thing a static dataset can say about
    /// one is that it cannot say.
    fn detect(tags: &OsmTags) -> Self {
        let generic = tags.get(ONEWAY_CONDITIONAL).is_some();
        Self {
            // A generic `oneway:conditional` is a vehicle statement, exactly
            // as a generic `oneway` is, so it does not reach pedestrians.
            motorcar: generic
                || tags.get(ONEWAY_MOTORCAR_CONDITIONAL).is_some()
                || tags.get(ONEWAY_MOTOR_VEHICLE_CONDITIONAL).is_some(),
            bicycle: generic || tags.get(ONEWAY_BICYCLE_CONDITIONAL).is_some(),
            foot: tags.get(ONEWAY_FOOT_CONDITIONAL).is_some(),
        }
    }

    fn any(self) -> bool {
        self.motorcar || self.bicycle || self.foot
    }
}

/// What a plain `oneway` value means for pedestrians on a given road class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FootScope {
    /// Plain `oneway` is about pedestrians here: steps.
    Applies,
    /// Plain `oneway` may or may not be about pedestrians here.
    Ambiguous,
    /// Plain `oneway` is about vehicles here; pedestrians are unaffected.
    VehiclesOnly,
}

/// Which warnings one way's direction tags earned.
///
/// Flags rather than a list: each semantic problem is reported once per way,
/// however many tags contributed to it, so the counts stay readable and
/// deterministic.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DirectionIssues {
    unknown_value: bool,
    ambiguous_scope: bool,
    unsupported_conditional: bool,
}

impl DirectionIssues {
    /// The codes to record, in a fixed order.
    pub(crate) fn codes(self) -> impl Iterator<Item = IssueCode> {
        [
            self.unknown_value.then_some(IssueCode::UnknownOnewayValue),
            self.ambiguous_scope
                .then_some(IssueCode::AmbiguousOnewayScope),
            self.unsupported_conditional
                .then_some(IssueCode::UnsupportedConditionalOneway),
        ]
        .into_iter()
        .flatten()
    }
}

/// The travel semantics of one way, plus the warnings deriving them produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DerivedTraversal {
    pub(crate) traversal: RoadTraversal,
    pub(crate) issues: DirectionIssues,
}

/// Derives the travel direction of one way for every modelled mode.
///
/// `class` is the Atlas classification already derived from `highway`, which
/// is what the pedestrian rules key off: this function does not re-read the
/// `highway` tag for anything a classification already answers.
pub(crate) fn derive_traversal(tags: &OsmTags, class: &RoadClass) -> DerivedTraversal {
    // A direction value Atlas cannot read is a data problem whether or not
    // precedence happened to consult that key, so it is reported from the tags
    // rather than from the outcome.
    let unknown_value = VALUED_KEYS
        .iter()
        .filter_map(|key| tags.get(key))
        .any(|value| OnewayValue::parse(value) == OnewayValue::Unsupported);

    let conditional = ConditionalScope::detect(tags);
    let plain = tags.get(ONEWAY).map(OnewayValue::parse);
    let implied = implies_forward(tags, class);

    let motorcar = if conditional.motorcar {
        TravelDirection::Indeterminate
    } else if let Some(value) = tags.get(ONEWAY_MOTORCAR).map(OnewayValue::parse) {
        value.direction()
    } else if let Some(value) = tags.get(ONEWAY_MOTOR_VEHICLE).map(OnewayValue::parse) {
        value.direction()
    } else if let Some(value) = plain {
        value.direction()
    } else if implied {
        TravelDirection::Forward
    } else {
        TravelDirection::Both
    };

    let bicycle = if conditional.bicycle {
        TravelDirection::Indeterminate
    } else if let Some(value) = tags.get(ONEWAY_BICYCLE).map(OnewayValue::parse) {
        value.direction()
    } else if let Some(value) = plain {
        value.direction()
    } else if implied {
        TravelDirection::Forward
    } else {
        TravelDirection::Both
    };

    let (foot, ambiguous_scope) = foot_direction(tags, class, plain, conditional.foot);

    DerivedTraversal {
        traversal: RoadTraversal::new(motorcar, bicycle, foot),
        issues: DirectionIssues {
            unknown_value,
            ambiguous_scope,
            unsupported_conditional: conditional.any(),
        },
    }
}

/// Whether the way is one of the two shapes that imply a forward direction.
///
/// Only these two. Every other "everybody knows this is one-way" rule is a
/// guess, and a guess in a dataset is indistinguishable from a fact.
fn implies_forward(tags: &OsmTags, class: &RoadClass) -> bool {
    let roundabout = tags
        .get("junction")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("roundabout"));
    roundabout || matches!(class, RoadClass::Motorway)
}

/// The pedestrian direction, and whether the plain value's scope was ambiguous.
///
/// Plain `oneway` is, by long convention, a statement about vehicles. Applying
/// it to pedestrians everywhere would turn every one-way street into a
/// one-way pavement, which is simply false. Ignoring it everywhere would lose
/// the one-way stairwells and passages where it is the only thing said. So the
/// road class decides, and where the class cannot decide, Atlas says so.
fn foot_direction(
    tags: &OsmTags,
    class: &RoadClass,
    plain: Option<OnewayValue>,
    foot_conditional: bool,
) -> (TravelDirection, bool) {
    if foot_conditional {
        return (TravelDirection::Indeterminate, false);
    }
    // An explicit pedestrian statement always wins, including an explicit
    // `oneway:foot=no` that re-opens a way the plain value closed.
    if let Some(value) = tags.get(ONEWAY_FOOT).map(OnewayValue::parse) {
        return (value.direction(), false);
    }
    let Some(plain) = plain else {
        return (TravelDirection::Both, false);
    };

    match foot_scope(class) {
        FootScope::Applies => (plain.direction(), false),
        FootScope::Ambiguous if plain.restricts_direction() => {
            (TravelDirection::Indeterminate, true)
        }
        // A value Atlas cannot read is already reported as an unreadable
        // value; calling its scope ambiguous as well would be two warnings
        // for one problem.
        FootScope::Ambiguous => (plain.direction(), false),
        FootScope::VehiclesOnly => (TravelDirection::Both, false),
    }
}

fn foot_scope(class: &RoadClass) -> FootScope {
    match class {
        // Steps exist for pedestrians. A `oneway` on them is about the people
        // using them, because nothing else uses them.
        RoadClass::Steps => FootScope::Applies,
        // Shared ways: the tag may well be about the pedestrians, or about the
        // cyclists sharing the way with them. The source does not say.
        RoadClass::Path | RoadClass::Footway => FootScope::Ambiguous,
        // A classification Atlas does not model cannot be reasoned about, so
        // it is treated like a shared way rather than assumed to be a street.
        RoadClass::Other(_) => FootScope::Ambiguous,
        RoadClass::Motorway
        | RoadClass::Trunk
        | RoadClass::Primary
        | RoadClass::Secondary
        | RoadClass::Tertiary
        | RoadClass::Unclassified
        | RoadClass::Residential
        | RoadClass::LivingStreet
        | RoadClass::Service
        | RoadClass::Track
        | RoadClass::Cycleway => FootScope::VehiclesOnly,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(pairs: &[(&str, &str)]) -> OsmTags {
        let mut tags = OsmTags::default();
        for (key, value) in pairs {
            tags.insert((*key).to_owned(), (*value).to_owned());
        }
        tags
    }

    fn derive(class: RoadClass, pairs: &[(&str, &str)]) -> DerivedTraversal {
        derive_traversal(&tags(pairs), &class)
    }

    fn residential(pairs: &[(&str, &str)]) -> DerivedTraversal {
        derive(RoadClass::Residential, pairs)
    }

    fn codes(derived: &DerivedTraversal) -> Vec<IssueCode> {
        derived.issues.codes().collect()
    }

    #[test]
    fn every_supported_value_and_legacy_alias_reads_the_same_way() {
        let cases = [
            ("yes", TravelDirection::Forward),
            ("true", TravelDirection::Forward),
            ("1", TravelDirection::Forward),
            ("no", TravelDirection::Both),
            ("false", TravelDirection::Both),
            ("0", TravelDirection::Both),
            ("-1", TravelDirection::Reverse),
            ("reverse", TravelDirection::Reverse),
            ("reversible", TravelDirection::Reversible),
            ("alternating", TravelDirection::Alternating),
        ];
        for (value, expected) in cases {
            let derived = residential(&[("oneway", value)]);
            assert_eq!(
                derived.traversal.motorcar(),
                expected,
                "oneway={value} read wrongly"
            );
            assert_eq!(derived.traversal.bicycle(), expected);
            assert!(
                codes(&derived).is_empty(),
                "oneway={value} must not warn: {:?}",
                codes(&derived)
            );
        }
    }

    #[test]
    fn values_are_trimmed_and_case_insensitive() {
        for value in ["  yes  ", "YES", "Yes", "\tyEs\n"] {
            let derived = residential(&[("oneway", value)]);
            assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);
            assert!(codes(&derived).is_empty());
        }
        for value in [" -1 ", "REVERSE", " Reversible ", "ALTERNATING"] {
            let derived = residential(&[("oneway", value)]);
            assert!(
                codes(&derived).is_empty(),
                "{value} should be readable: {:?}",
                codes(&derived)
            );
            assert_ne!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        }
    }

    #[test]
    fn a_road_with_no_direction_tags_is_two_way_for_everyone() {
        let derived = residential(&[]);
        assert_eq!(derived.traversal, RoadTraversal::bidirectional());
        assert!(codes(&derived).is_empty());
    }

    #[test]
    fn motorcar_precedence_runs_from_most_specific_to_least() {
        // Every key present: the most specific wins.
        let derived = residential(&[
            ("oneway:motorcar", "-1"),
            ("oneway:motor_vehicle", "yes"),
            ("oneway", "reversible"),
        ]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Reverse);

        // Without the motorcar key, motor_vehicle answers.
        let derived = residential(&[("oneway:motor_vehicle", "yes"), ("oneway", "-1")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);

        // Without either, the plain value answers.
        let derived = residential(&[("oneway", "-1")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Reverse);
    }

    #[test]
    fn bicycle_precedence_ignores_the_motor_vehicle_keys() {
        let derived = residential(&[
            ("oneway:bicycle", "no"),
            ("oneway:motorcar", "yes"),
            ("oneway:motor_vehicle", "yes"),
            ("oneway", "yes"),
        ]);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);

        // `oneway:motor_vehicle` is not a bicycle statement, so the plain
        // value is what a bicycle follows here.
        let derived = residential(&[("oneway:motor_vehicle", "-1"), ("oneway", "yes")]);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Forward);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Reverse);
    }

    #[test]
    fn a_contraflow_cycle_lane_keeps_the_street_one_way_for_cars() {
        let derived = residential(&[("oneway", "yes"), ("oneway:bicycle", "no")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert!(codes(&derived).is_empty());
    }

    #[test]
    fn foot_precedence_prefers_its_own_key_over_everything() {
        let derived = residential(&[("oneway", "yes"), ("oneway:foot", "-1")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Reverse);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);

        // An explicit pedestrian `no` re-opens steps the plain value closed.
        let derived = derive(
            RoadClass::Steps,
            &[("oneway", "yes"), ("oneway:foot", "no")],
        );
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
    }

    #[test]
    fn a_roundabout_is_forward_for_vehicles_and_open_on_foot() {
        let derived = derive(RoadClass::Tertiary, &[("junction", "roundabout")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Forward);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert!(codes(&derived).is_empty());
    }

    #[test]
    fn a_motorway_is_forward_for_vehicles_without_a_oneway_tag() {
        let derived = derive(RoadClass::Motorway, &[]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Forward);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
    }

    #[test]
    fn an_explicit_two_way_value_overrides_an_implied_rule() {
        for value in ["no", "false", "0"] {
            let derived = derive(
                RoadClass::Tertiary,
                &[("junction", "roundabout"), ("oneway", value)],
            );
            assert_eq!(
                derived.traversal.motorcar(),
                TravelDirection::Both,
                "oneway={value} should reopen the roundabout"
            );
            assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);

            let derived = derive(RoadClass::Motorway, &[("oneway", value)]);
            assert_eq!(derived.traversal.motorcar(), TravelDirection::Both);
            assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);
        }
    }

    #[test]
    fn an_explicit_reverse_overrides_an_implied_rule() {
        let derived = derive(
            RoadClass::Tertiary,
            &[("junction", "roundabout"), ("oneway", "-1")],
        );
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Reverse);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Reverse);
    }

    #[test]
    fn an_unreadable_plain_value_is_indeterminate_and_warns_once() {
        let derived = residential(&[("oneway", "sometimes")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Indeterminate);
        // Plain `oneway` is a vehicle statement on an ordinary street, so an
        // unreadable one says nothing about pedestrians at all.
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert_eq!(codes(&derived), vec![IssueCode::UnknownOnewayValue]);
    }

    #[test]
    fn a_blank_direction_value_is_unreadable_rather_than_absent() {
        let derived = residential(&[("oneway", "   ")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(codes(&derived), vec![IssueCode::UnknownOnewayValue]);
    }

    #[test]
    fn an_unreadable_mode_override_never_falls_back_to_a_broader_tag() {
        let derived = residential(&[("oneway:motorcar", "sometimes"), ("oneway", "yes")]);
        assert_eq!(
            derived.traversal.motorcar(),
            TravelDirection::Indeterminate,
            "an unreadable motorcar override must not silently become the plain value"
        );
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Forward);
        assert_eq!(codes(&derived), vec![IssueCode::UnknownOnewayValue]);

        let derived = residential(&[("oneway:bicycle", "maybe"), ("oneway", "yes")]);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);

        let derived = residential(&[("oneway:motor_vehicle", "maybe"), ("oneway", "yes")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);

        let derived = residential(&[("oneway:foot", "maybe"), ("oneway", "yes")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Indeterminate);
    }

    #[test]
    fn an_unreadable_mode_override_does_not_disturb_an_implied_rule() {
        // The motorcar key is unreadable; the bicycle still gets the motorway
        // implication rather than the motorcar's problem.
        let derived = derive(RoadClass::Motorway, &[("oneway:motorcar", "huh")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Forward);
    }

    #[test]
    fn several_unreadable_values_on_one_way_warn_once() {
        let derived = residential(&[
            ("oneway", "huh"),
            ("oneway:motorcar", "what"),
            ("oneway:bicycle", "eh"),
        ]);
        assert_eq!(codes(&derived), vec![IssueCode::UnknownOnewayValue]);
    }

    #[test]
    fn a_footway_with_a_directional_plain_value_is_ambiguous_for_pedestrians() {
        for class in [RoadClass::Footway, RoadClass::Path] {
            for value in ["yes", "-1", "reversible", "alternating"] {
                let derived = derive(class.clone(), &[("oneway", value)]);
                assert_eq!(
                    derived.traversal.foot(),
                    TravelDirection::Indeterminate,
                    "{class} oneway={value}"
                );
                assert_eq!(codes(&derived), vec![IssueCode::AmbiguousOnewayScope]);
            }
        }
    }

    #[test]
    fn a_footway_that_says_two_way_is_two_way_on_foot_too() {
        for class in [RoadClass::Footway, RoadClass::Path] {
            let derived = derive(class.clone(), &[("oneway", "no")]);
            assert_eq!(derived.traversal.foot(), TravelDirection::Both);
            assert!(codes(&derived).is_empty());
        }
    }

    #[test]
    fn an_explicit_foot_value_resolves_a_footway_ambiguity() {
        let derived = derive(
            RoadClass::Footway,
            &[("oneway", "yes"), ("oneway:foot", "yes")],
        );
        assert_eq!(derived.traversal.foot(), TravelDirection::Forward);
        assert!(
            codes(&derived).is_empty(),
            "the source answered the question, so there is nothing to warn about"
        );
    }

    #[test]
    fn an_unreadable_value_on_a_footway_is_not_also_an_ambiguity() {
        let derived = derive(RoadClass::Footway, &[("oneway", "sometimes")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Indeterminate);
        assert_eq!(
            codes(&derived),
            vec![IssueCode::UnknownOnewayValue],
            "one problem earns one warning"
        );
    }

    #[test]
    fn steps_read_a_plain_value_as_a_pedestrian_statement() {
        let cases = [
            ("yes", TravelDirection::Forward),
            ("-1", TravelDirection::Reverse),
            ("no", TravelDirection::Both),
            ("reversible", TravelDirection::Reversible),
            ("alternating", TravelDirection::Alternating),
        ];
        for (value, expected) in cases {
            let derived = derive(RoadClass::Steps, &[("oneway", value)]);
            assert_eq!(derived.traversal.foot(), expected, "steps oneway={value}");
            assert!(codes(&derived).is_empty());
        }

        // Unreadable on steps is unreadable for pedestrians too, because here
        // the tag really was about them.
        let derived = derive(RoadClass::Steps, &[("oneway", "upwards")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Indeterminate);
        assert_eq!(codes(&derived), vec![IssueCode::UnknownOnewayValue]);
    }

    #[test]
    fn plain_oneway_leaves_pedestrians_alone_on_street_like_classes() {
        let classes = [
            RoadClass::Motorway,
            RoadClass::Trunk,
            RoadClass::Primary,
            RoadClass::Secondary,
            RoadClass::Tertiary,
            RoadClass::Unclassified,
            RoadClass::Residential,
            RoadClass::LivingStreet,
            RoadClass::Service,
            RoadClass::Track,
            RoadClass::Cycleway,
        ];
        for class in classes {
            for value in ["yes", "-1", "reversible", "alternating", "nonsense"] {
                let derived = derive(class.clone(), &[("oneway", value)]);
                assert_eq!(
                    derived.traversal.foot(),
                    TravelDirection::Both,
                    "{class} oneway={value} must not restrict pedestrians"
                );
                assert!(
                    !codes(&derived).contains(&IssueCode::AmbiguousOnewayScope),
                    "{class} oneway={value} must not be an ambiguity"
                );
            }
        }
    }

    #[test]
    fn an_unmodelled_class_is_conservative_about_pedestrians() {
        let class = RoadClass::Other("corn_maze".to_owned());
        let derived = derive(class.clone(), &[("oneway", "yes")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Indeterminate);
        assert_eq!(codes(&derived), vec![IssueCode::AmbiguousOnewayScope]);

        let derived = derive(class.clone(), &[("oneway", "no")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert!(codes(&derived).is_empty());

        // An explicit pedestrian value still settles it.
        let derived = derive(class, &[("oneway", "yes"), ("oneway:foot", "no")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert!(codes(&derived).is_empty());
    }

    #[test]
    fn a_generic_conditional_reaches_vehicles_but_not_pedestrians() {
        let derived = residential(&[
            ("oneway", "yes"),
            ("oneway:conditional", "-1 @ (Mo-Fr 07:00-09:00)"),
        ]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);
        assert_eq!(
            codes(&derived),
            vec![IssueCode::UnsupportedConditionalOneway]
        );
    }

    #[test]
    fn mode_specific_conditionals_reach_only_their_own_mode() {
        let derived = residential(&[("oneway:motorcar:conditional", "yes @ (Mo-Fr)")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);
        assert_eq!(derived.traversal.foot(), TravelDirection::Both);

        let derived = residential(&[("oneway:motor_vehicle:conditional", "yes @ (Mo-Fr)")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);

        let derived = residential(&[("oneway:bicycle:conditional", "yes @ (Mo-Fr)")]);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Both);

        let derived = residential(&[("oneway:foot:conditional", "yes @ (Mo-Fr)")]);
        assert_eq!(derived.traversal.foot(), TravelDirection::Indeterminate);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Both);
        assert_eq!(derived.traversal.bicycle(), TravelDirection::Both);
    }

    #[test]
    fn a_conditional_outranks_even_an_explicit_mode_value() {
        let derived = residential(&[
            ("oneway:motorcar", "yes"),
            ("oneway:motorcar:conditional", "-1 @ (Su)"),
        ]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Indeterminate);
    }

    #[test]
    fn several_conditional_tags_on_one_way_warn_once() {
        let derived = residential(&[
            ("oneway:conditional", "yes @ (Mo)"),
            ("oneway:motorcar:conditional", "yes @ (Tu)"),
            ("oneway:bicycle:conditional", "yes @ (We)"),
            ("oneway:foot:conditional", "yes @ (Th)"),
        ]);
        assert_eq!(
            codes(&derived),
            vec![IssueCode::UnsupportedConditionalOneway]
        );
        assert_eq!(
            derived.traversal,
            RoadTraversal::uniform(TravelDirection::Indeterminate)
        );
    }

    #[test]
    fn unrelated_conditional_tags_are_not_direction_tags() {
        // Access and speed conditionals are a later milestone's problem.
        let derived = residential(&[
            ("access:conditional", "no @ (Mo-Fr 07:00-09:00)"),
            ("maxspeed:conditional", "30 @ (22:00-06:00)"),
        ]);
        assert_eq!(derived.traversal, RoadTraversal::bidirectional());
        assert!(codes(&derived).is_empty());
    }

    #[test]
    fn a_way_can_earn_every_direction_warning_at_once_and_only_once() {
        let derived = derive(
            RoadClass::Footway,
            &[
                ("oneway", "yes"),
                ("oneway:motorcar", "sometimes"),
                ("oneway:conditional", "-1 @ (Mo-Fr)"),
            ],
        );
        assert_eq!(
            codes(&derived),
            vec![
                IssueCode::UnknownOnewayValue,
                IssueCode::AmbiguousOnewayScope,
                IssueCode::UnsupportedConditionalOneway,
            ]
        );
    }

    #[test]
    fn junction_values_are_trimmed_and_case_insensitive() {
        for value in [" roundabout ", "Roundabout", "ROUNDABOUT"] {
            let derived = derive(RoadClass::Tertiary, &[("junction", value)]);
            assert_eq!(derived.traversal.motorcar(), TravelDirection::Forward);
        }
        // Only roundabouts imply a direction in this milestone.
        let derived = derive(RoadClass::Tertiary, &[("junction", "circular")]);
        assert_eq!(derived.traversal.motorcar(), TravelDirection::Both);
    }
}
