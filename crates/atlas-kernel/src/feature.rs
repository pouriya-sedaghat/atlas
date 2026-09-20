//! Map features: the things Atlas imports, stores and serves.

use std::fmt;

use crate::bounding_box::BoundingBox;
use crate::geometry::Geometry;

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

/// How a road is classified for display purposes.
///
/// This is a display-oriented classification only. Atlas does not derive
/// access, speed or direction semantics from it in this milestone.
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
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FeatureKind {
    /// A road, carrying its display classification.
    Road(RoadClass),
}

impl FeatureKind {
    /// The coarse kind name used by filters and by the wire format.
    pub fn name(&self) -> &'static str {
        match self {
            FeatureKind::Road(_) => "road",
        }
    }

    /// The road classification, when the feature is a road.
    pub fn road_class(&self) -> Option<&RoadClass> {
        match self {
            FeatureKind::Road(class) => Some(class),
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
    use crate::coordinate::GeoCoordinate;
    use crate::geometry::LineString;

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
    fn feature_kind_exposes_name_and_class() {
        let kind = FeatureKind::Road(RoadClass::Residential);
        assert_eq!(kind.name(), "road");
        assert_eq!(kind.road_class(), Some(&RoadClass::Residential));
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
            FeatureKind::Road(RoadClass::Residential),
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
            FeatureKind::Road(RoadClass::Residential),
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
            FeatureKind::Road(RoadClass::Residential),
            geometry(),
            None,
            Some(SourceReference::new("openstreetmap", "way", "1").expect("valid reference")),
        );
        assert_eq!(feature.bounds().west(), 51.38);
        assert_eq!(feature.bounds().north(), 35.69);
        assert_eq!(feature.source().map(SourceReference::entity_id), Some("1"));
    }
}
