//! Shared fixtures for the engine's own tests.

use atlas_kernel::{
    FeatureId, FeatureKind, GeoCoordinate, Geometry, LineString, MapFeature, RoadClass,
    RoadTraversal,
};

use crate::import::{Attribution, ImportStats, IssueLog, SourceImportOutcome, SourceMetadata};

pub(crate) fn metadata() -> SourceMetadata {
    SourceMetadata::new(
        "roads-basic.osm",
        "osm-xml",
        Some(Attribution::new(
            "© OpenStreetMap contributors",
            "https://www.openstreetmap.org/copyright",
        )),
    )
}

pub(crate) fn outcome() -> SourceImportOutcome {
    SourceImportOutcome {
        stats: ImportStats::default(),
        issues: IssueLog::new(),
    }
}

pub(crate) fn road(id: &str, class: RoadClass, points: &[(f64, f64)]) -> MapFeature {
    let coordinates = points
        .iter()
        .map(|(longitude, latitude)| {
            GeoCoordinate::from_degrees(*longitude, *latitude).expect("valid coordinate")
        })
        .collect();
    MapFeature::new(
        FeatureId::new(id).expect("valid id"),
        FeatureKind::Road {
            class,
            traversal: RoadTraversal::bidirectional(),
        },
        Geometry::from(LineString::new(coordinates).expect("valid line")),
        None,
        None,
    )
}

pub(crate) fn residential(id: &str, points: &[(f64, f64)]) -> MapFeature {
    road(id, RoadClass::Residential, points)
}
