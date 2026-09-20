//! Integration test: the directionality fixture, imported through the real
//! engine path (OSM source -> DatasetBuilder -> immutable Dataset).
//!
//! The expected directions are written out in full, one row per way, so that
//! a change to any precedence rule has to be re-stated here deliberately
//! rather than absorbed silently.

use std::path::PathBuf;

use atlas_engine::{Dataset, DatasetBuilder, DatasetId, ImportStats, IssueCode, MapSource};
use atlas_kernel::{MapFeature, RoadTraversal, TravelDirection, TravelMode};
use atlas_osm::OsmXmlSource;

use TravelDirection::{Alternating, Both, Forward, Indeterminate, Reverse, Reversible};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/roads-directionality.osm")
}

fn import_fixture() -> Dataset {
    let source = OsmXmlSource::from_path(fixture_path());
    let mut builder = DatasetBuilder::new(
        DatasetId::new("ds-directionality"),
        MapSource::source_metadata(&source),
    );
    let outcome = source
        .import(&mut builder)
        .expect("the fixture must import");
    builder
        .finish(outcome)
        .expect("the fixture produces features")
}

fn feature<'a>(dataset: &'a Dataset, id: &str) -> &'a MapFeature {
    dataset
        .features()
        .iter()
        .find(|feature| feature.id().as_str() == id)
        .unwrap_or_else(|| panic!("{id} is imported"))
}

fn traversal(dataset: &Dataset, id: &str) -> RoadTraversal {
    *feature(dataset, id)
        .kind()
        .road_traversal()
        .unwrap_or_else(|| panic!("{id} is a road"))
}

/// Every way in the fixture, with the direction each mode must end up with.
const EXPECTED: [(
    &str,
    &str,
    TravelDirection,
    TravelDirection,
    TravelDirection,
); 17] = [
    ("osm:way:301", "Two-Way Residential", Both, Both, Both),
    ("osm:way:302", "Forward One-Way", Forward, Forward, Both),
    ("osm:way:303", "Reverse One-Way", Reverse, Reverse, Both),
    (
        "osm:way:304",
        "Contraflow Cycle Street",
        Forward,
        Both,
        Both,
    ),
    ("osm:way:305", "Implicit Roundabout", Forward, Forward, Both),
    ("osm:way:306", "Two-Way Roundabout", Both, Both, Both),
    ("osm:way:307", "Implicit Motorway", Forward, Forward, Both),
    (
        "osm:way:308",
        "Independent Overrides Road",
        Reverse,
        Both,
        Forward,
    ),
    (
        "osm:way:309",
        "Reversible Ramp",
        Reversible,
        Reversible,
        Both,
    ),
    (
        "osm:way:310",
        "Alternating Tunnel",
        Alternating,
        Alternating,
        Both,
    ),
    (
        "osm:way:311",
        "Unsupported Value Street",
        Indeterminate,
        Indeterminate,
        Both,
    ),
    (
        "osm:way:312",
        "Ambiguous Footway",
        Forward,
        Forward,
        Indeterminate,
    ),
    (
        "osm:way:313",
        "Conditional Corridor",
        Indeterminate,
        Indeterminate,
        Both,
    ),
    ("osm:way:314", "One-Way Steps", Forward, Forward, Forward),
    ("osm:way:315", "Legacy Alias Lane", Forward, Forward, Both),
    (
        "osm:way:316",
        "Ambiguous Path",
        Reverse,
        Reverse,
        Indeterminate,
    ),
    (
        "osm:way:317",
        "Unknown Motorcar Override",
        Indeterminate,
        Forward,
        Both,
    ),
];

#[test]
fn fixture_produces_the_documented_counters() {
    let dataset = import_fixture();
    let stats = dataset.report().stats();

    assert_eq!(
        *stats,
        ImportStats {
            nodes_seen: 53,
            nodes_indexed: 53,
            ways_seen: 17,
            road_ways_selected: 17,
            features_emitted: 17,
            features_skipped: 0,
            relations_seen: 0,
            bytes_read: stats.bytes_read,
        }
    );
    assert!(stats.bytes_read.is_some_and(|bytes| bytes > 0));
    assert_eq!(dataset.feature_count(), 17);
}

#[test]
fn fixture_emits_exactly_the_expected_feature_ids_in_order() {
    let dataset = import_fixture();
    let ids: Vec<&str> = dataset
        .features()
        .iter()
        .map(|feature| feature.id().as_str())
        .collect();
    let expected: Vec<&str> = EXPECTED.iter().map(|(id, ..)| *id).collect();
    assert_eq!(ids, expected);
}

#[test]
fn fixture_names_every_road_so_the_inspector_is_readable() {
    let dataset = import_fixture();
    for (id, name, ..) in EXPECTED {
        assert_eq!(feature(&dataset, id).name(), Some(name));
    }
}

#[test]
fn fixture_derives_the_documented_direction_for_every_mode() {
    let dataset = import_fixture();
    for (id, name, motorcar, bicycle, foot) in EXPECTED {
        let traversal = traversal(&dataset, id);
        assert_eq!(traversal.motorcar(), motorcar, "{id} ({name}) motorcar");
        assert_eq!(traversal.bicycle(), bicycle, "{id} ({name}) bicycle");
        assert_eq!(traversal.foot(), foot, "{id} ({name}) foot");
        // The mode accessor and the named accessors describe one value.
        assert_eq!(traversal.direction(TravelMode::Motorcar), motorcar);
        assert_eq!(traversal.direction(TravelMode::Bicycle), bicycle);
        assert_eq!(traversal.direction(TravelMode::Foot), foot);
    }
}

#[test]
fn fixture_reports_exactly_the_three_direction_warnings() {
    let dataset = import_fixture();
    let issues = dataset.report().issues();

    assert_eq!(issues.count_of(IssueCode::UnknownOnewayValue), 2);
    assert_eq!(
        issues.samples_of(IssueCode::UnknownOnewayValue),
        &["way/311", "way/317"]
    );

    assert_eq!(issues.count_of(IssueCode::AmbiguousOnewayScope), 2);
    assert_eq!(
        issues.samples_of(IssueCode::AmbiguousOnewayScope),
        &["way/312", "way/316"]
    );

    assert_eq!(issues.count_of(IssueCode::UnsupportedConditionalOneway), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedConditionalOneway),
        &["way/313"]
    );

    // Nothing else went wrong: this fixture is about direction only.
    let codes: Vec<IssueCode> = issues.groups().map(|group| group.code()).collect();
    assert_eq!(
        codes,
        vec![
            IssueCode::UnknownOnewayValue,
            IssueCode::AmbiguousOnewayScope,
            IssueCode::UnsupportedConditionalOneway,
        ]
    );

    for group in issues.groups() {
        assert!(group.samples().len() <= atlas_engine::IssueLog::DEFAULT_MAX_SAMPLES);
    }
}

#[test]
fn a_direction_warning_is_recorded_once_per_way_however_many_tags_caused_it() {
    // Way 313 carries both a plain `oneway` and a conditional one, and way 317
    // carries a plain value and an unreadable override. Each earns exactly one
    // warning, so the counts above are counts of roads, not counts of tags.
    let dataset = import_fixture();
    let issues = dataset.report().issues();
    let total: u64 = issues.groups().map(|group| group.count()).sum();
    assert_eq!(total, 5);
}

#[test]
fn geometry_is_never_reversed_to_express_a_direction() {
    // Way 303 is a reverse one-way. Its coordinates must still run west to
    // east exactly as the source wrote them: the direction lives in the
    // semantics, never in the geometry.
    let dataset = import_fixture();
    let reverse = feature(&dataset, "osm:way:303");
    let atlas_kernel::Geometry::LineString(line) = reverse.geometry();
    let longitudes: Vec<f64> = line
        .coordinates()
        .iter()
        .map(|coordinate| coordinate.longitude_degrees())
        .collect();
    assert_eq!(longitudes, vec![51.3900, 51.3915, 51.3930]);
    assert_eq!(traversal(&dataset, "osm:way:303").motorcar(), Reverse);

    // The forward one-way alongside it has the very same geometry.
    let forward = feature(&dataset, "osm:way:302");
    let atlas_kernel::Geometry::LineString(forward_line) = forward.geometry();
    let forward_longitudes: Vec<f64> = forward_line
        .coordinates()
        .iter()
        .map(|coordinate| coordinate.longitude_degrees())
        .collect();
    assert_eq!(longitudes, forward_longitudes);
}

#[test]
fn fixture_import_is_reproducible() {
    let first = import_fixture();
    let second = import_fixture();
    assert_eq!(first.report().stats(), second.report().stats());
    assert_eq!(first.report().issues(), second.report().issues());
    for (id, ..) in EXPECTED {
        assert_eq!(traversal(&first, id), traversal(&second, id));
    }
}

#[test]
fn fixture_bounds_cover_every_road_including_the_roundabouts() {
    let dataset = import_fixture();
    let bounds = dataset.bounds().expect("bounds are derived");
    assert_eq!(bounds.west(), 51.3900);
    assert_eq!(bounds.east(), 51.3955);
    assert_eq!(bounds.south(), 35.6910);
    assert_eq!(bounds.north(), 35.6985);
}

#[test]
fn fixture_carries_openstreetmap_attribution() {
    let dataset = import_fixture();
    let attribution = dataset.attribution().expect("attribution present");
    assert_eq!(attribution.text(), "© OpenStreetMap contributors");
    assert_eq!(dataset.source().name(), "roads-directionality.osm");
    assert_eq!(dataset.source().format(), "osm-xml");
}
