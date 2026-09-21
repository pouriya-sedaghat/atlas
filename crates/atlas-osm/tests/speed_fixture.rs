//! Integration test: the speed fixture, imported through the real engine path
//! (OSM source -> DatasetBuilder -> immutable Dataset).
//!
//! The expected speed facts are written out in full, one row per way, so that
//! a change to any precedence rule has to be re-stated here deliberately
//! rather than absorbed silently. The same table is in the fixture header.
//!
//! The direction and access columns are here too, on purpose. Speed derivation
//! must not be able to reach either of them, and the only way to keep proving
//! that is to state all three and assert all three.

use std::path::PathBuf;

use atlas_engine::{Dataset, DatasetBuilder, DatasetId, ImportStats, IssueCode, MapSource};
use atlas_kernel::{
    AccessRule, ConditionalSpeedLimit, ImplicitSpeedCode, MapFeature, RoadAccess, RoadSpeedLimits,
    RoadTraversal, Speed, SpeedDirection, SpeedLimitValue, SpeedUnit, TravelDirection, TravelMode,
    VariableSpeedLimit,
};
use atlas_osm::OsmXmlSource;

use ConditionalSpeedLimit::{NotTagged as NoCondition, Present};
use SpeedLimitValue::{Indeterminate, NoFixedLimit, Unspecified, WalkingPace};
use VariableSpeedLimit::{
    Fixed, Indeterminate as VariableIndeterminate, NotTagged as NoVariability, Variable as Varies,
};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-speed.osm")
}

fn import_fixture() -> Dataset {
    let source = OsmXmlSource::from_path(fixture_path());
    let mut builder = DatasetBuilder::new(
        DatasetId::new("ds-speed"),
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

fn speed_limits<'a>(dataset: &'a Dataset, id: &str) -> &'a RoadSpeedLimits {
    feature(dataset, id)
        .kind()
        .road_speed_limits()
        .unwrap_or_else(|| panic!("{id} is a road"))
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

/// An exact numeric limit, for readable expectations.
fn numeric(magnitude: &str, unit: SpeedUnit) -> SpeedLimitValue {
    SpeedLimitValue::Numeric(Speed::new(magnitude, unit).expect("a valid magnitude"))
}

fn kmh(magnitude: &str) -> SpeedLimitValue {
    numeric(magnitude, SpeedUnit::KilometresPerHour)
}

fn implicit(code: &str) -> SpeedLimitValue {
    SpeedLimitValue::Implicit(ImplicitSpeedCode::new(code).expect("a documented code"))
}

/// One mode's expected pair of ordinary limits, forward then backward.
type Pair = (SpeedLimitValue, SpeedLimitValue);

/// One row of the expected table.
struct Expected {
    id: &'static str,
    name: &'static str,
    /// Ordinary limits, forward / backward, per mode.
    motorcar: Pair,
    bicycle: Pair,
    foot: Pair,
    /// Conditional modifiers, in the fixed order
    /// `[car fwd, car bwd, bike fwd, bike bwd, foot fwd, foot bwd]`.
    conditional: [ConditionalSpeedLimit; 6],
    /// Variability, forward then backward; it has no mode-specific keys.
    variable: (VariableSpeedLimit, VariableSpeedLimit),
}

const NO_CONDITIONS: [ConditionalSpeedLimit; 6] = [NoCondition; 6];
const NO_VARIABILITY: (VariableSpeedLimit, VariableSpeedLimit) = (NoVariability, NoVariability);

fn row(
    id: &'static str,
    name: &'static str,
    motorcar: Pair,
    bicycle: Pair,
    foot: Pair,
    conditional: [ConditionalSpeedLimit; 6],
    variable: (VariableSpeedLimit, VariableSpeedLimit),
) -> Expected {
    Expected {
        id,
        name,
        motorcar,
        bicycle,
        foot,
        conditional,
        variable,
    }
}

/// The same pair for every mode, for the rows where the three agree.
fn all_modes(
    id: &'static str,
    name: &'static str,
    pair: Pair,
    conditional: [ConditionalSpeedLimit; 6],
    variable: (VariableSpeedLimit, VariableSpeedLimit),
) -> Expected {
    row(
        id,
        name,
        pair.clone(),
        pair.clone(),
        pair,
        conditional,
        variable,
    )
}

/// Every way in the fixture, with the speed facts it must produce.
fn expected() -> Vec<Expected> {
    vec![
        all_modes(
            "osm:way:501",
            "Untagged Speed Lane",
            (Unspecified, Unspecified),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:502",
            "Fifty Street",
            (kmh("50"), kmh("50")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:503",
            "Thirty Mph Street",
            (
                numeric("30", SpeedUnit::MilesPerHour),
                numeric("30", SpeedUnit::MilesPerHour),
            ),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:504",
            "Ten Knots Channel Road",
            (
                numeric("10", SpeedUnit::Knots),
                numeric("10", SpeedUnit::Knots),
            ),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:505",
            "No Fixed Limit Road",
            (NoFixedLimit, NoFixedLimit),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:506",
            "Walking Pace Lane",
            (WalkingPace, WalkingPace),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:507",
            "Implicit Urban Street",
            (implicit("RO:urban"), implicit("RO:urban")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:508",
            "Directional Speed Street",
            (kmh("60"), kmh("40")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        row(
            "osm:way:509",
            "Layered Mode Street",
            (kmh("35"), kmh("35")),
            (kmh("25"), kmh("25")),
            (WalkingPace, WalkingPace),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        row(
            "osm:way:510",
            "Mode Before Direction Street",
            // Mode specificity beats direction specificity: the car's own
            // non-directional key out-ranks `maxspeed:forward`.
            (kmh("35"), kmh("35")),
            (kmh("55"), kmh("45")),
            (kmh("60"), kmh("50")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        row(
            "osm:way:511",
            "Mixed Specificity Street",
            (kmh("30"), kmh("40")),
            (kmh("50"), kmh("20")),
            (kmh("50"), kmh("50")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        row(
            "osm:way:512",
            "Unreadable Motorcar Speed Street",
            (Indeterminate, Indeterminate),
            (kmh("50"), kmh("50")),
            (kmh("50"), kmh("50")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:513",
            "Unreadable Forward Speed Street",
            (Indeterminate, kmh("50")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:514",
            "Unsupported Unit Road",
            (Indeterminate, Indeterminate),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:515",
            "Missing Value Road",
            (Indeterminate, Indeterminate),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        row(
            "osm:way:516",
            "Shadowed Bad Speed Street",
            (kmh("30"), kmh("30")),
            (kmh("20"), kmh("20")),
            (WalkingPace, WalkingPace),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:517",
            "Conditional Speed Street",
            // The ordinary limit stands; the conditional sits beside it.
            (kmh("80"), kmh("80")),
            [Present; 6],
            NO_VARIABILITY,
        ),
        row(
            "osm:way:518",
            "Partly Shadowed Conditional Street",
            (kmh("90"), kmh("90")),
            (kmh("80"), kmh("80")),
            (kmh("80"), kmh("80")),
            [NoCondition, NoCondition, Present, Present, Present, Present],
            NO_VARIABILITY,
        ),
        row(
            "osm:way:519",
            "Fully Shadowed Conditional Street",
            (kmh("90"), kmh("90")),
            (kmh("25"), kmh("25")),
            (WalkingPace, WalkingPace),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:520",
            "Car Forward Conditional Street",
            (kmh("80"), kmh("80")),
            [
                Present,
                NoCondition,
                NoCondition,
                NoCondition,
                NoCondition,
                NoCondition,
            ],
            NO_VARIABILITY,
        ),
        all_modes(
            "osm:way:521",
            "Variable Speed Street",
            (kmh("100"), kmh("100")),
            NO_CONDITIONS,
            (Varies, Varies),
        ),
        all_modes(
            "osm:way:522",
            "Forward Fixed Variable Street",
            (kmh("100"), kmh("100")),
            NO_CONDITIONS,
            (Fixed, Varies),
        ),
        all_modes(
            "osm:way:523",
            "Unreadable Variable Street",
            (kmh("100"), kmh("100")),
            NO_CONDITIONS,
            (VariableIndeterminate, Varies),
        ),
        all_modes(
            "osm:way:524",
            "Orthogonality Street",
            (kmh("70"), kmh("30")),
            NO_CONDITIONS,
            NO_VARIABILITY,
        ),
    ]
}

/// The six facts of one road, in the order the tables above use them.
const FACTS: [(TravelMode, SpeedDirection); 6] = [
    (TravelMode::Motorcar, SpeedDirection::Forward),
    (TravelMode::Motorcar, SpeedDirection::Backward),
    (TravelMode::Bicycle, SpeedDirection::Forward),
    (TravelMode::Bicycle, SpeedDirection::Backward),
    (TravelMode::Foot, SpeedDirection::Forward),
    (TravelMode::Foot, SpeedDirection::Backward),
];

#[test]
fn fixture_produces_the_documented_counters() {
    let dataset = import_fixture();
    let stats = dataset.report().stats();

    assert_eq!(
        *stats,
        ImportStats {
            nodes_seen: 72,
            nodes_indexed: 72,
            ways_seen: 24,
            road_ways_selected: 24,
            features_emitted: 24,
            features_skipped: 0,
            relations_seen: 0,
            bytes_read: stats.bytes_read,
        }
    );
    assert!(stats.bytes_read.is_some_and(|bytes| bytes > 0));
    assert_eq!(dataset.feature_count(), 24);
}

#[test]
fn fixture_emits_exactly_the_expected_feature_ids_in_order() {
    let dataset = import_fixture();
    let ids: Vec<&str> = dataset
        .features()
        .iter()
        .map(|feature| feature.id().as_str())
        .collect();
    let expected: Vec<&str> = expected().iter().map(|row| row.id).collect();
    assert_eq!(ids, expected);
    // A speed problem is never a reason to drop a road: all 24 are here.
    assert_eq!(ids.len(), 24);
}

#[test]
fn fixture_names_every_road_so_the_inspector_is_readable() {
    let dataset = import_fixture();
    for row in expected() {
        assert_eq!(feature(&dataset, row.id).name(), Some(row.name));
    }
}

#[test]
fn fixture_derives_the_documented_ordinary_limit_for_every_mode_and_direction() {
    let dataset = import_fixture();
    for expectation in expected() {
        let limits = speed_limits(&dataset, expectation.id);
        let what = format!("{} ({})", expectation.id, expectation.name);
        let wanted = [
            expectation.motorcar.0,
            expectation.motorcar.1,
            expectation.bicycle.0,
            expectation.bicycle.1,
            expectation.foot.0,
            expectation.foot.1,
        ];
        for (index, (mode, direction)) in FACTS.into_iter().enumerate() {
            assert_eq!(
                limits.fact(mode, direction).limit(),
                &wanted[index],
                "{what} {mode} {direction}"
            );
        }
        // The mode/direction accessor and the named accessors describe one
        // value; they cannot drift apart.
        assert_eq!(
            limits.motorcar().forward(),
            limits.fact(TravelMode::Motorcar, SpeedDirection::Forward)
        );
        assert_eq!(
            limits.bicycle().backward(),
            limits.fact(TravelMode::Bicycle, SpeedDirection::Backward)
        );
        assert_eq!(
            limits.foot().forward(),
            limits.fact(TravelMode::Foot, SpeedDirection::Forward)
        );
    }
}

#[test]
fn fixture_derives_the_documented_conditional_modifier_for_every_fact() {
    let dataset = import_fixture();
    for expectation in expected() {
        let limits = speed_limits(&dataset, expectation.id);
        let what = format!("{} ({})", expectation.id, expectation.name);
        for (index, (mode, direction)) in FACTS.into_iter().enumerate() {
            assert_eq!(
                limits.fact(mode, direction).conditional(),
                expectation.conditional[index],
                "{what} {mode} {direction}"
            );
        }
    }
}

#[test]
fn fixture_derives_the_documented_variability_for_every_fact() {
    let dataset = import_fixture();
    for expectation in expected() {
        let limits = speed_limits(&dataset, expectation.id);
        let what = format!("{} ({})", expectation.id, expectation.name);
        for (mode, direction) in FACTS {
            let wanted = match direction {
                SpeedDirection::Forward => expectation.variable.0,
                SpeedDirection::Backward => expectation.variable.1,
            };
            assert_eq!(
                limits.fact(mode, direction).variable(),
                wanted,
                "{what} {mode} {direction}"
            );
        }
    }
}

#[test]
fn fixture_reports_exactly_the_four_speed_warnings() {
    let dataset = import_fixture();
    let issues = dataset.report().issues();

    assert_eq!(issues.count_of(IssueCode::UnknownMaxspeedValue), 4);
    assert_eq!(
        issues.samples_of(IssueCode::UnknownMaxspeedValue),
        &["way/512", "way/513", "way/515", "way/516"]
    );

    assert_eq!(issues.count_of(IssueCode::UnsupportedMaxspeedUnit), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedMaxspeedUnit),
        &["way/514"]
    );

    assert_eq!(
        issues.count_of(IssueCode::UnsupportedConditionalMaxspeed),
        3
    );
    assert_eq!(
        issues.samples_of(IssueCode::UnsupportedConditionalMaxspeed),
        &["way/517", "way/518", "way/520"]
    );

    assert_eq!(issues.count_of(IssueCode::UnknownVariableMaxspeedValue), 1);
    assert_eq!(
        issues.samples_of(IssueCode::UnknownVariableMaxspeedValue),
        &["way/523"]
    );

    // Nothing else went wrong: this fixture is about speed only. In
    // particular the orthogonal direction and access tags on way 524 produce
    // no warnings of their own.
    let codes: Vec<IssueCode> = issues.groups().map(|group| group.code()).collect();
    assert_eq!(
        codes,
        vec![
            IssueCode::UnknownMaxspeedValue,
            IssueCode::UnsupportedMaxspeedUnit,
            IssueCode::UnsupportedConditionalMaxspeed,
            IssueCode::UnknownVariableMaxspeedValue,
        ]
    );

    for group in issues.groups() {
        assert!(group.samples().len() <= atlas_engine::IssueLog::DEFAULT_MAX_SAMPLES);
        assert_eq!(group.samples().len() as u64, group.count());
    }
}

#[test]
fn a_speed_warning_is_recorded_once_per_road_however_many_tags_or_facts_caused_it() {
    // Way 512's one bad value reaches two facts; way 513's reaches three;
    // way 516's broken general value is shadowed for all six; way 517's
    // conditional reaches all six. Each earns exactly one warning, so the
    // counts above are counts of roads, not of tags, profiles or directions.
    let dataset = import_fixture();
    let issues = dataset.report().issues();
    let total: u64 = issues.groups().map(|group| group.count()).sum();
    assert_eq!(total, 9);
}

#[test]
fn a_fully_shadowed_conditional_produces_neither_a_fact_nor_a_warning() {
    // Way 519 carries the same conditional as 517 and 518 and is out-ranked
    // for every mode. It shaped nothing, so there is no limitation of Atlas
    // to report — which is what makes the conditional diagnostic
    // selected-only while the malformed-value diagnostics ignore precedence.
    let dataset = import_fixture();
    let limits = speed_limits(&dataset, "osm:way:519");
    for (mode, direction) in FACTS {
        assert_eq!(limits.fact(mode, direction).conditional(), NoCondition);
    }
    assert!(
        !dataset
            .report()
            .issues()
            .samples_of(IssueCode::UnsupportedConditionalMaxspeed)
            .iter()
            .any(|sample| sample == "way/519"),
        "way/519 must not appear in the conditional samples"
    );
}

#[test]
fn a_shadowed_malformed_value_is_still_reported_and_still_changes_nothing() {
    // Way 516 resolves entirely from its three valid mode keys and still
    // reports its broken general value.
    let dataset = import_fixture();
    let limits = speed_limits(&dataset, "osm:way:516");
    assert_eq!(limits.motorcar().forward().limit(), &kmh("30"));
    assert_eq!(limits.bicycle().backward().limit(), &kmh("20"));
    assert_eq!(limits.foot().forward().limit(), &WalkingPace);
    assert!(
        dataset
            .report()
            .issues()
            .samples_of(IssueCode::UnknownMaxspeedValue)
            .iter()
            .any(|sample| sample == "way/516")
    );
}

#[test]
fn units_are_preserved_exactly_as_the_source_stated_them() {
    // `30 mph` is not silently 48 km/h, and `10 knots` is not 18.52 km/h.
    let dataset = import_fixture();
    let unit_of = |id: &str| {
        speed_limits(&dataset, id)
            .motorcar()
            .forward()
            .limit()
            .speed()
            .map(|speed| (speed.magnitude().to_owned(), speed.unit()))
    };
    assert_eq!(
        unit_of("osm:way:502"),
        Some(("50".to_owned(), SpeedUnit::KilometresPerHour))
    );
    assert_eq!(
        unit_of("osm:way:503"),
        Some(("30".to_owned(), SpeedUnit::MilesPerHour))
    );
    assert_eq!(
        unit_of("osm:way:504"),
        Some(("10".to_owned(), SpeedUnit::Knots))
    );
}

#[test]
fn an_implicit_code_is_preserved_and_never_resolved_to_a_number() {
    let dataset = import_fixture();
    let limits = speed_limits(&dataset, "osm:way:507");
    for (mode, direction) in FACTS {
        let limit = limits.fact(mode, direction).limit();
        assert_eq!(
            limit.implicit_code().map(ImplicitSpeedCode::as_str),
            Some("RO:urban")
        );
        assert!(limit.speed().is_none(), "no number was invented");
    }
}

#[test]
fn speed_is_never_derived_from_the_road_class() {
    // Every road in the fixture is residential, and they disagree about speed
    // in every way the model allows. The class explains none of it.
    let dataset = import_fixture();
    for expectation in expected() {
        assert_eq!(
            feature(&dataset, expectation.id)
                .kind()
                .road_class()
                .expect("a road")
                .as_str(),
            "residential"
        );
    }
    assert_ne!(
        speed_limits(&dataset, "osm:way:501"),
        speed_limits(&dataset, "osm:way:502")
    );
    // And an untagged residential street gains no limit from anywhere.
    assert_eq!(
        speed_limits(&dataset, "osm:way:501"),
        &RoadSpeedLimits::unspecified()
    );
}

#[test]
fn way_524_keeps_its_direction_access_and_both_speed_directions_at_once() {
    // The orthogonality road. Four independent records on one road, and the
    // geometry untouched by any of them.
    let dataset = import_fixture();

    let traversal = traversal(&dataset, "osm:way:524");
    assert_eq!(traversal.motorcar(), TravelDirection::Reverse);
    assert_eq!(traversal.bicycle(), TravelDirection::Both);
    assert_eq!(traversal.foot(), TravelDirection::Both);

    let access = access(&dataset, "osm:way:524");
    assert_eq!(access.motorcar(), AccessRule::Private);
    assert_eq!(access.bicycle(), AccessRule::Permissive);
    assert_eq!(access.foot(), AccessRule::Allowed);

    let limits = speed_limits(&dataset, "osm:way:524");
    for mode in TravelMode::ALL {
        assert_eq!(limits.limits(mode).forward().limit(), &kmh("70"), "{mode}");
        assert_eq!(limits.limits(mode).backward().limit(), &kmh("30"), "{mode}");
    }

    // A reverse one-way still carries a forward speed limit: the source is
    // describing the road, not the traffic. The coordinate order is the one
    // the file gave, so `forward` still means what the file meant.
    let atlas_kernel::Geometry::LineString(line) = feature(&dataset, "osm:way:524").geometry();
    assert_eq!(
        line.coordinates()
            .iter()
            .map(|coordinate| coordinate.longitude_degrees())
            .collect::<Vec<_>>(),
        vec![51.3900, 51.3915, 51.3930]
    );
}

#[test]
fn speed_direction_and_access_disagree_about_which_roads_are_interesting() {
    // If one were derived from another, these groupings would line up. They
    // do not: 501 and 502 share a direction and an access and differ in
    // speed, and 502 and 524 share neither direction nor access while both
    // carry numeric limits.
    let dataset = import_fixture();
    assert_eq!(
        traversal(&dataset, "osm:way:501"),
        traversal(&dataset, "osm:way:502")
    );
    assert_eq!(
        access(&dataset, "osm:way:501"),
        access(&dataset, "osm:way:502")
    );
    assert_ne!(
        speed_limits(&dataset, "osm:way:501"),
        speed_limits(&dataset, "osm:way:502")
    );
    assert_ne!(
        traversal(&dataset, "osm:way:502"),
        traversal(&dataset, "osm:way:524")
    );
    assert_ne!(
        access(&dataset, "osm:way:502"),
        access(&dataset, "osm:way:524")
    );
}

#[test]
fn every_road_but_524_keeps_the_direction_and_access_of_a_road_nobody_tagged() {
    // Speed derivation must not be able to reach either of the other two
    // records. Twenty-three roads carry only speed tags, so all twenty-three
    // must be two-way and silent about access.
    let dataset = import_fixture();
    for expectation in expected() {
        if expectation.id == "osm:way:524" {
            continue;
        }
        assert_eq!(
            traversal(&dataset, expectation.id),
            RoadTraversal::bidirectional(),
            "{} gained a direction from a speed tag",
            expectation.id
        );
        assert_eq!(
            access(&dataset, expectation.id),
            RoadAccess::unspecified(),
            "{} gained an access rule from a speed tag",
            expectation.id
        );
    }
}

#[test]
fn geometry_is_never_changed_by_speed_derivation() {
    // Every road runs west to east with the same three longitudes, whatever
    // its speed says. A backward limit is not expressed by reversing a line.
    let dataset = import_fixture();
    for expectation in expected() {
        let atlas_kernel::Geometry::LineString(line) = feature(&dataset, expectation.id).geometry();
        let longitudes: Vec<f64> = line
            .coordinates()
            .iter()
            .map(|coordinate| coordinate.longitude_degrees())
            .collect();
        assert_eq!(
            longitudes,
            vec![51.3900, 51.3915, 51.3930],
            "{} lost or reordered its coordinates",
            expectation.id
        );
    }
}

#[test]
fn fixture_import_is_reproducible() {
    let first = import_fixture();
    let second = import_fixture();
    assert_eq!(first.report().stats(), second.report().stats());
    assert_eq!(first.report().issues(), second.report().issues());
    for expectation in expected() {
        assert_eq!(
            speed_limits(&first, expectation.id),
            speed_limits(&second, expectation.id)
        );
    }
}

#[test]
fn fixture_bounds_cover_every_row() {
    let dataset = import_fixture();
    let bounds = dataset.bounds().expect("bounds are derived");
    assert_eq!(bounds.west(), 51.3900);
    assert_eq!(bounds.east(), 51.3930);
    assert_eq!(bounds.south(), 35.7085);
    assert_eq!(bounds.north(), 35.7200);
}

#[test]
fn fixture_carries_openstreetmap_attribution() {
    let dataset = import_fixture();
    let attribution = dataset.attribution().expect("attribution present");
    assert_eq!(attribution.text(), "© OpenStreetMap contributors");
    assert_eq!(dataset.source().name(), "roads-speed.osm");
    assert_eq!(dataset.source().format(), "osm-xml");
}

#[test]
fn the_other_fixtures_are_untouched_and_still_say_nothing_about_speed() {
    // roads-basic, roads-directionality and roads-access have no speed tags,
    // so every road in them must read as `unspecified` — the honest answer for
    // a source that was silent, and not a quiet country default.
    for name in [
        "roads-basic.osm",
        "roads-directionality.osm",
        "roads-access.osm",
    ] {
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
                feature.kind().road_speed_limits(),
                Some(&RoadSpeedLimits::unspecified()),
                "{name}: {} gained a speed limit from nowhere",
                feature.id()
            );
        }
        for code in [
            IssueCode::UnknownMaxspeedValue,
            IssueCode::UnsupportedMaxspeedUnit,
            IssueCode::UnsupportedConditionalMaxspeed,
            IssueCode::UnknownVariableMaxspeedValue,
        ] {
            assert_eq!(
                dataset.report().issues().count_of(code),
                0,
                "{name} must not report {code}"
            );
        }
    }
}
