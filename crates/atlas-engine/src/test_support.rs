//! Shared fixtures for the engine's own tests.

use atlas_kernel::{
    FeatureId, FeatureKind, GeoCoordinate, Geometry, LineString, MapFeature, RoadAccess, RoadClass,
    RoadSpeedLimits, RoadTraversal,
};

use crate::import::{Attribution, ImportStats, IssueLog, SourceImportOutcome, SourceMetadata};
use crate::topology::{ImportedRoad, RoadPath, RoadPathPoint};

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
            // The engine's own tests are about datasets and queries, not road
            // semantics, so their roads say nothing about access or speed at
            // all. Both are spelled out rather than defaulted: there is no
            // `Default` to fall back on, and a fixture states what it claims
            // about its source like everybody else.
            access: RoadAccess::unspecified(),
            speed_limits: RoadSpeedLimits::unspecified(),
        },
        Geometry::from(LineString::new(coordinates).expect("valid line")),
        None,
        None,
    )
}

pub(crate) fn residential(id: &str, points: &[(f64, f64)]) -> MapFeature {
    road(id, RoadClass::Residential, points)
}

/// The coordinates of a `(point id, longitude, latitude)` list.
///
/// Topology fixtures state an identity per point; the feature geometry only
/// needs the positions, so this drops the identities the way the importer
/// drops them when it builds a display geometry.
pub(crate) fn coordinates(points: &[(&str, f64, f64)]) -> Vec<(f64, f64)> {
    points
        .iter()
        .map(|(_, longitude, latitude)| (*longitude, *latitude))
        .collect()
}

/// A road path from a `(point id, longitude, latitude)` list.
pub(crate) fn path(points: &[(&str, f64, f64)]) -> RoadPath {
    RoadPath::new(
        points
            .iter()
            .map(|(id, longitude, latitude)| {
                RoadPathPoint::new(
                    *id,
                    GeoCoordinate::from_degrees(*longitude, *latitude)
                        .expect("valid test coordinate"),
                )
                .expect("valid test path point")
            })
            .collect(),
    )
    .expect("valid test path")
}

/// A residential road and a path along the same positions.
///
/// The point identities are derived from the feature id and the point's index,
/// which is enough for the dataset and query tests that only need *a* topology
/// and do not care what shape it is. Tests that are about connectivity build
/// their identities by hand.
pub(crate) fn imported(id: &str, points: &[(f64, f64)]) -> ImportedRoad {
    let identified: Vec<(String, f64, f64)> = points
        .iter()
        .enumerate()
        .map(|(index, (longitude, latitude))| {
            (format!("{id}/point/{index}"), *longitude, *latitude)
        })
        .collect();
    let borrowed: Vec<(&str, f64, f64)> = identified
        .iter()
        .map(|(point, longitude, latitude)| (point.as_str(), *longitude, *latitude))
        .collect();
    ImportedRoad::new(residential(id, points), path(&borrowed)).expect("a valid imported road")
}

/// An imported road of a given class, with a generated path.
pub(crate) fn imported_road(id: &str, class: RoadClass, points: &[(f64, f64)]) -> ImportedRoad {
    let (_, generated) = imported(id, points).into_parts();
    ImportedRoad::new(road(id, class, points), generated).expect("a valid imported road")
}

/// An imported road that carries an explicit path.
pub(crate) fn imported_with_path(id: &str, points: &[(&str, f64, f64)]) -> ImportedRoad {
    ImportedRoad::new(residential(id, &coordinates(points)), path(points))
        .expect("a valid imported road")
}
