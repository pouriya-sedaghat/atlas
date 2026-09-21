//! Integration test: the synthetic topology fixture, imported through the real
//! engine path (OSM source -> DatasetBuilder -> immutable Dataset).
//!
//! Every expected count, identifier and degree is written out in full. If the
//! derivation changes, this test has to be edited deliberately.

use std::collections::BTreeMap;
use std::path::PathBuf;

use atlas_engine::{
    Dataset, DatasetBuilder, DatasetId, ImportStats, IssueCode, MapSource, RoadTopology,
};
use atlas_kernel::{RoadNodeId, TravelDirection, TravelMode};
use atlas_osm::OsmXmlSource;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-topology.osm")
}

fn import_fixture() -> Dataset {
    let source = OsmXmlSource::from_path(fixture_path());
    let mut builder = DatasetBuilder::new(
        DatasetId::new("ds-topology"),
        MapSource::source_metadata(&source),
    );
    let outcome = source
        .import(&mut builder)
        .expect("the fixture must import");
    builder
        .finish(outcome)
        .expect("the fixture produces features and topology")
}

fn node_id(value: &str) -> RoadNodeId {
    RoadNodeId::new(value).expect("valid node id")
}

fn node_ids(topology: &RoadTopology) -> Vec<String> {
    topology
        .nodes()
        .iter()
        .map(|node| node.id().as_str().to_owned())
        .collect()
}

fn segment_ids(topology: &RoadTopology) -> Vec<String> {
    topology
        .segments()
        .iter()
        .map(|segment| segment.id().as_str().to_owned())
        .collect()
}

/// The segments derived from one road, in id order.
fn segments_of(topology: &RoadTopology, road: &str) -> Vec<String> {
    topology
        .segments()
        .iter()
        .filter(|segment| segment.road().as_str() == road)
        .map(|segment| segment.id().as_str().to_owned())
        .collect()
}

/// The `(start, end)` node ids of one segment.
fn ends_of(topology: &RoadTopology, segment: &str) -> (String, String) {
    let found = topology
        .segments()
        .iter()
        .find(|candidate| candidate.id().as_str() == segment)
        .unwrap_or_else(|| panic!("segment {segment} exists"));
    (
        found.start().as_str().to_owned(),
        found.end().as_str().to_owned(),
    )
}

#[test]
fn fixture_produces_the_documented_counters() {
    let dataset = import_fixture();
    let stats = dataset.report().stats();

    assert_eq!(
        *stats,
        ImportStats {
            nodes_seen: 38,
            nodes_indexed: 38,
            ways_seen: 18,
            road_ways_selected: 17,
            features_emitted: 16,
            features_skipped: 1,
            relations_seen: 1,
            bytes_read: stats.bytes_read,
        }
    );
    assert!(stats.bytes_read.is_some_and(|bytes| bytes > 0));
    assert_eq!(dataset.feature_count(), 16);
}

#[test]
fn fixture_reports_exactly_two_warnings() {
    let dataset = import_fixture();
    let issues = dataset.report().issues();

    assert_eq!(issues.count_of(IssueCode::MissingNodeReference), 1);
    assert_eq!(
        issues.samples_of(IssueCode::MissingNodeReference),
        &["way/614"]
    );
    assert_eq!(issues.count_of(IssueCode::UnsupportedRelation), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedRelation),
        &["relation/700"]
    );

    // And nothing else. Deriving valid topology needs no new issue code, and
    // it must not broaden an old one either.
    let recorded: Vec<IssueCode> = issues.groups().map(|group| group.code()).collect();
    assert_eq!(
        recorded,
        vec![
            IssueCode::MissingNodeReference,
            IssueCode::UnsupportedRelation
        ]
    );
}

#[test]
fn fixture_emits_exactly_the_expected_features() {
    let dataset = import_fixture();
    let ids: Vec<String> = dataset
        .features()
        .iter()
        .map(|feature| feature.id().as_str().to_owned())
        .collect();
    assert_eq!(
        ids,
        vec![
            "osm:way:601",
            "osm:way:602",
            "osm:way:603",
            "osm:way:604",
            "osm:way:605",
            "osm:way:606",
            "osm:way:607",
            "osm:way:608",
            "osm:way:609",
            "osm:way:610",
            "osm:way:611",
            "osm:way:612",
            "osm:way:613",
            "osm:way:615",
            "osm:way:616",
            "osm:way:617",
        ]
    );
    // Way 614 was skipped and way 900 is not a road.
    assert!(!ids.iter().any(|id| id == "osm:way:614"));
    assert!(!ids.iter().any(|id| id == "osm:way:900"));
}

#[test]
fn fixture_produces_the_documented_topology_totals() {
    let dataset = import_fixture();
    let topology = dataset.topology();
    assert_eq!(topology.node_count(), 31);
    assert_eq!(topology.segment_count(), 22);
}

#[test]
fn fixture_promotes_exactly_the_expected_nodes() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    // The 31 public nodes: every path endpoint, plus nodes 9 and 23, which are
    // internal everywhere they appear but appear more than once.
    assert_eq!(
        node_ids(topology),
        vec![
            "osm:node:1",
            "osm:node:10",
            "osm:node:11",
            "osm:node:12",
            "osm:node:13",
            "osm:node:14",
            "osm:node:15",
            "osm:node:16",
            "osm:node:17",
            "osm:node:18",
            "osm:node:19",
            "osm:node:20",
            "osm:node:21",
            "osm:node:22",
            "osm:node:23",
            "osm:node:25",
            "osm:node:26",
            "osm:node:28",
            "osm:node:3",
            "osm:node:31",
            "osm:node:33",
            "osm:node:34",
            "osm:node:36",
            "osm:node:37",
            "osm:node:38",
            "osm:node:4",
            "osm:node:5",
            "osm:node:6",
            "osm:node:7",
            "osm:node:8",
            "osm:node:9",
        ]
    );

    // The seven source nodes that are deliberately not topology nodes.
    //
    //   2, 24, 32, 35 — seen once, in the middle of one way: shape points.
    //   27           — on a road once; way 900 is not a road and cannot count.
    //   29           — only ever on the non-road way.
    //   30           — only on way 614, which was skipped.
    for absent in ["2", "24", "27", "29", "30", "32", "35"] {
        let id = node_id(&format!("osm:node:{absent}"));
        assert!(
            topology.node(&id).is_none(),
            "osm:node:{absent} must not be a topology node"
        );
        assert_eq!(topology.degree(&id), 0);
    }
}

#[test]
fn fixture_produces_exactly_the_expected_segments() {
    let dataset = import_fixture();
    assert_eq!(
        segment_ids(dataset.topology()),
        vec![
            "osm:way:601:segment:0",
            "osm:way:602:segment:0",
            "osm:way:603:segment:0",
            "osm:way:604:segment:0",
            "osm:way:605:segment:0",
            "osm:way:605:segment:1",
            "osm:way:606:segment:0",
            "osm:way:606:segment:1",
            "osm:way:607:segment:0",
            "osm:way:608:segment:0",
            "osm:way:609:segment:0",
            "osm:way:609:segment:1",
            "osm:way:609:segment:2",
            "osm:way:610:segment:0",
            "osm:way:611:segment:0",
            "osm:way:612:segment:0",
            "osm:way:612:segment:1",
            "osm:way:612:segment:2",
            "osm:way:613:segment:0",
            "osm:way:615:segment:0",
            "osm:way:616:segment:0",
            "osm:way:617:segment:0",
        ]
    );
}

#[test]
fn case_simple_road_keeps_its_shape_point_out_of_the_graph() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:601"),
        vec!["osm:way:601:segment:0"]
    );
    assert_eq!(
        ends_of(topology, "osm:way:601:segment:0"),
        ("osm:node:1".to_owned(), "osm:node:3".to_owned())
    );
    // Node 2 is still drawn — it is the middle coordinate of the segment.
    let segment = &topology.segments()[0];
    assert_eq!(segment.geometry().coordinate_count(), 3);
    assert_eq!(topology.degree(&node_id("osm:node:1")), 1);
    assert_eq!(topology.degree(&node_id("osm:node:3")), 1);
}

#[test]
fn case_t_junction_has_one_node_of_degree_three_and_three_segments() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    for road in ["osm:way:602", "osm:way:603", "osm:way:604"] {
        assert_eq!(segments_of(topology, road).len(), 1, "{road}");
    }
    assert_eq!(topology.degree(&node_id("osm:node:5")), 3);
    assert_eq!(topology.segments_at(&node_id("osm:node:5")).len(), 3);
    for arm in ["4", "6", "7"] {
        assert_eq!(topology.degree(&node_id(&format!("osm:node:{arm}"))), 1);
    }
}

#[test]
fn case_shared_node_cross_has_one_node_of_degree_four_and_four_segments() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:605"),
        vec!["osm:way:605:segment:0", "osm:way:605:segment:1"]
    );
    assert_eq!(
        segments_of(topology, "osm:way:606"),
        vec!["osm:way:606:segment:0", "osm:way:606:segment:1"]
    );
    assert_eq!(topology.degree(&node_id("osm:node:9")), 4);
    assert_eq!(topology.segments_at(&node_id("osm:node:9")).len(), 4);
    assert_eq!(
        ends_of(topology, "osm:way:605:segment:0"),
        ("osm:node:8".to_owned(), "osm:node:9".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:606:segment:1"),
        ("osm:node:9".to_owned(), "osm:node:12".to_owned())
    );
}

#[test]
fn case_geometric_only_cross_stays_two_disconnected_segments() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(segments_of(topology, "osm:way:607").len(), 1);
    assert_eq!(segments_of(topology, "osm:way:608").len(), 1);
    // Every endpoint has degree one: nothing on either line meets anything.
    for endpoint in ["13", "14", "15", "16"] {
        let id = node_id(&format!("osm:node:{endpoint}"));
        assert_eq!(topology.degree(&id), 1);
        assert_eq!(topology.segments_at(&id).len(), 1);
    }
    // The two lines really do cross on the page: their bounding boxes overlap
    // and each one passes through the other's box.
    let first = topology
        .segments()
        .iter()
        .find(|segment| segment.road().as_str() == "osm:way:607")
        .expect("way 607 has a segment");
    let second = topology
        .segments()
        .iter()
        .find(|segment| segment.road().as_str() == "osm:way:608")
        .expect("way 608 has a segment");
    assert!(
        first
            .geometry()
            .intersects_bounding_box(second.geometry().bounds())
    );
    // And they still share no node.
    assert_ne!(first.start(), second.start());
    assert_ne!(first.start(), second.end());
    assert_ne!(first.end(), second.start());
    assert_ne!(first.end(), second.end());
}

#[test]
fn case_roundabout_splits_into_three_segments_with_two_degree_three_nodes() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:609"),
        vec![
            "osm:way:609:segment:0",
            "osm:way:609:segment:1",
            "osm:way:609:segment:2"
        ]
    );
    assert_eq!(
        ends_of(topology, "osm:way:609:segment:0"),
        ("osm:node:17".to_owned(), "osm:node:18".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:609:segment:1"),
        ("osm:node:18".to_owned(), "osm:node:19".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:609:segment:2"),
        ("osm:node:19".to_owned(), "osm:node:17".to_owned())
    );

    // The ring closes: node 17 is both the first and the last point.
    assert_eq!(topology.degree(&node_id("osm:node:17")), 2);
    // The two approach nodes carry three ends each.
    assert_eq!(topology.degree(&node_id("osm:node:18")), 3);
    assert_eq!(topology.degree(&node_id("osm:node:19")), 3);
    assert_eq!(topology.degree(&node_id("osm:node:20")), 1);
    assert_eq!(topology.degree(&node_id("osm:node:21")), 1);

    // Five segments across the ring and its two approaches.
    let ring_group: usize = ["osm:way:609", "osm:way:610", "osm:way:611"]
        .iter()
        .map(|road| segments_of(topology, road).len())
        .sum();
    assert_eq!(ring_group, 5);
}

#[test]
fn case_repeated_internal_node_forms_a_self_loop_of_degree_four() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:612"),
        vec![
            "osm:way:612:segment:0",
            "osm:way:612:segment:1",
            "osm:way:612:segment:2"
        ]
    );
    assert_eq!(
        ends_of(topology, "osm:way:612:segment:0"),
        ("osm:node:22".to_owned(), "osm:node:23".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:612:segment:1"),
        ("osm:node:23".to_owned(), "osm:node:23".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:612:segment:2"),
        ("osm:node:23".to_owned(), "osm:node:25".to_owned())
    );

    let middle = topology
        .segments()
        .iter()
        .find(|segment| segment.id().as_str() == "osm:way:612:segment:1")
        .expect("the middle segment exists");
    assert!(middle.is_loop());
    // 23 -> 24 -> 23: the shape point in the middle is kept.
    assert_eq!(middle.geometry().coordinate_count(), 3);

    // Two ordinary ends plus the loop's two.
    assert_eq!(topology.degree(&node_id("osm:node:23")), 4);
    assert_eq!(topology.segments_at(&node_id("osm:node:23")).len(), 3);
    assert!(topology.node(&node_id("osm:node:24")).is_none());
}

#[test]
fn case_a_non_road_way_cannot_promote_a_point() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    // Way 900 passes through node 27 and is not a road, so node 27 is seen
    // exactly once by the topology and stays a shape coordinate.
    assert_eq!(
        segments_of(topology, "osm:way:613"),
        vec!["osm:way:613:segment:0"]
    );
    assert_eq!(
        ends_of(topology, "osm:way:613:segment:0"),
        ("osm:node:26".to_owned(), "osm:node:28".to_owned())
    );
    assert!(topology.node(&node_id("osm:node:27")).is_none());
    // And node 29, which only the non-road way names, is not there at all.
    assert!(topology.node(&node_id("osm:node:29")).is_none());
    // No segment anywhere belongs to the non-road way.
    assert!(
        topology
            .segments()
            .iter()
            .all(|segment| segment.road().as_str() != "osm:way:900")
    );
}

#[test]
fn case_a_skipped_road_produces_no_path_node_or_segment() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert!(segments_of(topology, "osm:way:614").is_empty());
    assert!(topology.node(&node_id("osm:node:30")).is_none());
    assert!(topology.node(&node_id("osm:node:999")).is_none());
}

#[test]
fn case_a_reverse_one_way_is_not_reversed_by_the_topology() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:615"),
        vec!["osm:way:615:segment:0"]
    );
    // Source order, not travel order: the segment runs 31 -> 33 because that
    // is how the way was drawn, even though the traffic runs the other way.
    assert_eq!(
        ends_of(topology, "osm:way:615:segment:0"),
        ("osm:node:31".to_owned(), "osm:node:33".to_owned())
    );

    let segment = topology
        .segments()
        .iter()
        .find(|candidate| candidate.id().as_str() == "osm:way:615:segment:0")
        .expect("the segment exists");
    let coordinates = segment.geometry().coordinates();
    assert_eq!(coordinates.len(), 3);
    assert_eq!(coordinates[0].longitude_degrees(), 51.3800);
    assert_eq!(coordinates[2].longitude_degrees(), 51.3840);

    // The road itself still says it is a reverse one-way. The two facts live
    // side by side and neither is derived from the other.
    let road = dataset
        .features()
        .iter()
        .find(|feature| feature.id().as_str() == "osm:way:615")
        .expect("way 615 is imported");
    assert_eq!(
        road.kind()
            .road_traversal()
            .map(|traversal| traversal.direction(TravelMode::Motorcar)),
        Some(TravelDirection::Reverse)
    );
    // And its geometry is in source order too, exactly as before this
    // milestone existed.
    assert_eq!(
        road.geometry().coordinate_count(),
        segment.geometry().coordinate_count()
    );
}

#[test]
fn case_one_coordinate_with_two_identities_is_not_one_node() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    assert_eq!(
        segments_of(topology, "osm:way:616"),
        vec!["osm:way:616:segment:0"]
    );
    assert_eq!(
        segments_of(topology, "osm:way:617"),
        vec!["osm:way:617:segment:0"]
    );
    assert_eq!(
        ends_of(topology, "osm:way:616:segment:0"),
        ("osm:node:34".to_owned(), "osm:node:36".to_owned())
    );
    assert_eq!(
        ends_of(topology, "osm:way:617:segment:0"),
        ("osm:node:37".to_owned(), "osm:node:38".to_owned())
    );

    // Node 35 sits exactly on node 37 and is still only a shape point.
    assert!(topology.node(&node_id("osm:node:35")).is_none());
    let joined = topology
        .node(&node_id("osm:node:37"))
        .expect("node 37 starts a way, so it is a node");
    assert_eq!(joined.coordinate().longitude_degrees(), 51.3920);
    assert_eq!(joined.coordinate().latitude_degrees(), 35.6020);
    // Degree one on both sides: the shared coordinate joined nothing.
    assert_eq!(topology.degree(&node_id("osm:node:34")), 1);
    assert_eq!(topology.degree(&node_id("osm:node:36")), 1);
    assert_eq!(topology.degree(&node_id("osm:node:37")), 1);
    assert_eq!(topology.degree(&node_id("osm:node:38")), 1);
}

#[test]
fn every_node_degree_is_pinned() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    let actual: BTreeMap<String, usize> = topology
        .nodes()
        .iter()
        .map(|node| (node.id().as_str().to_owned(), topology.degree(node.id())))
        .collect();

    let expected: BTreeMap<String, usize> = [
        ("osm:node:1", 1),
        ("osm:node:3", 1),
        ("osm:node:4", 1),
        ("osm:node:5", 3),
        ("osm:node:6", 1),
        ("osm:node:7", 1),
        ("osm:node:8", 1),
        ("osm:node:9", 4),
        ("osm:node:10", 1),
        ("osm:node:11", 1),
        ("osm:node:12", 1),
        ("osm:node:13", 1),
        ("osm:node:14", 1),
        ("osm:node:15", 1),
        ("osm:node:16", 1),
        ("osm:node:17", 2),
        ("osm:node:18", 3),
        ("osm:node:19", 3),
        ("osm:node:20", 1),
        ("osm:node:21", 1),
        ("osm:node:22", 1),
        ("osm:node:23", 4),
        ("osm:node:25", 1),
        ("osm:node:26", 1),
        ("osm:node:28", 1),
        ("osm:node:31", 1),
        ("osm:node:33", 1),
        ("osm:node:34", 1),
        ("osm:node:36", 1),
        ("osm:node:37", 1),
        ("osm:node:38", 1),
    ]
    .into_iter()
    .map(|(id, degree)| (id.to_owned(), degree))
    .collect();

    assert_eq!(actual, expected);
    // Every segment end is accounted for exactly once in the degree sum.
    let total: usize = actual.values().sum();
    assert_eq!(total, topology.segment_count() * 2);
}

#[test]
fn every_segment_resolves_to_a_node_and_a_feature_of_this_dataset() {
    let dataset = import_fixture();
    let topology = dataset.topology();

    for segment in topology.segments() {
        for end in [segment.start(), segment.end()] {
            let node = topology
                .node(end)
                .unwrap_or_else(|| panic!("segment {} names node {end}", segment.id()));
            assert_eq!(node.id(), end);
        }
        assert!(
            dataset
                .features()
                .iter()
                .any(|feature| feature.id() == segment.road()),
            "segment {} belongs to a feature of this dataset",
            segment.id()
        );
        // The geometry really does start and end where the nodes say.
        let coordinates = segment.geometry().coordinates();
        assert_eq!(
            coordinates[0],
            topology
                .node(segment.start())
                .expect("start node")
                .coordinate()
        );
        assert_eq!(
            coordinates[coordinates.len() - 1],
            topology.node(segment.end()).expect("end node").coordinate()
        );
    }
}

#[test]
fn direction_access_and_speed_tags_change_nothing_about_the_topology() {
    // The same three-point way, once plain and once carrying every kind of
    // tag the brief forbids the derivation from reading. Same nodes, same
    // segments, same degrees.
    let plain = r#"<osm version="0.6">
        <node id="1" lat="35.6" lon="51.3"/>
        <node id="2" lat="35.61" lon="51.31"/>
        <node id="3" lat="35.62" lon="51.32"/>
        <way id="1">
            <nd ref="1"/><nd ref="2"/><nd ref="3"/>
            <tag k="highway" v="residential"/>
        </way>
    </osm>"#;
    let loaded = r#"<osm version="0.6">
        <node id="1" lat="35.6" lon="51.3"/>
        <node id="2" lat="35.61" lon="51.31"/>
        <node id="3" lat="35.62" lon="51.32"/>
        <way id="1">
            <nd ref="1"/><nd ref="2"/><nd ref="3"/>
            <tag k="highway" v="motorway"/>
            <tag k="oneway" v="-1"/>
            <tag k="access" v="private"/>
            <tag k="motor_vehicle" v="no"/>
            <tag k="maxspeed" v="120"/>
            <tag k="maxspeed:backward" v="80"/>
            <tag k="junction" v="roundabout"/>
            <tag k="bridge" v="yes"/>
            <tag k="tunnel" v="yes"/>
            <tag k="layer" v="2"/>
            <tag k="level" v="-1"/>
            <tag k="barrier" v="gate"/>
        </way>
    </osm>"#;

    let build = |xml: &str| {
        let source = OsmXmlSource::from_xml("inline.osm", xml);
        let mut builder = DatasetBuilder::new(
            DatasetId::new("ds-inline"),
            MapSource::source_metadata(&source),
        );
        let outcome = source.import(&mut builder).expect("the document imports");
        builder.finish(outcome).expect("it produces a dataset")
    };

    let plain = build(plain);
    let loaded = build(loaded);
    assert_eq!(node_ids(plain.topology()), node_ids(loaded.topology()));
    assert_eq!(
        segment_ids(plain.topology()),
        segment_ids(loaded.topology())
    );
    assert_eq!(
        ends_of(plain.topology(), "osm:way:1:segment:0"),
        ends_of(loaded.topology(), "osm:way:1:segment:0")
    );
    assert_eq!(
        plain.topology().degree(&node_id("osm:node:1")),
        loaded.topology().degree(&node_id("osm:node:1"))
    );
    // The road facts did change, which is the point: they are a separate fact
    // that the topology ignored.
    assert_ne!(
        plain.features()[0].kind().road_class(),
        loaded.features()[0].kind().road_class()
    );
}

#[test]
fn fixture_import_is_reproducible() {
    let first = import_fixture();
    let second = import_fixture();
    assert_eq!(node_ids(first.topology()), node_ids(second.topology()));
    assert_eq!(
        segment_ids(first.topology()),
        segment_ids(second.topology())
    );
    assert_eq!(first.report().stats(), second.report().stats());
}

#[test]
fn fixture_carries_openstreetmap_attribution() {
    let dataset = import_fixture();
    let attribution = dataset.attribution().expect("attribution present");
    assert_eq!(attribution.text(), "© OpenStreetMap contributors");
    assert_eq!(dataset.source().name(), "roads-topology.osm");
    assert_eq!(dataset.source().format(), "osm-xml");
}
