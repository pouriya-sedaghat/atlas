//! Map features: the things Atlas imports, stores and serves.

use std::fmt;

use crate::access::RoadAccess;
use crate::bounding_box::BoundingBox;
use crate::geometry::Geometry;
use crate::speed::RoadSpeedLimits;
use crate::traversal::RoadTraversal;

/// Everything that can go wrong while constructing feature metadata.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FeatureError {
    /// A feature identifier was empty or blank.
    #[error("a feature id must not be blank")]
    BlankFeatureId,
    /// A source reference component was empty or blank.
    #[error("source reference field `{field}` must not be blank")]
    BlankSourceReferenceField {
        /// Which component was blank.
        field: &'static str,
    },
}

/// A stable, opaque identifier for a map feature.
///
/// Identifiers are derived deterministically from the source entity by the
/// input adapter, so re-importing the same file produces the same ids. Clients
/// must treat the value as an opaque string and must not parse it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FeatureId(String);

impl FeatureId {
    /// Builds an identifier, rejecting blank values.
    pub fn new(value: impl Into<String>) -> Result<Self, FeatureError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(FeatureError::BlankFeatureId);
        }
        Ok(Self(value))
    }

    /// The identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FeatureId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// How a road is classified.
///
/// The classification itself carries no access, speed or direction semantics:
/// it says what kind of road this is, not what may be done on it.
///
/// It is, however, legitimate *input* to deriving those semantics elsewhere.
/// The OSM adapter reads it when it derives the separate travel direction of a
/// road — a motorway implies a forward direction for vehicles, and the class
/// decides whether a plain one-way statement is about pedestrians — but the
/// direction it derives is stored alongside the class in
/// [`FeatureKind::Road`], never inferred from the class on the fly by whoever
/// happens to be reading it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RoadClass {
    /// Motorway.
    Motorway,
    /// Trunk road.
    Trunk,
    /// Primary road.
    Primary,
    /// Secondary road.
    Secondary,
    /// Tertiary road.
    Tertiary,
    /// Road of unknown classification.
    Unclassified,
    /// Residential street.
    Residential,
    /// Living street.
    LivingStreet,
    /// Service road.
    Service,
    /// Track.
    Track,
    /// Path.
    Path,
    /// Footway.
    Footway,
    /// Cycleway.
    Cycleway,
    /// Steps.
    Steps,
    /// A classification Atlas does not model yet, preserved verbatim.
    Other(String),
}

impl RoadClass {
    /// Classifies a raw source value, preserving unknown values verbatim.
    pub fn from_source_value(value: &str) -> Self {
        match value {
            "motorway" => RoadClass::Motorway,
            "trunk" => RoadClass::Trunk,
            "primary" => RoadClass::Primary,
            "secondary" => RoadClass::Secondary,
            "tertiary" => RoadClass::Tertiary,
            "unclassified" => RoadClass::Unclassified,
            "residential" => RoadClass::Residential,
            "living_street" => RoadClass::LivingStreet,
            "service" => RoadClass::Service,
            "track" => RoadClass::Track,
            "path" => RoadClass::Path,
            "footway" => RoadClass::Footway,
            "cycleway" => RoadClass::Cycleway,
            "steps" => RoadClass::Steps,
            other => RoadClass::Other(other.to_owned()),
        }
    }

    /// The canonical string form of the classification.
    pub fn as_str(&self) -> &str {
        match self {
            RoadClass::Motorway => "motorway",
            RoadClass::Trunk => "trunk",
            RoadClass::Primary => "primary",
            RoadClass::Secondary => "secondary",
            RoadClass::Tertiary => "tertiary",
            RoadClass::Unclassified => "unclassified",
            RoadClass::Residential => "residential",
            RoadClass::LivingStreet => "living_street",
            RoadClass::Service => "service",
            RoadClass::Track => "track",
            RoadClass::Path => "path",
            RoadClass::Footway => "footway",
            RoadClass::Cycleway => "cycleway",
            RoadClass::Steps => "steps",
            RoadClass::Other(value) => value,
        }
    }

    /// Whether the classification is one Atlas does not model explicitly.
    pub fn is_other(&self) -> bool {
        matches!(self, RoadClass::Other(_))
    }
}

impl fmt::Display for RoadClass {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// What kind of thing a feature is.
///
/// Road semantics live *inside* the road variant rather than beside it. A
/// classification, a traversal, an access record and a speed record cannot
/// become detached from one another, and none of them can be attached to a
/// feature that is not a road: there is no shape this type can take that
/// carries one without the others.
///
/// The four are **inseparable from a road and independent of one another**.
/// None is a view of, or derivable from, any other:
///
/// * a consumer that wants to know which way the road runs reads `traversal`;
/// * one that wants to know who may use it reads `access`;
/// * one that wants to know what the source said the legal maximum is reads
///   `speed_limits`;
/// * and `class` explains none of the other three.
///
/// The combinations that look contradictory are the point. A road prohibited
/// to motorcars may still carry a motorcar speed limit, because the sign is on
/// the post whether or not anyone may drive past it. A reverse one-way carries
/// both a forward and a backward limit, because the source describes the road
/// rather than the traffic. None of the four is a routing decision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FeatureKind {
    /// A road, carrying its display classification and its travel semantics.
    Road {
        /// How the road is classified for display.
        class: RoadClass,
        /// In which direction each modelled mode travels it, access aside.
        traversal: RoadTraversal,
        /// What the source says about each modelled mode's access to it.
        access: RoadAccess,
        /// What the source says the legal maximum speed is, per mode and per
        /// geometry direction. A legal maximum, never a travel speed.
        speed_limits: RoadSpeedLimits,
    },
}

impl FeatureKind {
    /// The coarse kind name used by filters and by the wire format.
    pub fn name(&self) -> &'static str {
        match self {
            FeatureKind::Road { .. } => "road",
        }
    }

    /// The road classification, when the feature is a road.
    pub fn road_class(&self) -> Option<&RoadClass> {
        match self {
            FeatureKind::Road { class, .. } => Some(class),
        }
    }

    /// The travel direction semantics, when the feature is a road.
    pub fn road_traversal(&self) -> Option<&RoadTraversal> {
        match self {
            FeatureKind::Road { traversal, .. } => Some(traversal),
        }
    }

    /// The source-derived access facts, when the feature is a road.
    pub fn road_access(&self) -> Option<&RoadAccess> {
        match self {
            FeatureKind::Road { access, .. } => Some(access),
        }
    }

    /// The source-derived legal maximum-speed facts, when the feature is a
    /// road.
    ///
    /// These are what the source said, not how fast anything travels and not
    /// what a router should assume.
    pub fn road_speed_limits(&self) -> Option<&RoadSpeedLimits> {
        match self {
            FeatureKind::Road { speed_limits, .. } => Some(speed_limits),
        }
    }
}

/// Where a feature came from in its originating dataset.
///
/// The fields are intentionally generic strings: the kernel must not learn
/// about OpenStreetMap, so the input adapter decides what to put in them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceReference {
    system: String,
    entity_type: String,
    entity_id: String,
}

impl SourceReference {
    /// Builds a reference, rejecting blank components.
    pub fn new(
        system: impl Into<String>,
        entity_type: impl Into<String>,
        entity_id: impl Into<String>,
    ) -> Result<Self, FeatureError> {
        let system = system.into();
        let entity_type = entity_type.into();
        let entity_id = entity_id.into();
        if system.trim().is_empty() {
            return Err(FeatureError::BlankSourceReferenceField { field: "system" });
        }
        if entity_type.trim().is_empty() {
            return Err(FeatureError::BlankSourceReferenceField {
                field: "entityType",
            });
        }
        if entity_id.trim().is_empty() {
            return Err(FeatureError::BlankSourceReferenceField { field: "entityId" });
        }
        Ok(Self {
            system,
            entity_type,
            entity_id,
        })
    }

    /// The originating system, for example `openstreetmap`.
    pub fn system(&self) -> &str {
        &self.system
    }

    /// The entity type within that system, for example `way`.
    pub fn entity_type(&self) -> &str {
        &self.entity_type
    }

    /// The entity identifier within that system.
    pub fn entity_id(&self) -> &str {
        &self.entity_id
    }
}

/// An immutable map feature.
#[derive(Debug, Clone, PartialEq)]
pub struct MapFeature {
    id: FeatureId,
    kind: FeatureKind,
    geometry: Geometry,
    name: Option<String>,
    source: Option<SourceReference>,
}

impl MapFeature {
    /// Builds a feature. A name that is blank is normalised away to `None`.
    pub fn new(
        id: FeatureId,
        kind: FeatureKind,
        geometry: Geometry,
        name: Option<String>,
        source: Option<SourceReference>,
    ) -> Self {
        let name = name
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        Self {
            id,
            kind,
            geometry,
            name,
            source,
        }
    }

    /// The deterministic feature identifier.
    pub fn id(&self) -> &FeatureId {
        &self.id
    }

    /// What kind of feature this is.
    pub fn kind(&self) -> &FeatureKind {
        &self.kind
    }

    /// The feature geometry.
    pub fn geometry(&self) -> &Geometry {
        &self.geometry
    }

    /// The optional feature name, exactly as it appeared in the source.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// The optional source reference.
    pub fn source(&self) -> Option<&SourceReference> {
        self.source.as_ref()
    }

    /// The cached bounding box of the feature geometry.
    pub fn bounds(&self) -> &BoundingBox {
        self.geometry.bounds()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::AccessRule;
    use crate::coordinate::GeoCoordinate;
    use crate::geometry::LineString;
    use crate::speed::{
        ConditionalSpeedLimit, DirectionalSpeedLimits, Speed, SpeedDirection, SpeedLimitFact,
        SpeedLimitValue, SpeedUnit, VariableSpeedLimit,
    };
    use crate::traversal::{TravelDirection, TravelMode};

    /// A plain two-way road with nothing said about access or speed, for the
    /// tests that are not about road semantics at all.
    ///
    /// Every silent value is spelled out: there is no default to fall back on,
    /// and a test fixture must say what it claims about its source like
    /// everybody else.
    fn plain_road(class: RoadClass) -> FeatureKind {
        FeatureKind::Road {
            class,
            traversal: RoadTraversal::bidirectional(),
            access: RoadAccess::unspecified(),
            speed_limits: RoadSpeedLimits::unspecified(),
        }
    }

    /// A numeric limit, for the tests that need one.
    fn numeric(magnitude: &str, unit: SpeedUnit) -> SpeedLimitValue {
        SpeedLimitValue::Numeric(Speed::new(magnitude, unit).expect("a valid magnitude"))
    }

    fn geometry() -> Geometry {
        Geometry::from(
            LineString::new(vec![
                GeoCoordinate::from_degrees(51.38, 35.68).expect("valid coordinate"),
                GeoCoordinate::from_degrees(51.39, 35.69).expect("valid coordinate"),
            ])
            .expect("valid line"),
        )
    }

    #[test]
    fn feature_ids_reject_blank_values() {
        assert_eq!(FeatureId::new(""), Err(FeatureError::BlankFeatureId));
        assert_eq!(FeatureId::new("   "), Err(FeatureError::BlankFeatureId));
        assert!(FeatureId::new("osm:way:1").is_ok());
    }

    #[test]
    fn known_road_classes_round_trip() {
        for value in [
            "motorway",
            "trunk",
            "primary",
            "secondary",
            "tertiary",
            "unclassified",
            "residential",
            "living_street",
            "service",
            "track",
            "path",
            "footway",
            "cycleway",
            "steps",
        ] {
            let class = RoadClass::from_source_value(value);
            assert!(!class.is_other(), "{value} should be a known class");
            assert_eq!(class.as_str(), value);
        }
    }

    #[test]
    fn unknown_road_classes_are_preserved() {
        let class = RoadClass::from_source_value("corn_maze");
        assert_eq!(class, RoadClass::Other("corn_maze".to_owned()));
        assert!(class.is_other());
        assert_eq!(class.as_str(), "corn_maze");
    }

    #[test]
    fn feature_kind_exposes_name_class_traversal_and_access() {
        let traversal = RoadTraversal::new(
            TravelDirection::Forward,
            TravelDirection::Both,
            TravelDirection::Indeterminate,
        );
        let access = RoadAccess::new(
            AccessRule::DestinationOnly,
            AccessRule::Designated,
            AccessRule::Unspecified,
        );
        let speed_limits = RoadSpeedLimits::new(
            DirectionalSpeedLimits::new(
                SpeedLimitFact::plain(numeric("70", SpeedUnit::KilometresPerHour)),
                SpeedLimitFact::plain(numeric("30", SpeedUnit::MilesPerHour)),
            ),
            DirectionalSpeedLimits::unspecified(),
            DirectionalSpeedLimits::uniform(SpeedLimitFact::plain(SpeedLimitValue::WalkingPace)),
        );
        let kind = FeatureKind::Road {
            class: RoadClass::Residential,
            traversal,
            access,
            speed_limits: speed_limits.clone(),
        };
        assert_eq!(kind.name(), "road");
        assert_eq!(kind.road_class(), Some(&RoadClass::Residential));
        assert_eq!(kind.road_traversal(), Some(&traversal));
        assert_eq!(kind.road_access(), Some(&access));
        assert_eq!(kind.road_speed_limits(), Some(&speed_limits));
        assert_eq!(
            kind.road_speed_limits().map(|limits| limits
                .fact(TravelMode::Motorcar, SpeedDirection::Backward)
                .limit()),
            Some(&numeric("30", SpeedUnit::MilesPerHour))
        );
        assert_eq!(
            kind.road_traversal().map(|t| t.direction(TravelMode::Foot)),
            Some(TravelDirection::Indeterminate)
        );
        assert_eq!(
            kind.road_access().map(|a| a.rule(TravelMode::Foot)),
            Some(AccessRule::Unspecified)
        );
    }

    #[test]
    fn access_and_direction_are_independent_values_on_one_road() {
        // A forward one-way that bars cars, a two-way that is private, and a
        // designated cycleway that is still one-way: direction says which way
        // the road runs, access says who may use it, and neither is derivable
        // from the other or from the class.
        let barred_one_way = FeatureKind::Road {
            class: RoadClass::Residential,
            traversal: RoadTraversal::new(
                TravelDirection::Forward,
                TravelDirection::Forward,
                TravelDirection::Both,
            ),
            access: RoadAccess::new(
                AccessRule::Prohibited,
                AccessRule::Allowed,
                AccessRule::Allowed,
            ),
            // Prohibited to cars and still signed at 50 in both directions:
            // the sign is on the post whether or not anyone may drive past it.
            speed_limits: RoadSpeedLimits::uniform(DirectionalSpeedLimits::uniform(
                SpeedLimitFact::plain(numeric("50", SpeedUnit::KilometresPerHour)),
            )),
        };
        assert_eq!(
            barred_one_way.road_traversal().map(RoadTraversal::motorcar),
            Some(TravelDirection::Forward)
        );
        assert_eq!(
            barred_one_way.road_access().map(RoadAccess::motorcar),
            Some(AccessRule::Prohibited)
        );

        let private_two_way = FeatureKind::Road {
            class: RoadClass::Service,
            traversal: RoadTraversal::bidirectional(),
            access: RoadAccess::uniform(AccessRule::Private),
            speed_limits: RoadSpeedLimits::unspecified(),
        };
        assert_eq!(
            private_two_way
                .road_traversal()
                .map(RoadTraversal::motorcar),
            Some(TravelDirection::Both)
        );
        assert_eq!(
            private_two_way.road_access().map(RoadAccess::motorcar),
            Some(AccessRule::Private)
        );

        // Two roads of the same class disagree about access, so access cannot
        // have come from the class.
        let ordinary_service = plain_road(RoadClass::Service);
        assert_eq!(
            ordinary_service.road_access(),
            Some(&RoadAccess::unspecified())
        );
        assert_ne!(
            ordinary_service.road_access(),
            private_two_way.road_access()
        );
        assert_eq!(ordinary_service.road_class(), private_two_way.road_class());
    }

    #[test]
    fn speed_is_a_fourth_independent_record_not_a_view_of_the_other_three() {
        // Four roads that agree on three of the four records and disagree on
        // the fourth, in every direction. If any one of them were derived from
        // another, at least one of these pairs would be impossible to build.
        let signed_prohibited = FeatureKind::Road {
            class: RoadClass::Motorway,
            traversal: RoadTraversal::uniform(TravelDirection::Forward),
            access: RoadAccess::uniform(AccessRule::Prohibited),
            speed_limits: RoadSpeedLimits::uniform(DirectionalSpeedLimits::uniform(
                SpeedLimitFact::plain(numeric("120", SpeedUnit::KilometresPerHour)),
            )),
        };
        let unsigned_prohibited = FeatureKind::Road {
            class: RoadClass::Motorway,
            traversal: RoadTraversal::uniform(TravelDirection::Forward),
            access: RoadAccess::uniform(AccessRule::Prohibited),
            speed_limits: RoadSpeedLimits::unspecified(),
        };
        // Same class, same direction, same access — different speed. Speed
        // cannot be a function of any of the three.
        assert_eq!(
            signed_prohibited.road_class(),
            unsigned_prohibited.road_class()
        );
        assert_eq!(
            signed_prohibited.road_traversal(),
            unsigned_prohibited.road_traversal()
        );
        assert_eq!(
            signed_prohibited.road_access(),
            unsigned_prohibited.road_access()
        );
        assert_ne!(
            signed_prohibited.road_speed_limits(),
            unsigned_prohibited.road_speed_limits()
        );

        // A reverse one-way carries both directions' limits, and they differ:
        // a speed direction is a property of the source record, not of the
        // direction the traffic is allowed to run.
        let reverse_one_way = FeatureKind::Road {
            class: RoadClass::Residential,
            traversal: RoadTraversal::uniform(TravelDirection::Reverse),
            access: RoadAccess::unspecified(),
            speed_limits: RoadSpeedLimits::uniform(DirectionalSpeedLimits::new(
                SpeedLimitFact::plain(numeric("70", SpeedUnit::KilometresPerHour)),
                SpeedLimitFact::plain(numeric("30", SpeedUnit::KilometresPerHour)),
            )),
        };
        let limits = reverse_one_way
            .road_speed_limits()
            .expect("a road carries speed limits");
        assert_eq!(
            limits.motorcar().forward().limit(),
            &numeric("70", SpeedUnit::KilometresPerHour)
        );
        assert_eq!(
            limits.motorcar().backward().limit(),
            &numeric("30", SpeedUnit::KilometresPerHour)
        );
        assert_eq!(
            reverse_one_way
                .road_traversal()
                .map(RoadTraversal::motorcar),
            Some(TravelDirection::Reverse)
        );

        // And two roads with identical speed facts can disagree about
        // everything else, so nothing is derived in the other direction
        // either.
        assert_eq!(
            signed_prohibited.road_speed_limits(),
            FeatureKind::Road {
                class: RoadClass::Track,
                traversal: RoadTraversal::bidirectional(),
                access: RoadAccess::uniform(AccessRule::Designated),
                speed_limits: RoadSpeedLimits::uniform(DirectionalSpeedLimits::uniform(
                    SpeedLimitFact::plain(numeric("120", SpeedUnit::KilometresPerHour)),
                )),
            }
            .road_speed_limits()
        );
    }

    #[test]
    fn road_semantics_cannot_be_detached_from_the_road_variant() {
        // Every shape this type can take carries all four parts. The
        // exhaustive match is the point: a variant that could hold a class
        // without a traversal, an access record or a speed record, or road
        // semantics on something that is not a road, would stop compiling here
        // rather than ship.
        for kind in [
            FeatureKind::Road {
                class: RoadClass::Steps,
                traversal: RoadTraversal::uniform(TravelDirection::Forward),
                access: RoadAccess::new(
                    AccessRule::Prohibited,
                    AccessRule::DismountRequired,
                    AccessRule::Designated,
                ),
                speed_limits: RoadSpeedLimits::uniform(DirectionalSpeedLimits::uniform(
                    SpeedLimitFact::new(
                        SpeedLimitValue::WalkingPace,
                        ConditionalSpeedLimit::Present,
                        VariableSpeedLimit::Fixed,
                    ),
                )),
            },
            FeatureKind::Road {
                class: RoadClass::Other("corn_maze".to_owned()),
                traversal: RoadTraversal::bidirectional(),
                access: RoadAccess::unspecified(),
                speed_limits: RoadSpeedLimits::unspecified(),
            },
        ] {
            match &kind {
                FeatureKind::Road {
                    class,
                    traversal,
                    access,
                    speed_limits,
                } => {
                    assert_eq!(kind.road_class(), Some(class));
                    assert_eq!(kind.road_traversal(), Some(traversal));
                    assert_eq!(kind.road_access(), Some(access));
                    assert_eq!(kind.road_speed_limits(), Some(speed_limits));
                }
            }
            assert!(kind.road_class().is_some());
            assert!(kind.road_traversal().is_some());
            assert!(kind.road_access().is_some());
            assert!(kind.road_speed_limits().is_some());
        }
    }

    #[test]
    fn source_references_reject_blank_components() {
        assert_eq!(
            SourceReference::new("", "way", "1"),
            Err(FeatureError::BlankSourceReferenceField { field: "system" })
        );
        assert_eq!(
            SourceReference::new("openstreetmap", " ", "1"),
            Err(FeatureError::BlankSourceReferenceField {
                field: "entityType"
            })
        );
        assert_eq!(
            SourceReference::new("openstreetmap", "way", ""),
            Err(FeatureError::BlankSourceReferenceField { field: "entityId" })
        );
    }

    #[test]
    fn blank_names_are_normalised_away() {
        let feature = MapFeature::new(
            FeatureId::new("osm:way:1").expect("valid id"),
            plain_road(RoadClass::Residential),
            geometry(),
            Some("   ".to_owned()),
            None,
        );
        assert_eq!(feature.name(), None);
    }

    #[test]
    fn names_keep_unicode_intact() {
        let feature = MapFeature::new(
            FeatureId::new("osm:way:1").expect("valid id"),
            plain_road(RoadClass::Residential),
            geometry(),
            Some("  خیابان ولیعصر  ".to_owned()),
            None,
        );
        assert_eq!(feature.name(), Some("خیابان ولیعصر"));
    }

    #[test]
    fn features_expose_geometry_bounds() {
        let feature = MapFeature::new(
            FeatureId::new("osm:way:1").expect("valid id"),
            plain_road(RoadClass::Residential),
            geometry(),
            None,
            Some(SourceReference::new("openstreetmap", "way", "1").expect("valid reference")),
        );
        assert_eq!(feature.bounds().west(), 51.38);
        assert_eq!(feature.bounds().north(), 35.69);
        assert_eq!(feature.source().map(SourceReference::entity_id), Some("1"));
    }
}
