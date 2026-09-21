//! Integration test: the synthetic fixture, imported through the real
//! engine path (OSM source -> DatasetBuilder -> immutable Dataset).
//!
//! The expected counters are written out in full on purpose. If the importer's
//! behaviour changes, this test should have to be edited deliberately.

use std::path::PathBuf;

use atlas_engine::{Dataset, DatasetBuilder, DatasetId, ImportStats, IssueCode, MapSource};
use atlas_kernel::{RoadClass, RoadNodeId};
use atlas_osm::OsmXmlSource;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-basic.osm")
}

fn import_fixture() -> Dataset {
    let source = OsmXmlSource::from_path(fixture_path());
    let mut builder = DatasetBuilder::new(
        DatasetId::new("ds-fixture"),
        MapSource::source_metadata(&source),
    );
    let outcome = source
        .import(&mut builder)
        .expect("the fixture must import");
    builder
        .finish(outcome)
        .expect("the fixture produces features")
}

fn feature_ids(dataset: &Dataset) -> Vec<String> {
    dataset
        .features()
        .iter()
        .map(|feature| feature.id().as_str().to_owned())
        .collect()
}

#[test]
fn fixture_produces_the_documented_counters() {
    let dataset = import_fixture();
    let stats = dataset.report().stats();

    assert_eq!(
        *stats,
        ImportStats {
            nodes_seen: 8,
            nodes_indexed: 7,
            ways_seen: 8,
            road_ways_selected: 7,
            features_emitted: 4,
            features_skipped: 3,
            relations_seen: 2,
            bytes_read: stats.bytes_read,
        }
    );
    assert!(stats.bytes_read.is_some_and(|bytes| bytes > 0));
    assert_eq!(dataset.feature_count(), 4);
}

#[test]
fn fixture_reports_every_expected_issue_with_bounded_samples() {
    let dataset = import_fixture();
    let issues = dataset.report().issues();

    assert_eq!(issues.count_of(IssueCode::InvalidCoordinate), 1);
    assert_eq!(issues.samples_of(IssueCode::InvalidCoordinate), &["node/8"]);

    assert_eq!(issues.count_of(IssueCode::MissingNodeReference), 2);
    assert_eq!(
        issues.samples_of(IssueCode::MissingNodeReference),
        &["way/104", "way/107"]
    );

    assert_eq!(issues.count_of(IssueCode::TooFewCoordinates), 1);
    assert_eq!(
        issues.samples_of(IssueCode::TooFewCoordinates),
        &["way/108"]
    );

    assert_eq!(issues.count_of(IssueCode::UnknownHighwayClass), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnknownHighwayClass),
        &["way/105"]
    );

    assert_eq!(issues.count_of(IssueCode::UnsupportedRelation), 2);
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedRelation),
        &["relation/201", "relation/202"]
    );

    assert_eq!(issues.count_of(IssueCode::MalformedEntity), 0);

    // Every sample list stays within the bound, whatever the counts are.
    for group in issues.groups() {
        assert!(group.samples().len() <= atlas_engine::IssueLog::DEFAULT_MAX_SAMPLES);
    }
}

#[test]
fn fixture_emits_exactly_the_expected_features() {
    let dataset = import_fixture();
    assert_eq!(
        feature_ids(&dataset),
        vec!["osm:way:101", "osm:way:102", "osm:way:105", "osm:way:106"]
    );
}

#[test]
fn fixture_classifies_roads_and_preserves_unknown_values() {
    let dataset = import_fixture();
    let classes: Vec<String> = dataset
        .features()
        .iter()
        .filter_map(|feature| feature.kind().road_class())
        .map(|class| class.as_str().to_owned())
        .collect();
    assert_eq!(
        classes,
        vec!["residential", "service", "corn_maze", "footway"]
    );

    let unknown = dataset
        .features()
        .iter()
        .find(|feature| feature.id().as_str() == "osm:way:105")
        .expect("way 105 is imported");
    assert_eq!(
        unknown.kind().road_class(),
        Some(&RoadClass::Other("corn_maze".to_owned()))
    );
}

#[test]
fn fixture_keeps_persian_names_intact() {
    let dataset = import_fixture();
    let names: Vec<Option<&str>> = dataset
        .features()
        .iter()
        .map(|feature| feature.name())
        .collect();
    assert_eq!(
        names,
        vec![
            Some("خیابان ولیعصر"),
            Some("Service Lane"),
            Some("Corn Maze Track"),
            Some("گذر پیاده"),
        ]
    );
}

#[test]
fn fixture_collapses_the_duplicate_coordinate() {
    let dataset = import_fixture();
    let footway = dataset
        .features()
        .iter()
        .find(|feature| feature.id().as_str() == "osm:way:106")
        .expect("way 106 is imported");
    // Nodes 6, 7 and 3, with 6 and 7 sharing a position.
    assert_eq!(footway.geometry().coordinate_count(), 2);
}

#[test]
fn the_topology_path_keeps_the_identity_the_display_geometry_collapsed() {
    // Way 106 is nodes 6, 7 and 3, and nodes 6 and 7 sit at one position.
    //
    // The *feature* geometry collapses the adjacent duplicate, exactly as the
    // test above pins: two coordinates, because two copies of one position
    // draw nothing extra.
    //
    // The *segment* geometry does not, because the path keeps both
    // identities. Nodes 6 and 7 are two source points, and the source
    // described a zero-length structural connection between them. Collapsing
    // that away would delete a statement the file made.
    let dataset = import_fixture();
    let footway = dataset
        .features()
        .iter()
        .find(|feature| feature.id().as_str() == "osm:way:106")
        .expect("way 106 is imported");
    assert_eq!(footway.geometry().coordinate_count(), 2);

    let segment = dataset
        .topology()
        .segments()
        .iter()
        .find(|segment| segment.road().as_str() == "osm:way:106")
        .expect("way 106 has a segment");
    assert_eq!(segment.geometry().coordinate_count(), 3);
    assert_eq!(
        segment.geometry().coordinates()[0],
        segment.geometry().coordinates()[1],
        "nodes 6 and 7 share a position and both are kept"
    );

    // Node 7 is seen once, in the middle of one way, so it is a shape point.
    // Node 6 starts this way and ends way 105, so it is a node of degree two.
    let topology = dataset.topology();
    assert!(
        topology
            .node(&RoadNodeId::new("osm:node:7").expect("valid id"))
            .is_none()
    );
    assert_eq!(
        topology.degree(&RoadNodeId::new("osm:node:6").expect("valid id")),
        2
    );
}

#[test]
fn fixture_topology_joins_the_roads_that_share_a_node() {
    // Ways 101 [1,2,3], 102 [4,5], 105 [5,6] and 106 [6,7,3]. Nodes 3, 5 and 6
    // are each seen twice, so five nodes carry four segments.
    let dataset = import_fixture();
    let topology = dataset.topology();
    assert_eq!(topology.node_count(), 5);
    assert_eq!(topology.segment_count(), 4);

    let ids: Vec<String> = topology
        .nodes()
        .iter()
        .map(|node| node.id().as_str().to_owned())
        .collect();
    assert_eq!(
        ids,
        vec![
            "osm:node:1",
            "osm:node:3",
            "osm:node:4",
            "osm:node:5",
            "osm:node:6"
        ]
    );
    let degree = |id: &str| topology.degree(&RoadNodeId::new(id).expect("valid id"));
    assert_eq!(degree("osm:node:1"), 1);
    assert_eq!(degree("osm:node:3"), 2);
    assert_eq!(degree("osm:node:4"), 1);
    assert_eq!(degree("osm:node:5"), 2);
    assert_eq!(degree("osm:node:6"), 2);
    // Node 2 is a shape point; nodes 8 and 999 never entered a path at all.
    for absent in ["osm:node:2", "osm:node:8", "osm:node:999"] {
        assert!(
            topology
                .node(&RoadNodeId::new(absent).expect("valid id"))
                .is_none()
        );
    }
}

#[test]
fn fixture_bounds_come_from_the_imported_features_only() {
    let dataset = import_fixture();
    let bounds = dataset.bounds().expect("bounds are derived");
    assert_eq!(bounds.west(), 51.3860);
    assert_eq!(bounds.south(), 35.6890);
    assert_eq!(bounds.east(), 51.3930);
    assert_eq!(bounds.north(), 35.6960);
}

#[test]
fn fixture_import_is_reproducible() {
    let first = import_fixture();
    let second = import_fixture();
    assert_eq!(feature_ids(&first), feature_ids(&second));
    assert_eq!(first.report().stats(), second.report().stats());
}

#[test]
fn fixture_carries_openstreetmap_attribution() {
    let dataset = import_fixture();
    let attribution = dataset.attribution().expect("attribution present");
    assert_eq!(attribution.text(), "© OpenStreetMap contributors");
    assert_eq!(
        attribution.license_url(),
        "https://www.openstreetmap.org/copyright"
    );
    assert_eq!(dataset.source().name(), "roads-basic.osm");
    assert_eq!(dataset.source().format(), "osm-xml");
}
