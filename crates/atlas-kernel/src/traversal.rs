//! Travel modes and the direction of travel a road carries.
//!
//! These are Atlas's own semantics, derived by an input adapter from whatever
//! the source format happens to call things. The vocabulary here is
//! deliberately Atlas vocabulary: the kernel must not learn what a `oneway`
//! tag is, only what a direction of travel means.
//!
//! Nothing here grants access. A direction says which way along a road a mode
//! would travel *if* it may use the road at all; whether it may is a separate
//! access question that Atlas does not model yet.
//!
//! A direction is always stated *relative to the feature geometry*, never in
//! compass terms: [`TravelDirection::Forward`] means "along the coordinate
//! order of the line", so reversing a geometry would reverse its meaning.
//! Atlas therefore never reverses a geometry.

use std::fmt;

/// A mode of travel Atlas models direction for.
///
/// This is deliberately a small, closed set. Adding a mode is a domain change
/// that every layer must follow, which is exactly the review Atlas wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TravelMode {
    /// A private car or other ordinary motor vehicle.
    Motorcar,
    /// A bicycle.
    Bicycle,
    /// A pedestrian.
    Foot,
}

impl TravelMode {
    /// Every mode Atlas models, in a stable order.
    pub const ALL: [TravelMode; 3] = [TravelMode::Motorcar, TravelMode::Bicycle, TravelMode::Foot];

    /// The canonical string form of the mode.
    pub fn as_str(self) -> &'static str {
        match self {
            TravelMode::Motorcar => "motorcar",
            TravelMode::Bicycle => "bicycle",
            TravelMode::Foot => "foot",
        }
    }
}

impl fmt::Display for TravelMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// In which direction, relative to the geometry, a mode would travel.
///
/// If access otherwise allows the mode, this value describes the permitted
/// direction relative to the geometry. It is not itself a permission: this
/// describes direction only, and whether a mode may use the road at all is an
/// access question, which Atlas does not model yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TravelDirection {
    /// No directional restriction: neither way along the line is ruled out.
    Both,
    /// Travel follows the coordinate order of the line.
    Forward,
    /// Travel runs against the coordinate order of the line.
    Reverse,
    /// The direction the road runs changes, but infrequently.
    Reversible,
    /// Traffic alternates direction frequently, for example at a shuttle
    /// working or a single-lane bridge under signals.
    Alternating,
    /// Atlas cannot derive a safe static direction from the source.
    ///
    /// This is a refusal to guess, not a default. It is what Atlas records
    /// when the source says something it cannot read, or says something whose
    /// meaning depends on a condition Atlas does not evaluate.
    Indeterminate,
}

impl TravelDirection {
    /// Every direction Atlas models, in a stable order.
    pub const ALL: [TravelDirection; 6] = [
        TravelDirection::Both,
        TravelDirection::Forward,
        TravelDirection::Reverse,
        TravelDirection::Reversible,
        TravelDirection::Alternating,
        TravelDirection::Indeterminate,
    ];

    /// The canonical string form of the direction.
    pub fn as_str(self) -> &'static str {
        match self {
            TravelDirection::Both => "both",
            TravelDirection::Forward => "forward",
            TravelDirection::Reverse => "reverse",
            TravelDirection::Reversible => "reversible",
            TravelDirection::Alternating => "alternating",
            TravelDirection::Indeterminate => "indeterminate",
        }
    }

    /// Whether the direction is fixed for the lifetime of the dataset.
    ///
    /// [`TravelDirection::Reversible`] and [`TravelDirection::Alternating`]
    /// describe roads whose direction genuinely changes over time, so a static
    /// dataset cannot state one. [`TravelDirection::Indeterminate`] is not
    /// static either: Atlas simply does not know.
    pub fn is_static(self) -> bool {
        matches!(
            self,
            TravelDirection::Both | TravelDirection::Forward | TravelDirection::Reverse
        )
    }
}

impl fmt::Display for TravelDirection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The direction of travel a road carries, per mode.
///
/// Immutable, and always complete: every modelled mode has an answer, so no
/// consumer has to invent one for a mode the source was silent about. An
/// answer is a direction, never a permission — a mode with an entry here may
/// still be barred from the road by access rules Atlas does not model yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoadTraversal {
    motorcar: TravelDirection,
    bicycle: TravelDirection,
    foot: TravelDirection,
}

impl RoadTraversal {
    /// Builds a traversal from one direction per mode.
    pub fn new(motorcar: TravelDirection, bicycle: TravelDirection, foot: TravelDirection) -> Self {
        Self {
            motorcar,
            bicycle,
            foot,
        }
    }

    /// Builds a traversal that is the same for every mode.
    pub fn uniform(direction: TravelDirection) -> Self {
        Self::new(direction, direction, direction)
    }

    /// The traversal of a road with no directional restriction for any mode.
    ///
    /// Deliberately a named constructor and not a `Default` impl. `Both` is a
    /// claim about a road, and a generic default cannot know the road class,
    /// the implied motorway and roundabout rules, or whether the source said
    /// something Atlas could not read. Whoever builds a traversal has that
    /// context and has to say so explicitly.
    pub fn bidirectional() -> Self {
        Self::uniform(TravelDirection::Both)
    }

    /// The direction for one mode.
    ///
    /// Graph construction asks by mode rather than by field, so that adding a
    /// mode later does not mean rewriting every caller's `match`.
    pub fn direction(&self, mode: TravelMode) -> TravelDirection {
        match mode {
            TravelMode::Motorcar => self.motorcar,
            TravelMode::Bicycle => self.bicycle,
            TravelMode::Foot => self.foot,
        }
    }

    /// The direction for a motorcar.
    pub fn motorcar(&self) -> TravelDirection {
        self.motorcar
    }

    /// The direction for a bicycle.
    pub fn bicycle(&self) -> TravelDirection {
        self.bicycle
    }

    /// The direction for a pedestrian.
    pub fn foot(&self) -> TravelDirection {
        self.foot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_direction_has_a_stable_wire_form() {
        let wire: Vec<&str> = TravelDirection::ALL
            .iter()
            .map(|direction| direction.as_str())
            .collect();
        assert_eq!(
            wire,
            vec![
                "both",
                "forward",
                "reverse",
                "reversible",
                "alternating",
                "indeterminate",
            ]
        );
    }

    #[test]
    fn every_direction_variant_is_covered_by_all() {
        // A new variant added without extending `ALL` fails here rather than
        // quietly disappearing from the tests that iterate over it.
        for direction in TravelDirection::ALL {
            let round_trip = match direction {
                TravelDirection::Both => "both",
                TravelDirection::Forward => "forward",
                TravelDirection::Reverse => "reverse",
                TravelDirection::Reversible => "reversible",
                TravelDirection::Alternating => "alternating",
                TravelDirection::Indeterminate => "indeterminate",
            };
            assert_eq!(direction.as_str(), round_trip);
            assert_eq!(direction.to_string(), round_trip);
        }
        assert_eq!(TravelDirection::ALL.len(), 6);
    }

    #[test]
    fn only_fixed_directions_are_static() {
        assert!(TravelDirection::Both.is_static());
        assert!(TravelDirection::Forward.is_static());
        assert!(TravelDirection::Reverse.is_static());
        assert!(!TravelDirection::Reversible.is_static());
        assert!(!TravelDirection::Alternating.is_static());
        assert!(!TravelDirection::Indeterminate.is_static());
    }

    #[test]
    fn every_mode_has_a_stable_wire_form() {
        let wire: Vec<&str> = TravelMode::ALL.iter().map(|mode| mode.as_str()).collect();
        assert_eq!(wire, vec!["motorcar", "bicycle", "foot"]);
        assert_eq!(TravelMode::Foot.to_string(), "foot");
    }

    #[test]
    fn traversal_keeps_one_direction_per_mode() {
        let traversal = RoadTraversal::new(
            TravelDirection::Forward,
            TravelDirection::Both,
            TravelDirection::Indeterminate,
        );
        assert_eq!(traversal.motorcar(), TravelDirection::Forward);
        assert_eq!(traversal.bicycle(), TravelDirection::Both);
        assert_eq!(traversal.foot(), TravelDirection::Indeterminate);
    }

    #[test]
    fn traversal_can_be_looked_up_by_mode() {
        let traversal = RoadTraversal::new(
            TravelDirection::Reverse,
            TravelDirection::Alternating,
            TravelDirection::Reversible,
        );
        assert_eq!(
            traversal.direction(TravelMode::Motorcar),
            TravelDirection::Reverse
        );
        assert_eq!(
            traversal.direction(TravelMode::Bicycle),
            TravelDirection::Alternating
        );
        assert_eq!(
            traversal.direction(TravelMode::Foot),
            TravelDirection::Reversible
        );
        // The mode-based accessor and the named accessors cannot drift apart.
        for mode in TravelMode::ALL {
            let named = match mode {
                TravelMode::Motorcar => traversal.motorcar(),
                TravelMode::Bicycle => traversal.bicycle(),
                TravelMode::Foot => traversal.foot(),
            };
            assert_eq!(traversal.direction(mode), named);
        }
    }

    #[test]
    fn uniform_and_bidirectional_fill_every_mode() {
        let uniform = RoadTraversal::uniform(TravelDirection::Reversible);
        for mode in TravelMode::ALL {
            assert_eq!(uniform.direction(mode), TravelDirection::Reversible);
        }

        let both = RoadTraversal::bidirectional();
        for mode in TravelMode::ALL {
            assert_eq!(both.direction(mode), TravelDirection::Both);
        }
    }
}
