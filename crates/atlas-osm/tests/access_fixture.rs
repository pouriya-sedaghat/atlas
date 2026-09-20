//! Integration test: the access fixture, imported through the real engine path
//! (OSM source -> DatasetBuilder -> immutable Dataset).
//!
//! The expected access rules are written out in full, one row per way, so that
//! a change to any precedence rule has to be re-stated here deliberately
//! rather than absorbed silently. The same table is in the fixture header.
//!
//! The direction column is here too, on purpose. Access derivation must not be
//! able to reach the direction of a road, and the only way to keep proving
//! that is to state both and assert both.

use std::path::PathBuf;

use atlas_engine::{Dataset, DatasetBuilder, DatasetId, ImportStats, IssueCode, MapSource};
use atlas_kernel::{
    AccessRule, MapFeature, RoadAccess, RoadTraversal, TravelDirection, TravelMode,
};
use atlas_osm::OsmXmlSource;

use AccessRule::{
    Allowed, Conditional, CustomersOnly, DeliveryOnly, Designated, DestinationOnly, Discouraged,
    DismountRequired, Indeterminate, Permissive, PermitRequired, Private, Prohibited, Unspecified,
    UseSidepath, Variable,
};
use TravelDirection::{Both, Forward, Reverse};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-access.osm")
}

fn import_fixture() -> Dataset {
    let source = OsmXmlSource::from_path(fixture_path());
    let mut builder = DatasetBuilder::new(
        DatasetId::new("ds-access"),
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

fn access(dataset: &Dataset, id: &str) -> RoadAccess {
    *feature(dataset, id)
        .kind()
        .road_access()
        .unwrap_or_else(|| panic!("{id} is a road"))
}

fn traversal(dataset: &Dataset, id: &str) -> RoadTraversal {
    *feature(dataset, id)
        .kind()
        .road_traversal()
        .unwrap_or_else(|| panic!("{id} is a road"))
}

/// One row of the expected table.
struct Expected {
    id: &'static str,
    name: &'static str,
    /// Access as motorcar / bicycle / foot.
    access: (AccessRule, AccessRule, AccessRule),
    /// Direction as motorcar / bicycle / foot, derived independently.
    direction: (TravelDirection, TravelDirection, TravelDirection),
}

const fn row(
    id: &'static str,
    name: &'static str,
    access: (AccessRule, AccessRule, AccessRule),
    direction: (TravelDirection, TravelDirection, TravelDirection),
) -> Expected {
    Expected {
        id,
        name,
        access,
        direction,
    }
}

/// Every way in the fixture, with the access and direction it must produce.
const EXPECTED: [Expected; 23] = [
    row(
        "osm:way:401",
        "Untagged Lane",
        (Unspecified, Unspecified, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:402",
        "Open Access Street",
        (Allowed, Allowed, Allowed),
        (Both, Both, Both),
    ),
    row(
        "osm:way:403",
        "Closed Access Street",
        (Prohibited, Prohibited, Prohibited),
        // Prohibited for everyone and still a forward one-way: the arrow does
        // not disappear because the road is closed.
        (Forward, Forward, Both),
    ),
    row(
        "osm:way:404",
        "Foot Exception Street",
        (Prohibited, Prohibited, Allowed),
        (Both, Both, Both),
    ),
    row(
        "osm:way:405",
        "Cycle Exception Street",
        (Prohibited, Allowed, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:406",
        "Destination Motor Road",
        (DestinationOnly, Unspecified, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:407",
        "Layered Override Street",
        (Private, Permissive, Allowed),
        (Reverse, Reverse, Both),
    ),
    row(
        "osm:way:408",
        "Designated Cycleway",
        (Unspecified, Designated, Unspecified),
        (Forward, Forward, Both),
    ),
    row(
        "osm:way:409",
        "Permissive Footpath",
        (Unspecified, Unspecified, Permissive),
        (Both, Both, Both),
    ),
    row(
        "osm:way:410",
        "Customers Car Park Road",
        (CustomersOnly, CustomersOnly, CustomersOnly),
        (Both, Both, Both),
    ),
    row(
        "osm:way:411",
        "Delivery Service Road",
        (DeliveryOnly, Unspecified, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:412",
        "Dismount Bridge Path",
        (Unspecified, DismountRequired, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:413",
        "Sidepath Cycle Street",
        (Unspecified, UseSidepath, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:414",
        "Permit Motorcar Track",
        (PermitRequired, Unspecified, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:415",
        "Discouraged Cycle Lane",
        (Unspecified, Discouraged, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:416",
        "Unknown Access Road",
        (Indeterminate, Indeterminate, Indeterminate),
        (Both, Both, Both),
    ),
    row(
        "osm:way:417",
        "Unreadable Motorcar Street",
        (Indeterminate, Allowed, Allowed),
        (Both, Both, Both),
    ),
    row(
        "osm:way:418",
        "Conditional Access Street",
        (Conditional, Conditional, Conditional),
        (Forward, Forward, Both),
    ),
    row(
        "osm:way:419",
        "Conditional With Foot Exception",
        (Conditional, Conditional, Allowed),
        (Both, Both, Both),
    ),
    row(
        "osm:way:420",
        "Conditional Vehicle Street",
        (Allowed, Conditional, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:421",
        "Conditional Motorcar Street",
        (Conditional, Unspecified, Unspecified),
        (Both, Both, Both),
    ),
    row(
        "osm:way:422",
        "Variable Access Street",
        (Variable, Variable, Variable),
        (Both, Both, Both),
    ),
    row(
        "osm:way:423",
        "Invalid Scope Street",
        (Indeterminate, Indeterminate, Indeterminate),
        (Both, Both, Both),
    ),
];

#[test]
fn fixture_produces_the_documented_counters() {
    let dataset = import_fixture();
    let stats = dataset.report().stats();

    assert_eq!(
        *stats,
        ImportStats {
            nodes_seen: 69,
            nodes_indexed: 69,
            ways_seen: 23,
            road_ways_selected: 23,
            features_emitted: 23,
            features_skipped: 0,
            relations_seen: 0,
            bytes_read: stats.bytes_read,
        }
    );
    assert!(stats.bytes_read.is_some_and(|bytes| bytes > 0));
    assert_eq!(dataset.feature_count(), 23);
}

#[test]
fn fixture_emits_exactly_the_expected_feature_ids_in_order() {
    let dataset = import_fixture();
    let ids: Vec<&str> = dataset
        .features()
        .iter()
        .map(|feature| feature.id().as_str())
        .collect();
    let expected: Vec<&str> = EXPECTED.iter().map(|row| row.id).collect();
    assert_eq!(ids, expected);
    // An access problem is never a reason to drop a road: all 23 are here.
    assert_eq!(ids.len(), 23);
}

#[test]
fn fixture_names_every_road_so_the_inspector_is_readable() {
    let dataset = import_fixture();
    for row in &EXPECTED {
        assert_eq!(feature(&dataset, row.id).name(), Some(row.name));
    }
}

#[test]
fn fixture_derives_the_documented_access_for_every_mode() {
    let dataset = import_fixture();
    for row in &EXPECTED {
        let access = access(&dataset, row.id);
        let (motorcar, bicycle, foot) = row.access;
        let what = format!("{} ({})", row.id, row.name);
        assert_eq!(access.motorcar(), motorcar, "{what} motorcar");
        assert_eq!(access.bicycle(), bicycle, "{what} bicycle");
        assert_eq!(access.foot(), foot, "{what} foot");
        // The mode accessor and the named accessors describe one value.
        assert_eq!(access.rule(TravelMode::Motorcar), motorcar);
        assert_eq!(access.rule(TravelMode::Bicycle), bicycle);
        assert_eq!(access.rule(TravelMode::Foot), foot);
    }
}

#[test]
fn fixture_shows_every_rule_but_the_three_activity_restrictions() {
    // The fixture is laid out for the eye: one road per row, one rule per
    // road, readable in Studio without scrolling. Three rules are left out of
    // it because `agricultural`, `forestry` and `military` behave exactly like
    // the purpose-limited rules already on show — same key, same precedence,
    // same overlay — and three more near-identical rows would cost a screen of
    // height to demonstrate nothing new.
    //
    // They are not untested. The adapter's value table covers all seventeen
    // static values, and the HTTP contract serialises all nineteen rules.
    //
    // This assertion is written as an exact partition rather than a
    // "contains": a twentieth rule added to the kernel lands in `missing` and
    // fails here, forcing a deliberate decision about whether the fixture
    // should grow a row for it.
    let shown: std::collections::BTreeSet<AccessRule> = EXPECTED
        .iter()
        .flat_map(|row| {
            let (motorcar, bicycle, foot) = row.access;
            [motorcar, bicycle, foot]
        })
        .collect();
    let all: std::collections::BTreeSet<AccessRule> = AccessRule::ALL.into_iter().collect();
    let missing: Vec<AccessRule> = all.difference(&shown).copied().collect();
    assert_eq!(
        missing,
        vec![
            AccessRule::AgriculturalOnly,
            AccessRule::ForestryOnly,
            AccessRule::MilitaryOnly,
        ]
    );
    assert_eq!(shown.len(), 16);
}

#[test]
fn fixture_reports_exactly_the_three_access_warnings() {
    let dataset = import_fixture();
    let issues = dataset.report().issues();

    assert_eq!(issues.count_of(IssueCode::UnknownAccessValue), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnknownAccessValue),
        &["way/417"]
    );

    assert_eq!(issues.count_of(IssueCode::InvalidAccessScope), 1);
    assert_eq!(
        issues.samples_of(IssueCode::InvalidAccessScope),
        &["way/423"]
    );

    assert_eq!(issues.count_of(IssueCode::UnsupportedConditionalAccess), 4);
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedConditionalAccess),
        &["way/418", "way/419", "way/420", "way/421"]
    );

    // Nothing else went wrong: this fixture is about access only. In
    // particular the orthogonal `oneway` tags produce no direction warnings,
    // and `access=unknown` on way 416 produces none either.
    let codes: Vec<IssueCode> = issues.groups().map(|group| group.code()).collect();
    assert_eq!(
        codes,
        vec![
            IssueCode::UnknownAccessValue,
            IssueCode::InvalidAccessScope,
            IssueCode::UnsupportedConditionalAccess,
        ]
    );

    for group in issues.groups() {
        assert!(group.samples().len() <= atlas_engine::IssueLog::DEFAULT_MAX_SAMPLES);
        assert_eq!(group.samples().len() as u64, group.count());
    }
}

#[test]
fn an_access_warning_is_recorded_once_per_road_however_many_tags_caused_it() {
    // Way 417 carries a readable `access` and an unreadable `motorcar`; way
    // 423's single scope problem reaches two modes; way 418's conditional
    // reaches all three. Each earns exactly one warning, so the counts above
    // are counts of roads, not counts of tags or of modes.
    let dataset = import_fixture();
    let issues = dataset.report().issues();
    let total: u64 = issues.groups().map(|group| group.count()).sum();
    assert_eq!(total, 6);
}

#[test]
fn a_recognised_unknown_value_never_warns() {
    // Way 416 is `access=unknown`: indeterminate, and not a data problem.
    let dataset = import_fixture();
    let rules = access(&dataset, "osm:way:416");
    for mode in TravelMode::ALL {
        assert_eq!(rules.rule(mode), Indeterminate);
    }
    assert_eq!(
        dataset
            .report()
            .issues()
            .count_of(IssueCode::UnknownAccessValue),
        1,
        "only way 417 may contribute to UNKNOWN_ACCESS_VALUE"
    );
}

#[test]
fn fixture_derives_the_documented_direction_for_every_mode() {
    // Direction is derived from the direction tags alone. An access tag must
    // not be able to change it, and the four orthogonal `oneway` tags must
    // still read exactly as they would with no access tag in sight.
    let dataset = import_fixture();
    for row in &EXPECTED {
        let traversal = traversal(&dataset, row.id);
        let (motorcar, bicycle, foot) = row.direction;
        let what = format!("{} ({})", row.id, row.name);
        assert_eq!(traversal.motorcar(), motorcar, "{what} motorcar");
        assert_eq!(traversal.bicycle(), bicycle, "{what} bicycle");
        assert_eq!(traversal.foot(), foot, "{what} foot");
    }
}

#[test]
fn a_prohibited_road_keeps_its_direction() {
    // Way 403 is closed to everyone and is still a forward one-way. This is
    // the case the whole "access is not direction" rule exists for.
    let dataset = import_fixture();
    assert_eq!(access(&dataset, "osm:way:403").motorcar(), Prohibited);
    assert_eq!(traversal(&dataset, "osm:way:403").motorcar(), Forward);

    // And the reverse one-way with a private car restriction keeps both.
    assert_eq!(access(&dataset, "osm:way:407").motorcar(), Private);
    assert_eq!(traversal(&dataset, "osm:way:407").motorcar(), Reverse);

    // A road that is two-way for everyone can still be closed to everyone.
    assert_eq!(
        traversal(&dataset, "osm:way:410"),
        RoadTraversal::bidirectional()
    );
    assert_eq!(access(&dataset, "osm:way:410").motorcar(), CustomersOnly);
}

#[test]
fn access_and_direction_disagree_about_which_roads_are_interesting() {
    // If one were derived from the other, these two groupings would line up.
    // They do not: 403 and 418 share a direction and differ in access, 403 and
    // 404 share an access chain start and differ in direction.
    let dataset = import_fixture();
    assert_eq!(
        traversal(&dataset, "osm:way:403"),
        traversal(&dataset, "osm:way:418")
    );
    assert_ne!(
        access(&dataset, "osm:way:403"),
        access(&dataset, "osm:way:418")
    );
    assert_ne!(
        traversal(&dataset, "osm:way:403"),
        traversal(&dataset, "osm:way:404")
    );
}

#[test]
fn access_is_not_derived_from_the_road_class() {
    // Two residential streets with different access, and two roads of
    // different classes with the same access. The class explains neither.
    let dataset = import_fixture();
    let class_of = |id: &str| {
        feature(&dataset, id)
            .kind()
            .road_class()
            .expect("a road")
            .as_str()
            .to_owned()
    };

    assert_eq!(class_of("osm:way:401"), "residential");
    assert_eq!(class_of("osm:way:403"), "residential");
    assert_ne!(
        access(&dataset, "osm:way:401"),
        access(&dataset, "osm:way:403")
    );

    // A cycleway and a footway are both silent about the motorcar, and so is
    // the untagged residential street: Atlas does not invent a prohibition
    // from the class.
    assert_eq!(class_of("osm:way:408"), "cycleway");
    assert_eq!(class_of("osm:way:409"), "footway");
    for id in ["osm:way:401", "osm:way:408", "osm:way:409"] {
        assert_eq!(
            access(&dataset, id).motorcar(),
            Unspecified,
            "{id} must not gain a motorcar rule from its class"
        );
    }
}

#[test]
fn geometry_is_never_changed_by_access_derivation() {
    // Every road runs west to east with the same three longitudes, whatever
    // its access says. A prohibited road is not a reversed or truncated one.
    let dataset = import_fixture();
    for row in &EXPECTED {
        let atlas_kernel::Geometry::LineString(line) = feature(&dataset, row.id).geometry();
        let longitudes: Vec<f64> = line
            .coordinates()
            .iter()
            .map(|coordinate| coordinate.longitude_degrees())
            .collect();
        assert_eq!(
            longitudes,
            vec![51.3900, 51.3915, 51.3930],
            "{} lost or reordered its coordinates",
            row.id
        );
    }

    // The reverse one-way is drawn in exactly the same order as the rest.
    let atlas_kernel::Geometry::LineString(reverse) = feature(&dataset, "osm:way:407").geometry();
    assert_eq!(
        reverse.coordinates().first().map(|c| c.longitude_degrees()),
        Some(51.3900)
    );
    assert_eq!(traversal(&dataset, "osm:way:407").motorcar(), Reverse);
}

#[test]
fn fixture_import_is_reproducible() {
    let first = import_fixture();
    let second = import_fixture();
    assert_eq!(first.report().stats(), second.report().stats());
    assert_eq!(first.report().issues(), second.report().issues());
    for row in &EXPECTED {
        assert_eq!(access(&first, row.id), access(&second, row.id));
        assert_eq!(traversal(&first, row.id), traversal(&second, row.id));
    }
}

#[test]
fn fixture_bounds_cover_every_row() {
    let dataset = import_fixture();
    let bounds = dataset.bounds().expect("bounds are derived");
    assert_eq!(bounds.west(), 51.3900);
    assert_eq!(bounds.east(), 51.3930);
    assert_eq!(bounds.south(), 35.6990);
    assert_eq!(bounds.north(), 35.7100);
}

#[test]
fn fixture_carries_openstreetmap_attribution() {
    let dataset = import_fixture();
    let attribution = dataset.attribution().expect("attribution present");
    assert_eq!(attribution.text(), "© OpenStreetMap contributors");
    assert_eq!(dataset.source().name(), "roads-access.osm");
    assert_eq!(dataset.source().format(), "osm-xml");
}

#[test]
fn the_other_fixtures_are_untouched_and_still_say_nothing_about_access() {
    // roads-basic and roads-directionality have no access tags, so every road
    // in them must serialise as `unspecified` — the honest answer for a source
    // that was silent, and not a quiet `allowed`.
    for name in ["roads-basic.osm", "roads-directionality.osm"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/synthetic")
            .join(name);
        let source = OsmXmlSource::from_path(path);
        let mut builder = DatasetBuilder::new(
            DatasetId::new("ds-other"),
            MapSource::source_metadata(&source),
        );
        let outcome = source.import(&mut builder).expect("imports");
        let dataset = builder.finish(outcome).expect("has features");

        for feature in dataset.features() {
            assert_eq!(
                feature.kind().road_access(),
                Some(&RoadAccess::unspecified()),
                "{name}: {} gained access from nowhere",
                feature.id()
            );
        }
        for code in [
            IssueCode::UnknownAccessValue,
            IssueCode::InvalidAccessScope,
            IssueCode::UnsupportedConditionalAccess,
        ] {
            assert_eq!(
                dataset.report().issues().count_of(code),
                0,
                "{name} must not report {code}"
            );
        }
    }
}
