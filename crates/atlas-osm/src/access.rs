//! Turning OSM access tags into Atlas access facts.
//!
//! This is where OSM's `access` vocabulary stops. Everything above this module
//! sees [`RoadAccess`]: three Atlas rules, one per modelled mode, with no tag
//! map and no OSM key names in sight.
//!
//! What this module does *not* do is as important as what it does.
//!
//! * It never answers "may a router send someone down here?". It records what
//!   the source said. Interpreting that against a jurisdiction, a vehicle and
//!   an operator's policy is a routing profile's job, and there is no routing
//!   profile yet.
//! * It never looks at `highway` or at [`atlas_kernel::RoadClass`]. A motorway
//!   is not tagged as barred to pedestrians, it simply usually is; encoding
//!   that here would turn a country's legal default into a source fact, and
//!   nothing downstream could tell the two apart. The signature is the proof:
//!   [`derive_access`] is given tags and nothing else.
//! * It never reads a conditional expression. A key is enough to know that a
//!   conditional applies; the value would only be honestly readable by a time
//!   model Atlas does not have.
//!
//! Two rules shape the derivation itself, and they mirror the direction module
//! deliberately:
//!
//! * **Specificity wins, and an unreadable specific value never falls back.**
//!   If a way says `motorcar=maybe`, the mapper meant to say something about
//!   motorcars, and quietly using the broader `access` instead would be Atlas
//!   inventing an answer the source never gave.
//! * **An absence is [`AccessRule::Unspecified`], never
//!   [`AccessRule::Allowed`].** Silence is not permission. Turning it into one
//!   would make an untagged road indistinguishable from a road somebody
//!   checked and opened.

use atlas_engine::IssueCode;
use atlas_kernel::{AccessRule, RoadAccess};

use crate::model::OsmTags;

/// The general access key, which speaks for every mode at once.
const ACCESS: &str = "access";
/// Broader vehicle keys, from less specific to more specific.
const VEHICLE: &str = "vehicle";
const MOTOR_VEHICLE: &str = "motor_vehicle";
/// The mode-specific keys.
const MOTORCAR: &str = "motorcar";
const BICYCLE: &str = "bicycle";
const FOOT: &str = "foot";

/// Every static access key Atlas reads a *value* from.
///
/// The diagnostic scan walks this list; precedence walks the chains below.
/// The two are separate on purpose — see [`scan_static_tags`].
const VALUED_KEYS: [&str; 6] = [ACCESS, VEHICLE, MOTOR_VEHICLE, MOTORCAR, BICYCLE, FOOT];

/// The conditional sibling of each key above.
const ACCESS_CONDITIONAL: &str = "access:conditional";
const VEHICLE_CONDITIONAL: &str = "vehicle:conditional";
const MOTOR_VEHICLE_CONDITIONAL: &str = "motor_vehicle:conditional";
const MOTORCAR_CONDITIONAL: &str = "motorcar:conditional";
const BICYCLE_CONDITIONAL: &str = "bicycle:conditional";
const FOOT_CONDITIONAL: &str = "foot:conditional";

/// What form a statement takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessForm {
    /// A plain value Atlas reads, for example `access=no`.
    Static,
    /// A conditional expression Atlas detects and refuses to read.
    Conditional,
}

/// Who a key speaks for.
///
/// Only the general [`ACCESS`] key speaks for *everyone*, which is the one
/// place where a mode-specific value such as `designated` cannot mean what it
/// says. Every narrower key — including the broad vehicle keys — carries its
/// value through unexamined, because second-guessing an explicit source fact
/// on a vehicle key is routing policy, and this milestone is not a policy
/// validator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessSubject {
    /// `access`: every mode at once.
    Everyone,
    /// A key naming a vehicle class or a single mode.
    Narrower,
}

/// One key in one mode's precedence chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AccessTagKey {
    key: &'static str,
    form: AccessForm,
    subject: AccessSubject,
}

impl AccessTagKey {
    const fn statement(key: &'static str, subject: AccessSubject) -> Self {
        Self {
            key,
            form: AccessForm::Static,
            subject,
        }
    }

    const fn conditional(key: &'static str) -> Self {
        Self {
            key,
            form: AccessForm::Conditional,
            // A conditional is never read, so who it speaks for never has to
            // be decided.
            subject: AccessSubject::Narrower,
        }
    }
}

/// The motorcar chain, most specific first.
///
/// Within each specificity level the conditional form comes first, so that a
/// conditional beats the plain value beside it. Across levels specificity
/// wins, so a plain `motorcar` beats a `vehicle:conditional`.
const MOTORCAR_CHAIN: [AccessTagKey; 8] = [
    AccessTagKey::conditional(MOTORCAR_CONDITIONAL),
    AccessTagKey::statement(MOTORCAR, AccessSubject::Narrower),
    AccessTagKey::conditional(MOTOR_VEHICLE_CONDITIONAL),
    AccessTagKey::statement(MOTOR_VEHICLE, AccessSubject::Narrower),
    AccessTagKey::conditional(VEHICLE_CONDITIONAL),
    AccessTagKey::statement(VEHICLE, AccessSubject::Narrower),
    AccessTagKey::conditional(ACCESS_CONDITIONAL),
    AccessTagKey::statement(ACCESS, AccessSubject::Everyone),
];

/// The bicycle chain. A bicycle is a vehicle but not a motor vehicle, so the
/// `motor_vehicle` level is simply absent rather than skipped at runtime.
const BICYCLE_CHAIN: [AccessTagKey; 6] = [
    AccessTagKey::conditional(BICYCLE_CONDITIONAL),
    AccessTagKey::statement(BICYCLE, AccessSubject::Narrower),
    AccessTagKey::conditional(VEHICLE_CONDITIONAL),
    AccessTagKey::statement(VEHICLE, AccessSubject::Narrower),
    AccessTagKey::conditional(ACCESS_CONDITIONAL),
    AccessTagKey::statement(ACCESS, AccessSubject::Everyone),
];

/// The foot chain. A pedestrian is not a vehicle, so no vehicle key reaches it.
const FOOT_CHAIN: [AccessTagKey; 4] = [
    AccessTagKey::conditional(FOOT_CONDITIONAL),
    AccessTagKey::statement(FOOT, AccessSubject::Narrower),
    AccessTagKey::conditional(ACCESS_CONDITIONAL),
    AccessTagKey::statement(ACCESS, AccessSubject::Everyone),
];

/// One raw access value, read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccessValue {
    /// A value Atlas recognises, and the rule it states.
    ///
    /// `unknown` is in here, not in [`AccessValue::Unreadable`]: it is a
    /// recognised OSM value whose meaning is "the surveyor could not tell",
    /// which Atlas records faithfully as [`AccessRule::Indeterminate`] with no
    /// warning. A warning would be Atlas complaining about a perfectly correct
    /// statement.
    Recognised(AccessRule),
    /// A value Atlas does not recognise, including a blank one.
    Unreadable,
}

impl AccessValue {
    /// Reads one value, trimming whitespace and ignoring ASCII case.
    ///
    /// The table is exhaustive on purpose. No legacy aliases are folded in:
    /// `public` and `restricted` are not in the list, so they stay unreadable
    /// and visible in the warnings rather than being quietly guessed at.
    fn parse(raw: &str) -> Self {
        let value = raw.trim();
        let is = |candidate: &str| value.eq_ignore_ascii_case(candidate);

        let rule = if is("yes") {
            AccessRule::Allowed
        } else if is("no") {
            AccessRule::Prohibited
        } else if is("designated") {
            AccessRule::Designated
        } else if is("permissive") {
            AccessRule::Permissive
        } else if is("discouraged") {
            AccessRule::Discouraged
        } else if is("destination") {
            AccessRule::DestinationOnly
        } else if is("customers") {
            AccessRule::CustomersOnly
        } else if is("delivery") {
            AccessRule::DeliveryOnly
        } else if is("agricultural") {
            AccessRule::AgriculturalOnly
        } else if is("forestry") {
            AccessRule::ForestryOnly
        } else if is("military") {
            AccessRule::MilitaryOnly
        } else if is("private") {
            AccessRule::Private
        } else if is("permit") {
            AccessRule::PermitRequired
        } else if is("dismount") {
            AccessRule::DismountRequired
        } else if is("use_sidepath") {
            AccessRule::UseSidepath
        } else if is("variable") {
            AccessRule::Variable
        } else if is("unknown") {
            AccessRule::Indeterminate
        } else {
            return AccessValue::Unreadable;
        };

        AccessValue::Recognised(rule)
    }
}

/// Whether a rule only means anything when attached to a specific mode.
///
/// `designated`, `dismount` and `use_sidepath` all name something a particular
/// mode does. On the general `access` key they have no subject: "designated
/// for whom?", "who dismounts?", "which mode uses the sidepath?". Atlas
/// records that it could not tell rather than picking a mode.
fn needs_a_named_mode(rule: AccessRule) -> bool {
    matches!(
        rule,
        AccessRule::Designated | AccessRule::DismountRequired | AccessRule::UseSidepath
    )
}

/// What the first applicable key in a chain resolved to.
///
/// This is a *result*, not a report. Whether the source was sound is decided
/// separately by [`scan_static_tags`]; the variants below exist only because
/// an unreadable value and an out-of-scope one reach
/// [`AccessRule::Indeterminate`] by different routes, and keeping them apart
/// makes the resolution readable where it is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resolution {
    /// A rule the source stated and Atlas could read.
    Stated(AccessRule),
    /// A conditional key applied, so the rule is dynamic and unread.
    Conditional,
    /// The value was blank or is not in the recognised table.
    Unreadable,
    /// The value was recognised but cannot mean what it says on this key.
    OutOfScope,
}

impl Resolution {
    /// The Atlas rule this resolution states.
    fn rule(self) -> AccessRule {
        match self {
            Resolution::Stated(rule) => rule,
            Resolution::Conditional => AccessRule::Conditional,
            // Both remaining cases are Atlas declining to guess.
            Resolution::Unreadable | Resolution::OutOfScope => AccessRule::Indeterminate,
        }
    }

    /// Whether this resolution is a conditional Atlas declined to evaluate.
    ///
    /// The one diagnostic precedence gets a say in, because it is the one that
    /// is about Atlas rather than about the file.
    fn is_unevaluated_conditional(self) -> bool {
        matches!(self, Resolution::Conditional)
    }
}

/// Which warnings one way's access tags earned.
///
/// Flags rather than a list: each problem is reported once per way, however
/// many tags contributed to it, so the counts stay counts of roads.
///
/// The three flags are raised by two different passes, and the split is the
/// point:
///
/// * `unknown_value` and `invalid_scope` come from [`scan_static_tags`], which
///   reads every static access key the way carries **regardless of
///   precedence**. They are findings about the *source data*. A broken
///   `access=bogus` is broken whether or not a more specific tag happens to
///   out-rank it, and a diagnostic that went quiet the moment something
///   shadowed the mistake would hide exactly the mistakes a mapper most needs
///   to find.
/// * `unsupported_conditional` comes from the precedence walk, and is raised
///   only when a conditional key is actually selected for some mode. That one
///   is not a finding about the file at all — the tag is perfectly valid — it
///   is a statement about a limitation of Atlas, and Atlas is only limited by
///   a condition that reaches the answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AccessIssues {
    unknown_value: bool,
    invalid_scope: bool,
    unsupported_conditional: bool,
}

impl AccessIssues {
    /// The codes to record, in a fixed order.
    pub(crate) fn codes(self) -> impl Iterator<Item = IssueCode> {
        [
            self.unknown_value.then_some(IssueCode::UnknownAccessValue),
            self.invalid_scope.then_some(IssueCode::InvalidAccessScope),
            self.unsupported_conditional
                .then_some(IssueCode::UnsupportedConditionalAccess),
        ]
        .into_iter()
        .flatten()
    }
}

/// The access facts of one way, plus the warnings deriving them produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DerivedAccess {
    pub(crate) access: RoadAccess,
    pub(crate) issues: AccessIssues,
}

/// Derives the access facts of one way for every modelled mode.
///
/// Takes tags and nothing else. There is deliberately no `class` parameter and
/// no `highway` lookup: access that Atlas did not read from an access tag is
/// access Atlas did not read.
pub(crate) fn derive_access(tags: &OsmTags) -> DerivedAccess {
    // Two passes, two concerns. The scan reports what is wrong with the
    // source; the chains decide what the source says. Neither can change the
    // other's answer: a shadowed mistake is still reported, and reporting it
    // never moves a derived rule.
    let mut issues = scan_static_tags(tags);

    let motorcar = resolve(tags, &MOTORCAR_CHAIN, &mut issues);
    let bicycle = resolve(tags, &BICYCLE_CHAIN, &mut issues);
    let foot = resolve(tags, &FOOT_CHAIN, &mut issues);

    DerivedAccess {
        access: RoadAccess::new(motorcar, bicycle, foot),
        issues,
    }
}

/// Reports what is wrong with a way's static access tags, precedence aside.
///
/// Walks every key in [`VALUED_KEYS`] that the way carries and asks two
/// questions of each: could Atlas read the value, and could the value mean
/// what it says on that key? Both are properties of the tag itself, so
/// neither depends on which tag precedence went on to choose.
///
/// This deliberately does not look at the conditional keys. Their values are
/// never read, so there is nothing about them to find wrong.
fn scan_static_tags(tags: &OsmTags) -> AccessIssues {
    let mut issues = AccessIssues::default();

    for key in VALUED_KEYS {
        let Some(raw) = tags.get(key) else { continue };
        match AccessValue::parse(raw) {
            AccessValue::Unreadable => issues.unknown_value = true,
            // Only the general key has no subject to attach a mode-specific
            // value to. A narrower key names one, so its value stands.
            AccessValue::Recognised(rule) if key == ACCESS && needs_a_named_mode(rule) => {
                issues.invalid_scope = true;
            }
            AccessValue::Recognised(_) => {}
        }
    }

    issues
}

/// Walks one mode's chain and stops at the first key the way actually carries.
///
/// Stopping is the whole point. Once an applicable key has been found, no
/// broader key is consulted — not even when the value found was one Atlas
/// could not use. Falling through to a broader tag after an unreadable
/// specific one would replace a mapper's explicit statement about this mode
/// with a statement they made about something else.
fn resolve(tags: &OsmTags, chain: &[AccessTagKey], issues: &mut AccessIssues) -> AccessRule {
    for candidate in chain {
        let Some(raw) = tags.get(candidate.key) else {
            continue;
        };

        let resolution = match candidate.form {
            // Detection is by key. The expression is never read, so a blank
            // or unparseable one changes nothing: Atlas already knows all it
            // is willing to claim.
            AccessForm::Conditional => Resolution::Conditional,
            AccessForm::Static => match AccessValue::parse(raw) {
                AccessValue::Unreadable => Resolution::Unreadable,
                AccessValue::Recognised(rule)
                    if candidate.subject == AccessSubject::Everyone && needs_a_named_mode(rule) =>
                {
                    Resolution::OutOfScope
                }
                AccessValue::Recognised(rule) => Resolution::Stated(rule),
            },
        };

        // The only diagnostic precedence decides. Everything else about the
        // source was already settled by `scan_static_tags`.
        if resolution.is_unevaluated_conditional() {
            issues.unsupported_conditional = true;
        }
        return resolution.rule();
    }

    // No applicable tag at all. Not permission, not prohibition: silence.
    AccessRule::Unspecified
}

#[cfg(test)]
mod tests {
    use super::*;

    use AccessRule::{
        AgriculturalOnly, Allowed, Conditional, CustomersOnly, DeliveryOnly, Designated,
        DestinationOnly, Discouraged, DismountRequired, ForestryOnly, Indeterminate, MilitaryOnly,
        Permissive, PermitRequired, Private, Prohibited, Unspecified, UseSidepath, Variable,
    };

    const A_CONDITION: &str = "no @ (Mo-Fr 07:00-09:00)";

    fn tags(pairs: &[(&str, &str)]) -> OsmTags {
        let mut tags = OsmTags::default();
        for (key, value) in pairs {
            tags.insert((*key).to_owned(), (*value).to_owned());
        }
        tags
    }

    fn derive(pairs: &[(&str, &str)]) -> DerivedAccess {
        derive_access(&tags(pairs))
    }

    /// The three rules of one derivation, as motorcar / bicycle / foot.
    fn rules(pairs: &[(&str, &str)]) -> (AccessRule, AccessRule, AccessRule) {
        let derived = derive(pairs);
        (
            derived.access.motorcar(),
            derived.access.bicycle(),
            derived.access.foot(),
        )
    }

    fn codes(pairs: &[(&str, &str)]) -> Vec<IssueCode> {
        derive(pairs).issues.codes().collect()
    }

    // -- the value table --------------------------------------------------

    #[test]
    fn every_recognised_static_value_maps_to_its_documented_rule() {
        let table = [
            ("yes", Allowed),
            ("no", Prohibited),
            ("designated", Designated),
            ("permissive", Permissive),
            ("discouraged", Discouraged),
            ("destination", DestinationOnly),
            ("customers", CustomersOnly),
            ("delivery", DeliveryOnly),
            ("agricultural", AgriculturalOnly),
            ("forestry", ForestryOnly),
            ("military", MilitaryOnly),
            ("private", Private),
            ("permit", PermitRequired),
            ("dismount", DismountRequired),
            ("use_sidepath", UseSidepath),
            ("variable", Variable),
            ("unknown", Indeterminate),
        ];
        // Read on a mode-specific key, where every value is in scope.
        for (value, expected) in table {
            let pairs = [("bicycle", value)];
            assert_eq!(
                derive(&pairs).access.bicycle(),
                expected,
                "bicycle={value} read wrongly"
            );
            assert!(
                codes(&pairs).is_empty(),
                "bicycle={value} must not warn: {:?}",
                codes(&pairs)
            );
        }
        // Every rule the table can produce, and nothing left over.
        let produced: std::collections::BTreeSet<AccessRule> =
            table.iter().map(|(_, rule)| *rule).collect();
        assert_eq!(produced.len(), 17);
        assert!(!produced.contains(&Unspecified));
        assert!(!produced.contains(&Conditional));
    }

    #[test]
    fn values_are_trimmed_and_ascii_case_folded() {
        for value in ["  no  ", "NO", "No", "\tnO\n"] {
            assert_eq!(derive(&[("access", value)]).access.motorcar(), Prohibited);
            assert!(codes(&[("access", value)]).is_empty());
        }
        for (value, expected) in [
            (" Destination ", DestinationOnly),
            ("USE_SIDEPATH", UseSidepath),
            ("Permissive", Permissive),
            ("\tPRIVATE ", Private),
        ] {
            assert_eq!(derive(&[("motorcar", value)]).access.motorcar(), expected);
            assert!(codes(&[("motorcar", value)]).is_empty());
        }
    }

    #[test]
    fn unknown_is_a_recognised_value_and_never_warns() {
        // `access=unknown` is a surveyor saying they could not tell. Atlas
        // records exactly that and does not complain about it.
        assert_eq!(
            rules(&[("access", "unknown")]),
            (Indeterminate, Indeterminate, Indeterminate)
        );
        assert!(codes(&[("access", "unknown")]).is_empty());
        assert_eq!(derive(&[("foot", "UNKNOWN")]).access.foot(), Indeterminate);
        assert!(codes(&[("foot", "unknown")]).is_empty());
    }

    #[test]
    fn a_truly_unknown_or_blank_value_is_indeterminate_and_warns() {
        for value in ["maybe", "sometimes", "", "   ", "yes;no", "1", "true"] {
            let pairs = [("motorcar", value)];
            assert_eq!(
                derive(&pairs).access.motorcar(),
                Indeterminate,
                "motorcar={value:?}"
            );
            assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
        }
    }

    #[test]
    fn legacy_aliases_are_not_quietly_invented() {
        // `public` and `restricted` appear in the wild and mean different
        // things to different people. Atlas refuses to pick one and says so.
        for value in ["public", "restricted", "official", "destination_only"] {
            let pairs = [("access", value)];
            assert_eq!(
                rules(&pairs),
                (Indeterminate, Indeterminate, Indeterminate),
                "access={value}"
            );
            assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
        }
    }

    // -- absence ----------------------------------------------------------

    #[test]
    fn no_access_tag_at_all_is_unspecified_for_every_mode() {
        assert_eq!(rules(&[]), (Unspecified, Unspecified, Unspecified));
        assert!(codes(&[]).is_empty());
        // And an unrelated tag is still no access tag.
        assert_eq!(
            rules(&[
                ("name", "Quiet Lane"),
                ("oneway", "yes"),
                ("surface", "asphalt")
            ]),
            (Unspecified, Unspecified, Unspecified)
        );
    }

    #[test]
    fn unspecified_is_not_allowed() {
        // The distinction this whole milestone exists for.
        assert_ne!(derive(&[]).access.motorcar(), Allowed);
        assert_eq!(derive(&[]).access.motorcar(), Unspecified);
        assert_eq!(derive(&[("access", "yes")]).access.motorcar(), Allowed);
    }

    // -- hierarchy --------------------------------------------------------

    #[test]
    fn the_general_access_key_reaches_every_mode() {
        assert_eq!(
            rules(&[("access", "no")]),
            (Prohibited, Prohibited, Prohibited)
        );
        assert_eq!(rules(&[("access", "yes")]), (Allowed, Allowed, Allowed));
        assert_eq!(
            rules(&[("access", "customers")]),
            (CustomersOnly, CustomersOnly, CustomersOnly)
        );
    }

    #[test]
    fn the_vehicle_key_reaches_wheels_but_not_feet() {
        assert_eq!(
            rules(&[("vehicle", "no")]),
            (Prohibited, Prohibited, Unspecified)
        );
        assert_eq!(
            rules(&[("vehicle", "permissive")]),
            (Permissive, Permissive, Unspecified)
        );
    }

    #[test]
    fn the_motor_vehicle_key_reaches_only_the_motorcar() {
        assert_eq!(
            rules(&[("motor_vehicle", "destination")]),
            (DestinationOnly, Unspecified, Unspecified)
        );
        assert_eq!(
            rules(&[("motor_vehicle", "delivery")]),
            (DeliveryOnly, Unspecified, Unspecified)
        );
    }

    #[test]
    fn each_mode_specific_key_reaches_only_its_own_mode() {
        assert_eq!(
            rules(&[("motorcar", "permit")]),
            (PermitRequired, Unspecified, Unspecified)
        );
        assert_eq!(
            rules(&[("bicycle", "designated")]),
            (Unspecified, Designated, Unspecified)
        );
        assert_eq!(
            rules(&[("foot", "permissive")]),
            (Unspecified, Unspecified, Permissive)
        );
    }

    #[test]
    fn a_more_specific_static_key_overrides_a_broader_one() {
        assert_eq!(
            rules(&[("access", "no"), ("foot", "yes")]),
            (Prohibited, Prohibited, Allowed)
        );
        assert_eq!(
            rules(&[("vehicle", "no"), ("bicycle", "yes")]),
            (Prohibited, Allowed, Unspecified)
        );
        assert_eq!(
            rules(&[
                ("access", "yes"),
                ("vehicle", "permissive"),
                ("motorcar", "private"),
            ]),
            (Private, Permissive, Allowed)
        );
    }

    #[test]
    fn every_level_of_the_motorcar_chain_is_reachable_in_order() {
        // Peel the chain off one level at a time: each removal must expose
        // exactly the next level down, never skip one.
        let all = [
            ("motorcar:conditional", A_CONDITION),
            ("motorcar", "private"),
            ("motor_vehicle:conditional", A_CONDITION),
            ("motor_vehicle", "destination"),
            ("vehicle:conditional", A_CONDITION),
            ("vehicle", "permissive"),
            ("access:conditional", A_CONDITION),
            ("access", "yes"),
        ];
        let expected = [
            Conditional,
            Private,
            Conditional,
            DestinationOnly,
            Conditional,
            Permissive,
            Conditional,
            Allowed,
            Unspecified,
        ];
        for (peeled, rule) in expected.into_iter().enumerate() {
            let remaining = &all[peeled..];
            assert_eq!(
                derive(remaining).access.motorcar(),
                rule,
                "after removing {peeled} level(s) the motorcar chain landed wrongly"
            );
        }
    }

    #[test]
    fn every_level_of_the_bicycle_chain_is_reachable_in_order() {
        let all = [
            ("bicycle:conditional", A_CONDITION),
            ("bicycle", "designated"),
            ("vehicle:conditional", A_CONDITION),
            ("vehicle", "permissive"),
            ("access:conditional", A_CONDITION),
            ("access", "yes"),
        ];
        let expected = [
            Conditional,
            Designated,
            Conditional,
            Permissive,
            Conditional,
            Allowed,
            Unspecified,
        ];
        for (peeled, rule) in expected.into_iter().enumerate() {
            assert_eq!(
                derive(&all[peeled..]).access.bicycle(),
                rule,
                "peeled {peeled}"
            );
        }
    }

    #[test]
    fn every_level_of_the_foot_chain_is_reachable_in_order() {
        let all = [
            ("foot:conditional", A_CONDITION),
            ("foot", "discouraged"),
            ("access:conditional", A_CONDITION),
            ("access", "yes"),
        ];
        let expected = [Conditional, Discouraged, Conditional, Allowed, Unspecified];
        for (peeled, rule) in expected.into_iter().enumerate() {
            assert_eq!(
                derive(&all[peeled..]).access.foot(),
                rule,
                "peeled {peeled}"
            );
        }
    }

    #[test]
    fn no_vehicle_key_ever_reaches_a_pedestrian() {
        for key in ["vehicle", "motor_vehicle", "motorcar", "bicycle"] {
            assert_eq!(
                derive(&[(key, "no")]).access.foot(),
                Unspecified,
                "{key} must not reach foot"
            );
        }
        for key in ["vehicle:conditional", "motor_vehicle:conditional"] {
            assert_eq!(
                derive(&[(key, A_CONDITION)]).access.foot(),
                Unspecified,
                "{key} must not reach foot"
            );
        }
    }

    #[test]
    fn no_motor_key_ever_reaches_a_bicycle() {
        for key in ["motor_vehicle", "motorcar"] {
            assert_eq!(
                derive(&[(key, "no")]).access.bicycle(),
                Unspecified,
                "{key} must not reach bicycle"
            );
        }
        assert_eq!(
            derive(&[("motorcar:conditional", A_CONDITION)])
                .access
                .bicycle(),
            Unspecified
        );
    }

    // -- conditional precedence -------------------------------------------

    #[test]
    fn a_conditional_beats_the_static_value_at_the_same_level() {
        assert_eq!(
            rules(&[("motorcar", "yes"), ("motorcar:conditional", A_CONDITION)]),
            (Conditional, Unspecified, Unspecified)
        );
        assert_eq!(
            rules(&[("access", "yes"), ("access:conditional", A_CONDITION)]),
            (Conditional, Conditional, Conditional)
        );
        assert_eq!(
            rules(&[("vehicle", "yes"), ("vehicle:conditional", A_CONDITION)]),
            (Conditional, Conditional, Unspecified)
        );
    }

    #[test]
    fn a_more_specific_static_value_beats_a_broader_conditional() {
        // The static `motorcar` is more specific than `vehicle:conditional`,
        // so specificity wins over form across levels.
        assert_eq!(
            rules(&[("vehicle:conditional", A_CONDITION), ("motorcar", "yes")]),
            (Allowed, Conditional, Unspecified)
        );
        assert_eq!(
            rules(&[("access:conditional", A_CONDITION), ("foot", "yes")]),
            (Conditional, Conditional, Allowed)
        );
        assert_eq!(
            rules(&[
                ("access:conditional", A_CONDITION),
                ("motorcar", "no"),
                ("bicycle", "designated"),
                ("foot", "yes"),
            ]),
            (Prohibited, Designated, Allowed)
        );
    }

    #[test]
    fn a_conditional_is_detected_by_key_and_its_value_is_never_read() {
        // Nothing about the expression changes the answer, including an
        // expression that looks like a plain value.
        for expression in [
            A_CONDITION,
            "yes @ (Sa-Su)",
            "no @ (weight>7.5)",
            "destination @ (2026 Jan 01-2026 Dec 31)",
            "yes",
            "no",
            "",
            "   ",
            "not an expression at all",
        ] {
            let pairs = [("access:conditional", expression)];
            assert_eq!(
                rules(&pairs),
                (Conditional, Conditional, Conditional),
                "access:conditional={expression:?}"
            );
            assert_eq!(codes(&pairs), vec![IssueCode::UnsupportedConditionalAccess]);
        }
    }

    #[test]
    fn every_recognised_conditional_key_is_detected() {
        let cases = [
            (
                "access:conditional",
                (Conditional, Conditional, Conditional),
            ),
            (
                "vehicle:conditional",
                (Conditional, Conditional, Unspecified),
            ),
            (
                "motor_vehicle:conditional",
                (Conditional, Unspecified, Unspecified),
            ),
            (
                "motorcar:conditional",
                (Conditional, Unspecified, Unspecified),
            ),
            (
                "bicycle:conditional",
                (Unspecified, Conditional, Unspecified),
            ),
            ("foot:conditional", (Unspecified, Unspecified, Conditional)),
        ];
        for (key, expected) in cases {
            let pairs = [(key, A_CONDITION)];
            assert_eq!(rules(&pairs), expected, "{key}");
            assert_eq!(
                codes(&pairs),
                vec![IssueCode::UnsupportedConditionalAccess],
                "{key}"
            );
        }
    }

    #[test]
    fn a_conditional_never_reads_as_a_plain_yes_or_no() {
        for expression in ["yes @ (Mo-Su)", "no @ (Mo-Su)"] {
            let derived = derive(&[("access:conditional", expression)]);
            for rule in [
                derived.access.motorcar(),
                derived.access.bicycle(),
                derived.access.foot(),
            ] {
                assert_eq!(rule, Conditional);
                assert_ne!(rule, Allowed);
                assert_ne!(rule, Prohibited);
            }
        }
    }

    #[test]
    fn a_conditional_shadowed_for_every_mode_changes_nothing() {
        // `access:conditional` is out-ranked for all three modes, so it
        // decided nothing and earns no warning.
        let pairs = [
            ("access:conditional", A_CONDITION),
            ("motorcar", "private"),
            ("bicycle", "designated"),
            ("foot", "yes"),
        ];
        assert_eq!(rules(&pairs), (Private, Designated, Allowed));
        assert!(codes(&pairs).is_empty(), "{:?}", codes(&pairs));
    }

    // -- unreadable values never fall back --------------------------------

    #[test]
    fn an_unreadable_specific_value_never_falls_back_to_a_broader_tag() {
        // The broader tags are perfectly readable and are deliberately not
        // used: the mapper said something about motorcars specifically.
        let pairs = [
            ("access", "yes"),
            ("vehicle", "permissive"),
            ("motor_vehicle", "destination"),
            ("motorcar", "maybe"),
        ];
        assert_eq!(derive(&pairs).access.motorcar(), Indeterminate);
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
        // The other modes are unaffected: they never consult `motorcar`.
        assert_eq!(derive(&pairs).access.bicycle(), Permissive);
        assert_eq!(derive(&pairs).access.foot(), Allowed);
    }

    #[test]
    fn an_unreadable_broad_value_never_falls_back_either() {
        let pairs = [("access", "yes"), ("vehicle", "wat")];
        assert_eq!(rules(&pairs), (Indeterminate, Indeterminate, Allowed));
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
    }

    #[test]
    fn an_unreadable_value_stops_the_chain_rather_than_skipping_a_level() {
        // `motor_vehicle` is unreadable, so the motorcar answer is
        // indeterminate even though `vehicle` below it is fine.
        let pairs = [("vehicle", "no"), ("motor_vehicle", "somehow")];
        assert_eq!(rules(&pairs), (Indeterminate, Prohibited, Unspecified));
    }

    // -- invalid scope ----------------------------------------------------

    #[test]
    fn a_mode_only_value_on_the_general_key_is_indeterminate() {
        for value in ["designated", "dismount", "use_sidepath"] {
            let pairs = [("access", value)];
            assert_eq!(
                rules(&pairs),
                (Indeterminate, Indeterminate, Indeterminate),
                "access={value}"
            );
            assert_eq!(
                codes(&pairs),
                vec![IssueCode::InvalidAccessScope],
                "{value}"
            );
        }
    }

    #[test]
    fn a_more_specific_override_still_wins_over_an_invalid_general_value() {
        let pairs = [("access", "designated"), ("bicycle", "yes")];
        assert_eq!(rules(&pairs), (Indeterminate, Allowed, Indeterminate));
        // Motorcar and foot still reached the general key, so the scope
        // problem is real and is reported once for the road.
        assert_eq!(codes(&pairs), vec![IssueCode::InvalidAccessScope]);
    }

    #[test]
    fn mode_specific_designated_dismount_and_use_sidepath_are_perfectly_valid() {
        for value in ["designated", "dismount", "use_sidepath"] {
            let pairs = [("bicycle", value)];
            assert!(
                codes(&pairs).is_empty(),
                "bicycle={value} must not warn: {:?}",
                codes(&pairs)
            );
            assert_ne!(derive(&pairs).access.bicycle(), Indeterminate);
        }
        assert_eq!(
            derive(&[("bicycle", "dismount")]).access.bicycle(),
            DismountRequired
        );
        assert_eq!(
            derive(&[("bicycle", "use_sidepath")]).access.bicycle(),
            UseSidepath
        );
        assert_eq!(derive(&[("foot", "designated")]).access.foot(), Designated);
    }

    #[test]
    fn an_unusual_value_on_a_broad_vehicle_key_is_preserved_not_policed() {
        // `vehicle=designated` is odd but it is an explicit source fact, and
        // deciding it is wrong would be routing policy. Atlas records it.
        let pairs = [("vehicle", "designated")];
        assert_eq!(rules(&pairs), (Designated, Designated, Unspecified));
        assert!(codes(&pairs).is_empty());
        assert_eq!(
            derive(&[("motor_vehicle", "dismount")]).access.motorcar(),
            DismountRequired
        );
        assert!(codes(&[("motor_vehicle", "dismount")]).is_empty());
    }

    // -- diagnostics are not precedence -----------------------------------

    #[test]
    fn a_shadowed_unknown_general_value_still_warns() {
        // Precedence decides the derived rule. It does not decide whether the
        // source is sound. A broken `access` value that every mode happens to
        // out-rank is still a broken value in the file, and a data-quality
        // report that stayed silent about it would be useless for the one job
        // it has: telling a mapper what to go and fix.
        let pairs = [
            ("access", "bogus"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        assert_eq!(rules(&pairs), (Allowed, Allowed, Allowed));
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
    }

    #[test]
    fn a_shadowed_invalid_general_scope_still_warns() {
        // Same rule for a value that cannot mean what it says where it was
        // written. The three overrides answer every mode, so the derived
        // result is untouched — and `access=designated` is still a tagging
        // mistake worth reporting.
        let pairs = [
            ("access", "designated"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        assert_eq!(rules(&pairs), (Allowed, Allowed, Allowed));
        assert_eq!(codes(&pairs), vec![IssueCode::InvalidAccessScope]);
    }

    #[test]
    fn several_unreadable_static_keys_warn_once_for_the_road() {
        // Four broken values across four keys, two of them shadowed. One
        // warning, and the derived rules still follow precedence exactly.
        let pairs = [
            ("access", "bogus"),
            ("vehicle", "nonsense"),
            ("motor_vehicle", "whatever"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
        ];
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);
        assert_eq!(
            rules(&pairs),
            // motorcar reads its own key; bicycle reads its own key; foot
            // falls through to the unreadable `access`.
            (Allowed, Allowed, Indeterminate)
        );
    }

    #[test]
    fn a_shadowed_diagnostic_never_changes_a_derived_rule() {
        // The clearest statement of the split: adding a broken or misplaced
        // tag below the one precedence lands on changes the warnings and
        // nothing else.
        let clean = [("motorcar", "private"), ("bicycle", "yes"), ("foot", "yes")];
        let with_noise = [
            ("access", "bogus"),
            ("motorcar", "private"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        let with_scope_error = [
            ("access", "use_sidepath"),
            ("motorcar", "private"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        assert_eq!(derive(&clean).access, derive(&with_noise).access);
        assert_eq!(derive(&clean).access, derive(&with_scope_error).access);
        assert!(codes(&clean).is_empty());
        assert_eq!(codes(&with_noise), vec![IssueCode::UnknownAccessValue]);
        assert_eq!(
            codes(&with_scope_error),
            vec![IssueCode::InvalidAccessScope]
        );
    }

    #[test]
    fn a_recognised_unknown_value_warns_in_no_position() {
        // `unknown` is sound data wherever it sits, shadowed or not.
        let alone = [("access", "unknown")];
        assert_eq!(rules(&alone), (Indeterminate, Indeterminate, Indeterminate));
        assert!(codes(&alone).is_empty());

        let shadowed = [
            ("access", "unknown"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        assert_eq!(rules(&shadowed), (Allowed, Allowed, Allowed));
        assert!(codes(&shadowed).is_empty());
    }

    #[test]
    fn a_fully_shadowed_conditional_produces_neither_a_rule_nor_a_warning() {
        // The deliberate asymmetry. A malformed value is a fact about the
        // file; a conditional is a limitation of Atlas, and a conditional that
        // decided nothing limited nothing.
        let pairs = [
            ("access:conditional", "no @ (Mo-Fr 08:00-18:00)"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
            ("foot", "yes"),
        ];
        assert_eq!(rules(&pairs), (Allowed, Allowed, Allowed));
        assert!(codes(&pairs).is_empty(), "{:?}", codes(&pairs));
    }

    #[test]
    fn a_selected_conditional_still_derives_conditional_and_warns_once() {
        // The control case for the asymmetry above: the moment a conditional
        // reaches even one mode, it shapes the result and is reported.
        let pairs = [
            ("access:conditional", "no @ (Mo-Fr 08:00-18:00)"),
            ("motorcar", "yes"),
            ("bicycle", "yes"),
        ];
        assert_eq!(rules(&pairs), (Allowed, Allowed, Conditional));
        assert_eq!(codes(&pairs), vec![IssueCode::UnsupportedConditionalAccess]);

        // And when it reaches all three, still exactly one warning.
        let broad = [("access:conditional", "no @ (Mo-Fr 08:00-18:00)")];
        assert_eq!(rules(&broad), (Conditional, Conditional, Conditional));
        assert_eq!(codes(&broad), vec![IssueCode::UnsupportedConditionalAccess]);
    }

    // -- warnings ---------------------------------------------------------

    #[test]
    fn each_code_is_raised_at_most_once_per_road() {
        // Three unreadable values, one conditional key reaching three modes,
        // and a scope problem reaching two: still one warning each.
        let pairs = [
            ("motorcar", "maybe"),
            ("bicycle", "perhaps"),
            ("foot", "possibly"),
        ];
        assert_eq!(codes(&pairs), vec![IssueCode::UnknownAccessValue]);

        let pairs = [("access:conditional", A_CONDITION)];
        assert_eq!(codes(&pairs), vec![IssueCode::UnsupportedConditionalAccess]);

        let pairs = [("access", "dismount")];
        assert_eq!(codes(&pairs), vec![IssueCode::InvalidAccessScope]);
    }

    #[test]
    fn codes_come_out_in_a_fixed_order_whatever_the_tags_are() {
        let pairs = [
            ("access", "use_sidepath"),
            ("bicycle:conditional", A_CONDITION),
            ("motorcar", "maybe"),
        ];
        assert_eq!(
            codes(&pairs),
            vec![
                IssueCode::UnknownAccessValue,
                IssueCode::InvalidAccessScope,
                IssueCode::UnsupportedConditionalAccess,
            ]
        );
        // Tag order in the file cannot change the warning order.
        let reordered = [
            ("motorcar", "maybe"),
            ("access", "use_sidepath"),
            ("bicycle:conditional", A_CONDITION),
        ];
        assert_eq!(codes(&reordered), codes(&pairs));
    }

    #[test]
    fn a_clean_road_earns_no_warnings_at_all() {
        for pairs in [
            vec![],
            vec![("access", "yes")],
            vec![("access", "no"), ("foot", "yes")],
            vec![("bicycle", "designated")],
            vec![("access", "unknown")],
            vec![("access", "variable")],
        ] {
            assert!(
                codes(&pairs).is_empty(),
                "{pairs:?} warned: {:?}",
                codes(&pairs)
            );
        }
    }

    // -- what access is not -----------------------------------------------

    #[test]
    fn access_is_never_derived_from_the_highway_class() {
        // The classification is not an input here, and a `highway` tag in the
        // tag map changes nothing. Every one of these is silent about access.
        for highway in [
            "motorway",
            "footway",
            "cycleway",
            "service",
            "track",
            "steps",
            "corn_maze",
        ] {
            assert_eq!(
                rules(&[("highway", highway)]),
                (Unspecified, Unspecified, Unspecified),
                "highway={highway} must not imply access"
            );
            assert!(codes(&[("highway", highway)]).is_empty());
        }
        // A motorway with an explicit bicycle permission keeps it, because the
        // only thing Atlas reads is the access tag.
        assert_eq!(
            derive(&[("highway", "motorway"), ("bicycle", "yes")])
                .access
                .bicycle(),
            Allowed
        );
    }

    #[test]
    fn direction_tags_are_not_access_tags() {
        // A one-way statement says nothing about who may use the road, and a
        // barrier or a speed limit is not read at all.
        for pairs in [
            vec![("oneway", "yes")],
            vec![("oneway", "-1"), ("oneway:bicycle", "no")],
            vec![("junction", "roundabout")],
            vec![("maxspeed", "30")],
            vec![("barrier", "gate")],
        ] {
            assert_eq!(
                rules(&pairs),
                (Unspecified, Unspecified, Unspecified),
                "{pairs:?} must not imply access"
            );
        }
    }

    #[test]
    fn unrelated_access_family_keys_are_not_read() {
        // These are real OSM keys that Atlas deliberately does not model in
        // this milestone. Reading one by accident would be worse than not
        // reading it, because the road would look as though it had been
        // surveyed for access when it had not.
        for key in [
            "access:lanes",
            "access:forward",
            "access:backward",
            "motorcar:forward",
            "hgv",
            "psv",
            "bus",
            "horse",
            "motorcycle",
            "maxweight",
            "maxheight",
            "bicycle:lanes",
        ] {
            assert_eq!(
                rules(&[(key, "no")]),
                (Unspecified, Unspecified, Unspecified),
                "{key} must not be read"
            );
            assert!(codes(&[(key, "no")]).is_empty(), "{key} must not warn");
        }
    }

    #[test]
    fn derivation_reads_tags_and_nothing_else() {
        // Two ways with identical access tags derive identical access, no
        // matter what else they carry. This is the property that makes access
        // a source fact rather than a guess about a kind of road.
        let bare = derive(&[("access", "destination")]);
        let dressed = derive(&[
            ("access", "destination"),
            ("highway", "motorway"),
            ("oneway", "yes"),
            ("junction", "roundabout"),
            ("name", "Somewhere"),
            ("surface", "gravel"),
        ]);
        assert_eq!(bare, dressed);
    }
}
