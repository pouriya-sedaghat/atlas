//! The viewport map query use case.
//!
//! This is deliberately a narrow, use-case-shaped contract rather than a
//! general repository: Atlas answers "what should I draw in this viewport?",
//! and the contract says exactly that.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_kernel::{BoundingBox, FeatureKind, MapFeature};

use crate::dataset::{DatasetId, DatasetSnapshot};

/// The result limit used when a client does not ask for one.
pub const DEFAULT_FEATURE_LIMIT: usize = 1_000;

/// The hard ceiling the server enforces on any client-supplied limit.
pub const MAX_FEATURE_LIMIT: usize = 5_000;

/// Why a query could not be constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QueryError {
    /// The requested limit was zero.
    #[error("limit must be at least 1")]
    LimitTooSmall,
    /// The requested limit exceeded the server's hard maximum.
    #[error("limit {requested} exceeds the maximum of {maximum}")]
    LimitTooLarge {
        /// What the client asked for.
        requested: usize,
        /// The server's hard maximum.
        maximum: usize,
    },
}

/// The coarse feature kinds a query can filter on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FeatureKindFilter {
    /// Roads.
    Road,
}

impl FeatureKindFilter {
    /// Parses the wire form of a kind filter.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "road" => Some(FeatureKindFilter::Road),
            _ => None,
        }
    }

    /// The stable wire form of the filter.
    pub fn as_str(self) -> &'static str {
        match self {
            FeatureKindFilter::Road => "road",
        }
    }

    fn matches(self, kind: &FeatureKind) -> bool {
        match self {
            FeatureKindFilter::Road => matches!(kind, FeatureKind::Road(_)),
        }
    }
}

impl fmt::Display for FeatureKindFilter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Which features a query is interested in.
///
/// An empty filter matches everything, which is what a plain viewport request
/// wants.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeatureFilter {
    kinds: Vec<FeatureKindFilter>,
}

impl FeatureFilter {
    /// A filter that accepts every kind.
    pub fn any_kind() -> Self {
        Self::default()
    }

    /// A filter restricted to the given kinds.
    pub fn with_kinds(kinds: Vec<FeatureKindFilter>) -> Self {
        Self { kinds }
    }

    /// The kinds this filter restricts to, empty when it accepts everything.
    pub fn kinds(&self) -> &[FeatureKindFilter] {
        &self.kinds
    }

    /// Whether the filter accepts every kind.
    pub fn is_unrestricted(&self) -> bool {
        self.kinds.is_empty()
    }

    /// Whether the feature passes the filter.
    pub fn matches(&self, feature: &MapFeature) -> bool {
        self.kinds.is_empty() || self.kinds.iter().any(|kind| kind.matches(feature.kind()))
    }
}

/// A viewport query.
#[derive(Debug, Clone, PartialEq)]
pub struct MapFeatureQuery {
    bbox: BoundingBox,
    filter: FeatureFilter,
    limit: usize,
}

impl MapFeatureQuery {
    /// Builds a query, validating the limit against the server's maximum.
    pub fn new(bbox: BoundingBox, filter: FeatureFilter, limit: usize) -> Result<Self, QueryError> {
        if limit == 0 {
            return Err(QueryError::LimitTooSmall);
        }
        if limit > MAX_FEATURE_LIMIT {
            return Err(QueryError::LimitTooLarge {
                requested: limit,
                maximum: MAX_FEATURE_LIMIT,
            });
        }
        Ok(Self {
            bbox,
            filter,
            limit,
        })
    }

    /// The requested viewport.
    pub fn bbox(&self) -> &BoundingBox {
        &self.bbox
    }

    /// The kind filter.
    pub fn filter(&self) -> &FeatureFilter {
        &self.filter
    }

    /// The effective result limit.
    pub fn limit(&self) -> usize {
        self.limit
    }
}

/// What the query engine measured while answering a query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryDiagnostics {
    /// How many features the scan looked at.
    pub features_examined: u64,
    /// How many features matched the filter and the viewport.
    pub candidates_found: u64,
    /// How many features were actually returned.
    pub features_returned: u64,
    /// How long the scan took.
    pub elapsed: Duration,
}

/// The answer to a viewport query.
#[derive(Debug, Clone)]
pub struct MapQueryResult {
    dataset_id: DatasetId,
    features: Vec<Arc<MapFeature>>,
    limit: usize,
    truncated: bool,
    diagnostics: QueryDiagnostics,
}

impl MapQueryResult {
    /// The dataset the result came from.
    pub fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    /// The matching features, in deterministic order.
    pub fn features(&self) -> &[Arc<MapFeature>] {
        &self.features
    }

    /// The limit that was applied.
    pub fn limit(&self) -> usize {
        self.limit
    }

    /// Whether more features matched than were returned.
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// What the scan measured.
    pub fn diagnostics(&self) -> &QueryDiagnostics {
        &self.diagnostics
    }
}

/// Answers viewport queries.
pub trait MapQuery {
    /// Returns every feature that matches the query, up to its limit.
    fn query_features(&self, query: &MapFeatureQuery) -> MapQueryResult;
}

impl MapQuery for DatasetSnapshot {
    /// A linear scan over the snapshot.
    ///
    /// This milestone deliberately has no spatial index: the dataset is small,
    /// the scan is predictable, and an index would be an optimisation without a
    /// measured problem to solve. The scan continues past the limit so that
    /// `candidates_found` reports the true match count and truncation is
    /// honest.
    fn query_features(&self, query: &MapFeatureQuery) -> MapQueryResult {
        let started_at = Instant::now();
        let mut examined = 0_u64;
        let mut candidates = 0_u64;
        let mut features: Vec<Arc<MapFeature>> = Vec::new();

        for feature in self.features() {
            examined += 1;
            if !query.filter().matches(feature) {
                continue;
            }
            if !feature.geometry().intersects_bounding_box(query.bbox()) {
                continue;
            }
            candidates += 1;
            if features.len() < query.limit() {
                features.push(Arc::clone(feature));
            }
        }

        let returned = features.len() as u64;
        MapQueryResult {
            dataset_id: self.id().clone(),
            features,
            limit: query.limit(),
            truncated: candidates > returned,
            diagnostics: QueryDiagnostics {
                features_examined: examined,
                candidates_found: candidates,
                features_returned: returned,
                elapsed: started_at.elapsed(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::{DatasetBuilder, DatasetId};
    use crate::import::FeatureSink;
    use crate::registry::DatasetRegistry;
    use crate::test_support::{metadata, outcome, residential, road};
    use atlas_kernel::RoadClass;

    fn snapshot(features: Vec<MapFeature>) -> DatasetSnapshot {
        let registry = DatasetRegistry::new();
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        for feature in features {
            builder.accept(feature).expect("sink accepts");
        }
        registry.publish(builder.finish(outcome()).expect("dataset builds"));
        registry.snapshot().expect("snapshot")
    }

    fn bbox(west: f64, south: f64, east: f64, north: f64) -> BoundingBox {
        BoundingBox::from_degrees(west, south, east, north).expect("valid bounding box")
    }

    fn query(bbox: BoundingBox, limit: usize) -> MapFeatureQuery {
        MapFeatureQuery::new(bbox, FeatureFilter::any_kind(), limit).expect("valid query")
    }

    fn returned_ids(result: &MapQueryResult) -> Vec<String> {
        result
            .features()
            .iter()
            .map(|feature| feature.id().as_str().to_owned())
            .collect()
    }

    #[test]
    fn query_rejects_a_zero_limit() {
        assert_eq!(
            MapFeatureQuery::new(bbox(0.0, 0.0, 1.0, 1.0), FeatureFilter::any_kind(), 0),
            Err(QueryError::LimitTooSmall)
        );
    }

    #[test]
    fn query_enforces_the_server_maximum() {
        assert_eq!(
            MapFeatureQuery::new(
                bbox(0.0, 0.0, 1.0, 1.0),
                FeatureFilter::any_kind(),
                MAX_FEATURE_LIMIT + 1
            ),
            Err(QueryError::LimitTooLarge {
                requested: MAX_FEATURE_LIMIT + 1,
                maximum: MAX_FEATURE_LIMIT
            })
        );
        assert!(
            MapFeatureQuery::new(
                bbox(0.0, 0.0, 1.0, 1.0),
                FeatureFilter::any_kind(),
                MAX_FEATURE_LIMIT
            )
            .is_ok()
        );
    }

    #[test]
    fn only_features_intersecting_the_viewport_are_returned() {
        let snapshot = snapshot(vec![
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(50.0, 50.0), (51.0, 51.0)]),
            // Crosses the viewport with both endpoints outside it.
            residential("osm:way:3", &[(-5.0, 0.5), (5.0, 0.5)]),
        ]);
        let result = snapshot.query_features(&query(bbox(0.0, 0.0, 1.0, 1.0), 10));
        assert_eq!(returned_ids(&result), vec!["osm:way:1", "osm:way:3"]);
        assert!(!result.truncated());
    }

    #[test]
    fn diagnostics_describe_the_scan() {
        let snapshot = snapshot(vec![
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(50.0, 50.0), (51.0, 51.0)]),
        ]);
        let result = snapshot.query_features(&query(bbox(0.0, 0.0, 1.0, 1.0), 10));
        let diagnostics = result.diagnostics();
        assert_eq!(diagnostics.features_examined, 2);
        assert_eq!(diagnostics.candidates_found, 1);
        assert_eq!(diagnostics.features_returned, 1);
    }

    #[test]
    fn kind_filtering_selects_matching_features() {
        let snapshot = snapshot(vec![
            road(
                "osm:way:1",
                RoadClass::Residential,
                &[(0.0, 0.0), (1.0, 1.0)],
            ),
            road("osm:way:2", RoadClass::Service, &[(0.0, 0.0), (1.0, 1.0)]),
        ]);
        let road_only = MapFeatureQuery::new(
            bbox(0.0, 0.0, 1.0, 1.0),
            FeatureFilter::with_kinds(vec![FeatureKindFilter::Road]),
            10,
        )
        .expect("valid query");
        let result = snapshot.query_features(&road_only);
        assert_eq!(returned_ids(&result), vec!["osm:way:1", "osm:way:2"]);
    }

    #[test]
    fn limit_truncates_and_reports_the_true_candidate_count() {
        let snapshot = snapshot(vec![
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:3", &[(0.0, 0.0), (1.0, 1.0)]),
        ]);
        let result = snapshot.query_features(&query(bbox(0.0, 0.0, 1.0, 1.0), 2));
        assert_eq!(returned_ids(&result), vec!["osm:way:1", "osm:way:2"]);
        assert!(result.truncated());
        assert_eq!(result.limit(), 2);
        assert_eq!(result.diagnostics().candidates_found, 3);
        assert_eq!(result.diagnostics().features_returned, 2);
    }

    #[test]
    fn a_full_but_not_overflowing_result_is_not_truncated() {
        let snapshot = snapshot(vec![
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)]),
        ]);
        let result = snapshot.query_features(&query(bbox(0.0, 0.0, 1.0, 1.0), 2));
        assert!(!result.truncated());
    }

    #[test]
    fn output_order_is_deterministic_regardless_of_insertion_order() {
        let forwards = snapshot(vec![
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:3", &[(0.0, 0.0), (1.0, 1.0)]),
        ]);
        let backwards = snapshot(vec![
            residential("osm:way:3", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)]),
            residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]),
        ]);
        let viewport = bbox(0.0, 0.0, 1.0, 1.0);
        assert_eq!(
            returned_ids(&forwards.query_features(&query(viewport, 10))),
            returned_ids(&backwards.query_features(&query(viewport, 10)))
        );
    }

    #[test]
    fn results_carry_the_dataset_they_came_from() {
        let snapshot = snapshot(vec![residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)])]);
        let result = snapshot.query_features(&query(bbox(0.0, 0.0, 1.0, 1.0), 10));
        assert_eq!(result.dataset_id(), &DatasetId::new("ds-test"));
    }

    #[test]
    fn kind_filters_parse_from_their_wire_form() {
        assert_eq!(
            FeatureKindFilter::parse("road"),
            Some(FeatureKindFilter::Road)
        );
        assert_eq!(FeatureKindFilter::parse("building"), None);
        assert_eq!(FeatureKindFilter::Road.as_str(), "road");
    }

    #[test]
    fn an_unrestricted_filter_matches_everything() {
        let filter = FeatureFilter::any_kind();
        assert!(filter.is_unrestricted());
        assert!(filter.matches(&residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)])));
    }
}
