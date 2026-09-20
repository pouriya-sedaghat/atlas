//! What the source says about who may use a road.
//!
//! These are Atlas's own semantics for access, derived by an input adapter
//! from whatever the source format happens to call things. As with direction,
//! the kernel must not learn what an OSM `access` tag is, only what an access
//! fact means.
//!
//! Three things shape this module.
//!
//! **Access is not direction.** A forward one-way road may bar motorcars; a
//! two-way road may be private; a bicycle-designated way still has a direction
//! of its own. The two are recorded side by side in
//! [`crate::FeatureKind::Road`] and neither is derived from the other.
//!
//! **Access is not a boolean.** "May a car use this road?" has far more than
//! two answers in the wild: not stated, allowed, designated, permitted by the
//! owner, destination traffic only, forestry only, permit holders only,
//! prohibited, and several that change with the time of day. Collapsing that
//! into a `bool` would throw away exactly the distinctions a routing profile
//! later needs to make.
//!
//! **Access is not yet policy.** Nothing here answers "can a router use this
//! road?". [`AccessRule`] records a source-derived fact; whether that fact
//! permits a given journey depends on jurisdiction, vehicle properties and
//! operator policy, all of which belong to a routing profile that does not
//! exist yet.

use std::fmt;

use crate::traversal::TravelMode;

/// What the source says about one mode's access to a road.
///
/// Every variant is a fact Atlas read, or an honest statement that it could
/// not read one. None of them is a routing decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AccessRule {
    /// No applicable explicit access information was present.
    ///
    /// This is neither permission nor prohibition. It is the absence of a
    /// statement, and it is deliberately distinct from [`AccessRule::Allowed`]:
    /// a road nobody tagged is not the same as a road somebody tagged as open.
    Unspecified,
    /// The source explicitly allows the mode.
    Allowed,
    /// The way is legally or officially designated for the mode.
    Designated,
    /// Permitted by the owner, and potentially revocable.
    Permissive,
    /// Legal access exists but the source discourages using it.
    Discouraged,
    /// Access is limited to traffic whose destination is on the way.
    DestinationOnly,
    /// Access is limited to customers of whatever the way serves.
    CustomersOnly,
    /// Access is limited to deliveries.
    DeliveryOnly,
    /// Access is limited to agricultural traffic.
    AgriculturalOnly,
    /// Access is limited to forestry traffic.
    ForestryOnly,
    /// Access is limited to military traffic.
    MilitaryOnly,
    /// An explicit private access restriction.
    Private,
    /// Access requires a permit.
    PermitRequired,
    /// The mode must be dismounted or handled as the source restriction says.
    DismountRequired,
    /// The mode is expected or required to use a separate parallel path.
    UseSidepath,
    /// An explicit no-access fact.
    Prohibited,
    /// The source explicitly declares access to be variable.
    Variable,
    /// Access depends on a condition Atlas detected but does not evaluate.
    ///
    /// Atlas knows a conditional statement applies and deliberately does not
    /// read it. Guessing at whichever branch looked plausible would record a
    /// Tuesday-morning restriction as a permanent fact.
    Conditional,
    /// Atlas saw access information but cannot derive a trustworthy rule.
    ///
    /// A refusal to guess, not a default. It is what Atlas records when the
    /// source says something it cannot read, or says something in a place
    /// where it cannot mean what it says.
    Indeterminate,
}

impl AccessRule {
    /// Every rule Atlas models, in a stable order.
    pub const ALL: [AccessRule; 19] = [
        AccessRule::Unspecified,
        AccessRule::Allowed,
        AccessRule::Designated,
        AccessRule::Permissive,
        AccessRule::Discouraged,
        AccessRule::DestinationOnly,
        AccessRule::CustomersOnly,
        AccessRule::DeliveryOnly,
        AccessRule::AgriculturalOnly,
        AccessRule::ForestryOnly,
        AccessRule::MilitaryOnly,
        AccessRule::Private,
        AccessRule::PermitRequired,
        AccessRule::DismountRequired,
        AccessRule::UseSidepath,
        AccessRule::Prohibited,
        AccessRule::Variable,
        AccessRule::Conditional,
        AccessRule::Indeterminate,
    ];

    /// The canonical, stable string form of the rule.
    ///
    /// Lower-case kebab-case, matching every other Atlas wire vocabulary.
    pub fn as_str(self) -> &'static str {
        match self {
            AccessRule::Unspecified => "unspecified",
            AccessRule::Allowed => "allowed",
            AccessRule::Designated => "designated",
            AccessRule::Permissive => "permissive",
            AccessRule::Discouraged => "discouraged",
            AccessRule::DestinationOnly => "destination-only",
            AccessRule::CustomersOnly => "customers-only",
            AccessRule::DeliveryOnly => "delivery-only",
            AccessRule::AgriculturalOnly => "agricultural-only",
            AccessRule::ForestryOnly => "forestry-only",
            AccessRule::MilitaryOnly => "military-only",
            AccessRule::Private => "private",
            AccessRule::PermitRequired => "permit-required",
            AccessRule::DismountRequired => "dismount-required",
            AccessRule::UseSidepath => "use-sidepath",
            AccessRule::Prohibited => "prohibited",
            AccessRule::Variable => "variable",
            AccessRule::Conditional => "conditional",
            AccessRule::Indeterminate => "indeterminate",
        }
    }

    /// Whether the source stated anything at all about this mode.
    ///
    /// The one question that is safe to answer here, because it is about the
    /// *record* rather than about the road: `false` means Atlas found no
    /// applicable tag, so a consumer knows it is looking at silence rather
    /// than at a permission. It is not "may the mode travel here" — that is a
    /// routing-profile question Atlas does not answer yet.
    pub fn is_stated(self) -> bool {
        !matches!(self, AccessRule::Unspecified)
    }
}

impl fmt::Display for AccessRule {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The access facts a road carries, per mode.
///
/// Immutable, and always complete: every modelled mode has an answer, so no
/// consumer has to invent one for a mode the source was silent about. The
/// answer for a silent mode is [`AccessRule::Unspecified`], which says exactly
/// that and nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoadAccess {
    motorcar: AccessRule,
    bicycle: AccessRule,
    foot: AccessRule,
}

impl RoadAccess {
    /// Builds an access record from one rule per mode.
    ///
    /// Infallible on purpose: there is no invariant to check. The three rules
    /// are independent facts about independent modes, and every combination of
    /// them — including ones that look odd, such as a prohibited motorcar on a
    /// designated cycleway — is a combination the source can genuinely state.
    pub fn new(motorcar: AccessRule, bicycle: AccessRule, foot: AccessRule) -> Self {
        Self {
            motorcar,
            bicycle,
            foot,
        }
    }

    /// Builds an access record that is the same for every mode.
    pub fn uniform(rule: AccessRule) -> Self {
        Self::new(rule, rule, rule)
    }

    /// The access of a road whose source said nothing about access at all.
    ///
    /// Deliberately a named constructor and not a `Default` impl. A default
    /// would have to be silently applied wherever a `RoadAccess` is missing,
    /// and "the source said nothing" is a claim about a source — a claim an
    /// older server, a half-built feature or a forgotten field must not be
    /// able to make by accident. Whoever states it has read the source and
    /// says so explicitly.
    pub fn unspecified() -> Self {
        Self::uniform(AccessRule::Unspecified)
    }

    /// The rule for one mode.
    ///
    /// Consumers ask by mode rather than by field, so that adding a mode later
    /// does not mean rewriting every caller's `match`.
    pub fn rule(&self, mode: TravelMode) -> AccessRule {
        match mode {
            TravelMode::Motorcar => self.motorcar,
            TravelMode::Bicycle => self.bicycle,
            TravelMode::Foot => self.foot,
        }
    }

    /// The rule for a motorcar.
    pub fn motorcar(&self) -> AccessRule {
        self.motorcar
    }

    /// The rule for a bicycle.
    pub fn bicycle(&self) -> AccessRule {
        self.bicycle
    }

    /// The rule for a pedestrian.
    pub fn foot(&self) -> AccessRule {
        self.foot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_has_a_stable_kebab_case_wire_form() {
        let wire: Vec<&str> = AccessRule::ALL.iter().map(|rule| rule.as_str()).collect();
        assert_eq!(
            wire,
            vec![
                "unspecified",
                "allowed",
                "designated",
                "permissive",
                "discouraged",
                "destination-only",
                "customers-only",
                "delivery-only",
                "agricultural-only",
                "forestry-only",
                "military-only",
                "private",
                "permit-required",
                "dismount-required",
                "use-sidepath",
                "prohibited",
                "variable",
                "conditional",
                "indeterminate",
            ]
        );
    }

    #[test]
    fn wire_forms_are_lowercase_kebab_case_and_distinct() {
        let mut seen = std::collections::BTreeSet::new();
        for rule in AccessRule::ALL {
            let wire = rule.as_str();
            assert!(!wire.is_empty());
            assert!(
                wire.chars()
                    .all(|character| character.is_ascii_lowercase() || character == '-'),
                "{wire} is not lower-case kebab-case"
            );
            assert!(!wire.starts_with('-') && !wire.ends_with('-'), "{wire}");
            assert!(seen.insert(wire), "{wire} appears twice");
            assert_eq!(rule.to_string(), wire);
        }
        assert_eq!(seen.len(), AccessRule::ALL.len());
    }

    #[test]
    fn every_rule_variant_is_covered_by_all() {
        // A new variant added without extending `ALL` fails here rather than
        // quietly disappearing from the tests that iterate over it.
        for rule in AccessRule::ALL {
            let round_trip = match rule {
                AccessRule::Unspecified => "unspecified",
                AccessRule::Allowed => "allowed",
                AccessRule::Designated => "designated",
                AccessRule::Permissive => "permissive",
                AccessRule::Discouraged => "discouraged",
                AccessRule::DestinationOnly => "destination-only",
                AccessRule::CustomersOnly => "customers-only",
                AccessRule::DeliveryOnly => "delivery-only",
                AccessRule::AgriculturalOnly => "agricultural-only",
                AccessRule::ForestryOnly => "forestry-only",
                AccessRule::MilitaryOnly => "military-only",
                AccessRule::Private => "private",
                AccessRule::PermitRequired => "permit-required",
                AccessRule::DismountRequired => "dismount-required",
                AccessRule::UseSidepath => "use-sidepath",
                AccessRule::Prohibited => "prohibited",
                AccessRule::Variable => "variable",
                AccessRule::Conditional => "conditional",
                AccessRule::Indeterminate => "indeterminate",
            };
            assert_eq!(rule.as_str(), round_trip);
        }
        assert_eq!(AccessRule::ALL.len(), 19);
    }

    #[test]
    fn only_unspecified_is_an_absence_of_a_statement() {
        assert!(!AccessRule::Unspecified.is_stated());
        for rule in AccessRule::ALL {
            if rule != AccessRule::Unspecified {
                assert!(rule.is_stated(), "{rule} states something");
            }
        }
        // Unspecified is emphatically not a synonym for Allowed.
        assert_ne!(AccessRule::Unspecified, AccessRule::Allowed);
        assert_ne!(
            AccessRule::Unspecified.as_str(),
            AccessRule::Allowed.as_str()
        );
    }

    #[test]
    fn access_keeps_one_rule_per_mode() {
        let access = RoadAccess::new(
            AccessRule::Private,
            AccessRule::Designated,
            AccessRule::Prohibited,
        );
        assert_eq!(access.motorcar(), AccessRule::Private);
        assert_eq!(access.bicycle(), AccessRule::Designated);
        assert_eq!(access.foot(), AccessRule::Prohibited);
    }

    #[test]
    fn access_can_be_looked_up_by_mode() {
        let access = RoadAccess::new(
            AccessRule::DestinationOnly,
            AccessRule::Conditional,
            AccessRule::Variable,
        );
        assert_eq!(
            access.rule(TravelMode::Motorcar),
            AccessRule::DestinationOnly
        );
        assert_eq!(access.rule(TravelMode::Bicycle), AccessRule::Conditional);
        assert_eq!(access.rule(TravelMode::Foot), AccessRule::Variable);
        // The mode-based accessor and the named accessors cannot drift apart.
        for mode in TravelMode::ALL {
            let named = match mode {
                TravelMode::Motorcar => access.motorcar(),
                TravelMode::Bicycle => access.bicycle(),
                TravelMode::Foot => access.foot(),
            };
            assert_eq!(access.rule(mode), named);
        }
    }

    #[test]
    fn uniform_and_unspecified_fill_every_mode() {
        let uniform = RoadAccess::uniform(AccessRule::CustomersOnly);
        for mode in TravelMode::ALL {
            assert_eq!(uniform.rule(mode), AccessRule::CustomersOnly);
        }

        let silent = RoadAccess::unspecified();
        for mode in TravelMode::ALL {
            assert_eq!(silent.rule(mode), AccessRule::Unspecified);
        }
        assert_eq!(silent.motorcar(), AccessRule::Unspecified);
        assert_eq!(silent.bicycle(), AccessRule::Unspecified);
        assert_eq!(silent.foot(), AccessRule::Unspecified);
        assert_eq!(silent, RoadAccess::uniform(AccessRule::Unspecified));
    }

    /// A probe for whether a concrete type implements [`Default`].
    ///
    /// Method resolution does the work. `implements_default` is offered twice:
    /// once on `&Probe<T>`, which requires `T: Default`, and once on
    /// `Probe<T>`, which requires nothing. Rust tries the fewest autorefs
    /// first, so the `Default` candidate wins wherever it applies and the
    /// fallback answers otherwise. That is what lets a test assert the
    /// *absence* of an impl, which the language cannot state directly.
    ///
    /// Two details make it work. It has to be spelled at a concrete type,
    /// which is why the entry point is a macro: inside a generic function the
    /// type parameter carries no `Default` bound, so the first candidate could
    /// never apply and the probe would answer `false` for everything. And the
    /// call carries one more `&` than either impl needs, so that the
    /// `Default` candidate is reachable without an autoref and is therefore
    /// the first one considered.
    struct Probe<T>(std::marker::PhantomData<T>);

    trait DefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T: Default> DefaultedProbe for &Probe<T> {
        fn implements_default(&self) -> bool {
            true
        }
    }

    trait UndefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T> UndefaultedProbe for Probe<T> {
        fn implements_default(&self) -> bool {
            false
        }
    }

    macro_rules! implements_default {
        ($subject:ty) => {
            (&&Probe::<$subject>(std::marker::PhantomData)).implements_default()
        };
    }

    #[test]
    fn road_access_deliberately_has_no_default() {
        // `RoadAccess::unspecified()` is a claim that the source was silent.
        // A `Default` impl would let a half-built feature, a forgotten field
        // or an older adapter make that claim by accident, and the result
        // would be indistinguishable from a real import that read the tags and
        // found none. Whoever says "the source said nothing" says it out loud.
        assert!(
            !implements_default!(RoadAccess),
            "RoadAccess must not implement Default"
        );
        assert!(
            !implements_default!(AccessRule),
            "AccessRule must not implement Default either: there is no neutral rule"
        );
        // The probe itself has to be able to see a real `Default`, or the
        // assertions above would pass for the wrong reason. `RoadTraversal`,
        // which has refused a `Default` since Milestone 2A, is checked here
        // too so that the two road records keep the same stance.
        assert!(implements_default!(u8));
        assert!(implements_default!(String));
        assert!(!implements_default!(crate::traversal::RoadTraversal));
    }

    #[test]
    fn every_rule_can_stand_alone_on_every_mode() {
        // There is no invariant between the three modes, which is why
        // construction is infallible: any combination the source can state,
        // Atlas can hold.
        for rule in AccessRule::ALL {
            let access = RoadAccess::new(rule, AccessRule::Unspecified, AccessRule::Allowed);
            assert_eq!(access.motorcar(), rule);
            assert_eq!(access.bicycle(), AccessRule::Unspecified);
            assert_eq!(access.foot(), AccessRule::Allowed);
        }
    }
}
