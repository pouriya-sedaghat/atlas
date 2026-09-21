//! Versioned wire types for the Atlas HTTP API, version 1.
//!
//! These structs exist so that the JSON contract is written down in one place
//! and changes to it are deliberate. Nothing here derives `Serialize` on a
//! domain type: every field is mapped explicitly.

use std::time::Duration;

use atlas_engine::{
    Attribution, Dataset, ImportFailure, ImportReport, IssueGroup, MapQueryResult,
    QueryDiagnostics, SourceMetadata,
};
use atlas_kernel::{
    AccessRule, BoundingBox, ConditionalSpeedLimit, DirectionalSpeedLimits, Geometry, MapFeature,
    RoadAccess, RoadSpeedLimits, RoadTraversal, SpeedLimitFact, SpeedLimitValue, TravelDirection,
    TravelMode,
};
use serde::Serialize;

/// The API version carried in every Atlas metadata block.
pub const API_VERSION: &str = "1";

/// The media type Atlas serves feature collections with.
pub const GEOJSON_CONTENT_TYPE: &str = "application/geo+json";

fn bbox_array(bbox: &BoundingBox) -> [f64; 4] {
    [bbox.west(), bbox.south(), bbox.east(), bbox.north()]
}

fn elapsed_millis(elapsed: Duration) -> f64 {
    // Three decimals is plenty for a human reading a diagnostics panel and
    // keeps the JSON free of 17-digit floats.
    (elapsed.as_secs_f64() * 1_000_000.0).round() / 1_000.0
}

/// A simple liveness or readiness payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthV1 {
    /// `live` or `ready`.
    pub status: &'static str,
    /// The active dataset, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
}

/// GeoJSON geometry.
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum GeometryV1 {
    /// A GeoJSON `LineString`, always `[longitude, latitude]` pairs.
    LineString {
        /// The positions making up the line.
        coordinates: Vec<[f64; 2]>,
    },
}

impl GeometryV1 {
    fn from_domain(geometry: &Geometry) -> Self {
        match geometry {
            Geometry::LineString(line) => GeometryV1::LineString {
                coordinates: line
                    .coordinates()
                    .iter()
                    .map(|coordinate| {
                        [
                            coordinate.longitude_degrees(),
                            coordinate.latitude_degrees(),
                        ]
                    })
                    .collect(),
            },
        }
    }
}

/// Where a feature came from, included only when the client asks for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReferenceV1 {
    /// The originating system, for example `openstreetmap`.
    pub system: String,
    /// The entity type in that system, for example `way`.
    pub entity_type: String,
    /// The entity identifier in that system.
    pub entity_id: String,
}

/// The ordinary, static legal maximum for one mode in one direction.
///
/// A tagged union rather than a nullable number, because the interesting
/// answers are not numbers: a road with no fixed limit, a road signed at
/// walking pace and a road whose limit is a named jurisdiction rule are three
/// different facts, and none of them is "unknown".
///
/// The magnitude is a **string**, deliberately. It is exact decimal text, not
/// a float: `50.5` is `50.5` on every client in every language, and two
/// imports of one file serialise byte for byte the same. A client that needs
/// arithmetic parses it knowingly.
///
/// The unit is the one the source stated. Atlas does not convert, so `30 mph`
/// arrives as `30` and `mph`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SpeedLimitV1 {
    /// No applicable explicit limit was present. Not "unlimited", and not a
    /// country default: the source said nothing.
    Unspecified,
    /// An exact magnitude in the unit the source stated it in.
    Numeric {
        /// Canonical decimal digits, with no sign, no exponent and no
        /// redundant zeroes: `50`, `50.5`, `0`.
        value: String,
        /// `km/h`, `mph` or `knots`, exactly as sourced and never converted.
        unit: &'static str,
    },
    /// The source says no fixed limit applies. Knowledge, not its absence.
    NoFixedLimit,
    /// The source says the limit is walking pace, which Atlas does not turn
    /// into a guessed number.
    WalkingPace,
    /// The limit is whatever a named jurisdiction rule says it is.
    Implicit {
        /// The normalised code, for example `RO:urban`. Atlas preserves it
        /// and deliberately does not resolve it to a number.
        code: String,
    },
    /// A limit was stated and Atlas could not read it safely.
    Indeterminate,
}

impl SpeedLimitV1 {
    fn from_domain(limit: &SpeedLimitValue) -> Self {
        match limit {
            SpeedLimitValue::Unspecified => SpeedLimitV1::Unspecified,
            SpeedLimitValue::Numeric(speed) => SpeedLimitV1::Numeric {
                value: speed.magnitude().to_owned(),
                unit: speed.unit().as_str(),
            },
            SpeedLimitValue::NoFixedLimit => SpeedLimitV1::NoFixedLimit,
            SpeedLimitValue::WalkingPace => SpeedLimitV1::WalkingPace,
            SpeedLimitValue::Implicit(code) => SpeedLimitV1::Implicit {
                code: code.as_str().to_owned(),
            },
            SpeedLimitValue::Indeterminate => SpeedLimitV1::Indeterminate,
        }
    }
}

/// Everything the source says about one mode's limit in one direction.
///
/// Three independent members. The two modifiers say what else the source
/// attached to the ordinary limit; neither replaces it. A road signed at 80
/// with a wet-weather conditional publishes `80` **and** `"conditional": true`,
/// and a client that reads only one of the two is reading half the road.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedLimitFactV1 {
    /// The ordinary, static limit.
    pub limit: SpeedLimitV1,
    /// Whether a conditional limit supplements the ordinary one.
    ///
    /// `true` means Atlas found a conditional statement at a scope that
    /// applies here and deliberately did not evaluate it. It never means the
    /// ordinary limit does not apply.
    pub conditional: bool,
    /// `not-tagged`, `fixed`, `variable` or `indeterminate`.
    ///
    /// `not-tagged` is a statement about the source record, not a promise that
    /// the limit never changes; `fixed` is somebody saying that it does not.
    pub variable: &'static str,
}

impl SpeedLimitFactV1 {
    fn from_domain(fact: &SpeedLimitFact) -> Self {
        Self {
            limit: SpeedLimitV1::from_domain(fact.limit()),
            conditional: matches!(fact.conditional(), ConditionalSpeedLimit::Present),
            variable: fact.variable().as_str(),
        }
    }
}

/// One mode's speed facts, one per geometry direction.
///
/// Both directions are always published, for every mode, on every road. A
/// one-way road still has two of them: `forward` and `backward` are relative
/// to the **coordinate order of the geometry**, not to a permitted direction
/// of travel, so they mean the same thing on a road nobody may drive at all.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionalSpeedLimitsV1 {
    /// The fact along the coordinate order of the line.
    pub forward: SpeedLimitFactV1,
    /// The fact against the coordinate order of the line.
    pub backward: SpeedLimitFactV1,
}

impl DirectionalSpeedLimitsV1 {
    fn from_domain(limits: &DirectionalSpeedLimits) -> Self {
        Self {
            forward: SpeedLimitFactV1::from_domain(limits.forward()),
            backward: SpeedLimitFactV1::from_domain(limits.backward()),
        }
    }
}

/// What one mode's travel on a road looks like: which way, on what terms, and
/// at what stated legal maximum.
///
/// The object shape is what made this additive. Direction was the first thing
/// Atlas knew per mode and was never going to be the only one, so a client
/// that read `traversal.foot.direction` in Milestone 2A kept working when
/// `access` arrived beside it in 2B, and keeps working now that `speedLimits`
/// has joined them. The API version is unchanged.
///
/// The three members are independent facts and none implies another. A road
/// may be `forward`, `prohibited` and signed at 50 all at once — the direction
/// says which way it runs, the access says what the source said about using
/// it, the speed says what the source said the legal maximum is — and a client
/// must not read any one as a qualifier on another. In particular a prohibited
/// road still publishes its speed limits, because the sign is on the post
/// whether or not anyone may drive past it.
///
/// No member is a routing decision. `access` records what the source said;
/// `speedLimits` records a **legal maximum**, not a travel speed and not a
/// routing cost. Whether either permits, or how long, a particular journey
/// takes is a routing-profile question Atlas does not answer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeTraversalV1 {
    /// `both`, `forward`, `reverse`, `reversible`, `alternating` or
    /// `indeterminate`.
    pub direction: &'static str,
    /// `unspecified`, `allowed`, `designated`, `permissive`, `discouraged`,
    /// `destination-only`, `customers-only`, `delivery-only`,
    /// `agricultural-only`, `forestry-only`, `military-only`, `private`,
    /// `permit-required`, `dismount-required`, `use-sidepath`, `prohibited`,
    /// `variable`, `conditional` or `indeterminate`.
    ///
    /// `unspecified` means the source said nothing applicable, which is not
    /// the same as `allowed`.
    pub access: &'static str,
    /// The source-derived legal maximum speed, one entry per geometry
    /// direction. Always present, never gated behind an `include` parameter.
    pub speed_limits: DirectionalSpeedLimitsV1,
}

impl ModeTraversalV1 {
    fn from_domain(
        direction: TravelDirection,
        access: AccessRule,
        speed_limits: &DirectionalSpeedLimits,
    ) -> Self {
        Self {
            direction: direction.as_str(),
            access: access.as_str(),
            speed_limits: DirectionalSpeedLimitsV1::from_domain(speed_limits),
        }
    }
}

/// The travel semantics of a road, one entry per mode Atlas models.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadTraversalV1 {
    /// Direction, access and speed limits for a private motor car.
    pub motorcar: ModeTraversalV1,
    /// Direction, access and speed limits for a bicycle.
    pub bicycle: ModeTraversalV1,
    /// Direction, access and speed limits for a pedestrian.
    pub foot: ModeTraversalV1,
}

impl RoadTraversalV1 {
    /// Maps the three road records onto one per-mode block.
    ///
    /// They arrive as separate domain values — the kernel keeps direction,
    /// access and speed strictly apart — and are only zipped together here, at
    /// the wire boundary, because that is the shape a client reads most
    /// naturally and the extension point this object was documented as having.
    /// Nothing in the domain treats them as one thing.
    fn from_domain(
        traversal: &RoadTraversal,
        access: &RoadAccess,
        speed_limits: &RoadSpeedLimits,
    ) -> Self {
        let mode = |mode: TravelMode| {
            ModeTraversalV1::from_domain(
                traversal.direction(mode),
                access.rule(mode),
                speed_limits.limits(mode),
            )
        };
        Self {
            motorcar: mode(TravelMode::Motorcar),
            bicycle: mode(TravelMode::Bicycle),
            foot: mode(TravelMode::Foot),
        }
    }
}

/// The non-presentational properties Atlas publishes for a feature.
///
/// Colours, widths and z-order are the client's business; the server only says
/// what a thing is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePropertiesV1 {
    /// The coarse kind, for example `road`.
    pub kind: String,
    /// The road classification, for roads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub road_class: Option<String>,
    /// The per-mode direction, access and speed-limit semantics, for roads.
    ///
    /// Always present on a road, with every mode and both geometry directions
    /// filled in, and never gated behind an `include` parameter: it is what
    /// the feature *is*, not extra diagnostics about it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traversal: Option<RoadTraversalV1>,
    /// The feature name, verbatim from the source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The source reference, when `include=source` was requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceReferenceV1>,
}

/// A GeoJSON feature.
#[derive(Debug, Serialize)]
pub struct FeatureV1 {
    #[serde(rename = "type")]
    kind: &'static str,
    /// The opaque, deterministic Atlas feature id.
    pub id: String,
    /// The feature geometry.
    pub geometry: GeometryV1,
    /// The feature properties.
    pub properties: FeaturePropertiesV1,
}

impl FeatureV1 {
    fn from_domain(feature: &MapFeature, include_source: bool) -> Self {
        Self {
            kind: "Feature",
            id: feature.id().as_str().to_owned(),
            geometry: GeometryV1::from_domain(feature.geometry()),
            properties: FeaturePropertiesV1 {
                kind: feature.kind().name().to_owned(),
                road_class: feature
                    .kind()
                    .road_class()
                    .map(|class| class.as_str().to_owned()),
                traversal: feature
                    .kind()
                    .road_traversal()
                    .zip(feature.kind().road_access())
                    .zip(feature.kind().road_speed_limits())
                    .map(|((traversal, access), speed_limits)| {
                        RoadTraversalV1::from_domain(traversal, access, speed_limits)
                    }),
                name: feature.name().map(str::to_owned),
                source: include_source
                    .then(|| feature.source())
                    .flatten()
                    .map(|reference| SourceReferenceV1 {
                        system: reference.system().to_owned(),
                        entity_type: reference.entity_type().to_owned(),
                        entity_id: reference.entity_id().to_owned(),
                    }),
            },
        }
    }
}

/// What the query engine measured, included only when asked for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDiagnosticsV1 {
    /// How many features the scan looked at.
    pub features_examined: u64,
    /// How many features matched the filter and the viewport.
    pub candidates_found: u64,
    /// How many features were returned.
    pub features_returned: u64,
    /// How long the scan took, in milliseconds.
    pub elapsed_ms: f64,
}

impl QueryDiagnosticsV1 {
    fn from_domain(diagnostics: &QueryDiagnostics) -> Self {
        Self {
            features_examined: diagnostics.features_examined,
            candidates_found: diagnostics.candidates_found,
            features_returned: diagnostics.features_returned,
            elapsed_ms: elapsed_millis(diagnostics.elapsed),
        }
    }
}

/// The Atlas foreign member attached to every feature collection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasMetaV1 {
    /// The API version, currently `1`.
    pub api_version: &'static str,
    /// The dataset the features came from.
    pub dataset_id: String,
    /// How many features are in this response.
    pub returned: usize,
    /// The limit that was applied.
    pub limit: usize,
    /// Whether more features matched than were returned.
    pub truncated: bool,
    /// Scan diagnostics, when `include=diagnostics` was requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<QueryDiagnosticsV1>,
}

/// A GeoJSON `FeatureCollection` with the Atlas foreign member.
#[derive(Debug, Serialize)]
pub struct FeatureCollectionV1 {
    #[serde(rename = "type")]
    kind: &'static str,
    /// The viewport that was queried, as `[west, south, east, north]`.
    pub bbox: [f64; 4],
    /// The matching features.
    pub features: Vec<FeatureV1>,
    /// Atlas-specific metadata, kept out of `properties` on purpose.
    pub atlas: AtlasMetaV1,
}

impl FeatureCollectionV1 {
    /// Maps a query result onto the wire format.
    pub fn from_result(
        result: &MapQueryResult,
        viewport: &BoundingBox,
        include_source: bool,
        include_diagnostics: bool,
    ) -> Self {
        Self {
            kind: "FeatureCollection",
            bbox: bbox_array(viewport),
            features: result
                .features()
                .iter()
                .map(|feature| FeatureV1::from_domain(feature, include_source))
                .collect(),
            atlas: AtlasMetaV1 {
                api_version: API_VERSION,
                dataset_id: result.dataset_id().as_str().to_owned(),
                returned: result.features().len(),
                limit: result.limit(),
                truncated: result.truncated(),
                diagnostics: include_diagnostics
                    .then(|| QueryDiagnosticsV1::from_domain(result.diagnostics())),
            },
        }
    }
}

/// Where a dataset came from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceV1 {
    /// The source display name, a bare file name for file sources.
    pub name: String,
    /// The source format, for example `osm-xml`.
    pub format: String,
}

/// Attribution a client must display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionV1 {
    /// The attribution text.
    pub text: String,
    /// The licence URL to link to.
    pub license_url: String,
}

/// The counters from one import run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatisticsV1 {
    /// How long the import took, in milliseconds.
    pub elapsed_ms: f64,
    /// How many node elements were seen.
    pub nodes_seen: u64,
    /// How many nodes entered the node index.
    pub nodes_indexed: u64,
    /// How many way elements were seen.
    pub ways_seen: u64,
    /// How many ways were selected as roads.
    pub road_ways_selected: u64,
    /// How many features were emitted.
    pub features_emitted: u64,
    /// How many selected roads were skipped.
    pub features_skipped: u64,
    /// How many relations were counted.
    pub relations_seen: u64,
    /// How many source bytes were read, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_read: Option<u64>,
    /// How many features the dataset holds.
    pub feature_count: usize,
}

/// One grouped import warning.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningGroupV1 {
    /// The stable issue code.
    pub code: String,
    /// The total number of occurrences.
    pub count: u64,
    /// A bounded sample of affected entity identifiers.
    pub samples: Vec<String>,
}

/// Why the last import failed, free of internals.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureV1 {
    /// A short stable category.
    pub category: String,
    /// A short sentence safe to show to a user.
    pub message: String,
}

/// The `GET /api/v1/datasets/current` payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDatasetV1 {
    /// The API version, currently `1`.
    pub api_version: &'static str,
    /// `loading`, `ready` or `failed`.
    pub status: String,
    /// The active dataset identifier, when one is published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
    /// The dataset bounds as `[west, south, east, north]`, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
    /// Where the dataset came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceV1>,
    /// The attribution a client must display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution: Option<AttributionV1>,
    /// The import counters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statistics: Option<ImportStatisticsV1>,
    /// Grouped import warnings, always present and possibly empty.
    pub warnings: Vec<WarningGroupV1>,
    /// Why the last import failed, when one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureV1>,
}

impl CurrentDatasetV1 {
    /// Builds the payload for a state with no published dataset.
    pub fn unavailable(status: &str, failure: Option<&ImportFailure>) -> Self {
        Self {
            api_version: API_VERSION,
            status: status.to_owned(),
            dataset_id: None,
            bounds: None,
            source: None,
            attribution: None,
            statistics: None,
            warnings: Vec::new(),
            failure: failure.map(failure_v1),
        }
    }

    /// Builds the payload for a published dataset.
    pub fn from_dataset(dataset: &Dataset, status: &str, failure: Option<&ImportFailure>) -> Self {
        let report = dataset.report();
        Self {
            api_version: API_VERSION,
            status: status.to_owned(),
            dataset_id: Some(dataset.id().as_str().to_owned()),
            bounds: dataset.bounds().map(bbox_array),
            source: Some(source_v1(dataset.source())),
            attribution: dataset.attribution().map(attribution_v1),
            statistics: Some(statistics_v1(report)),
            warnings: report.issues().groups().map(warning_v1).collect(),
            failure: failure.map(failure_v1),
        }
    }
}

fn source_v1(source: &SourceMetadata) -> SourceV1 {
    SourceV1 {
        name: source.name().to_owned(),
        format: source.format().to_owned(),
    }
}

fn attribution_v1(attribution: &Attribution) -> AttributionV1 {
    AttributionV1 {
        text: attribution.text().to_owned(),
        license_url: attribution.license_url().to_owned(),
    }
}

fn statistics_v1(report: &ImportReport) -> ImportStatisticsV1 {
    let stats = report.stats();
    ImportStatisticsV1 {
        elapsed_ms: elapsed_millis(report.elapsed()),
        nodes_seen: stats.nodes_seen,
        nodes_indexed: stats.nodes_indexed,
        ways_seen: stats.ways_seen,
        road_ways_selected: stats.road_ways_selected,
        features_emitted: stats.features_emitted,
        features_skipped: stats.features_skipped,
        relations_seen: stats.relations_seen,
        bytes_read: stats.bytes_read,
        feature_count: report.feature_count(),
    }
}

fn warning_v1(group: &IssueGroup) -> WarningGroupV1 {
    WarningGroupV1 {
        code: group.code().as_str().to_owned(),
        count: group.count(),
        samples: group.samples().to_vec(),
    }
}

fn failure_v1(failure: &ImportFailure) -> FailureV1 {
    FailureV1 {
        category: failure.category().to_owned(),
        message: failure.message().to_owned(),
    }
}
