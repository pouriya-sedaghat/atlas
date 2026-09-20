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
use atlas_kernel::{BoundingBox, Geometry, MapFeature, RoadTraversal, TravelDirection};
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

/// In which direction one mode travels a road, relative to the geometry.
///
/// A direction, not a permission: it says which way along the road the mode
/// would go if access allows it there at all, and Atlas does not yet model
/// access.
///
/// An object rather than a bare string: direction is the first thing Atlas
/// knows per mode, not the only thing it will ever know, and a client that
/// reads `traversal.foot.direction` today keeps working when access or speed
/// joins it tomorrow.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeTraversalV1 {
    /// `both`, `forward`, `reverse`, `reversible`, `alternating` or
    /// `indeterminate`.
    pub direction: &'static str,
}

impl ModeTraversalV1 {
    fn from_domain(direction: TravelDirection) -> Self {
        Self {
            direction: direction.as_str(),
        }
    }
}

/// The travel semantics of a road, one entry per mode Atlas models.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadTraversalV1 {
    /// Direction for a private motor car.
    pub motorcar: ModeTraversalV1,
    /// Direction for a bicycle.
    pub bicycle: ModeTraversalV1,
    /// Direction for a pedestrian.
    pub foot: ModeTraversalV1,
}

impl RoadTraversalV1 {
    fn from_domain(traversal: &RoadTraversal) -> Self {
        Self {
            motorcar: ModeTraversalV1::from_domain(traversal.motorcar()),
            bicycle: ModeTraversalV1::from_domain(traversal.bicycle()),
            foot: ModeTraversalV1::from_domain(traversal.foot()),
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
    /// The travel direction semantics, for roads.
    ///
    /// Always present on a road, and never gated behind an `include`
    /// parameter: it is what the feature *is*, not extra diagnostics about it.
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
                    .map(RoadTraversalV1::from_domain),
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
