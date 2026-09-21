//! The viewport road-topology query use case.
//!
//! Separate from [`crate::MapQuery`] on purpose. "What should I draw in this
//! viewport?" and "how is this viewport connected?" are two questions with two
//! answers of two different shapes: one is a collection of features, the other
//! is a graph. Folding the second into the first would have meant a feature
//! query whose result changes shape depending on a flag, and a client that
//! wants roads paying for topology it never asked for.
//!
//! What the two queries *do* share is their discipline: both run against a
//! [`DatasetSnapshot`], so a query keeps working on exactly the dataset it
//! started with, and both scan linearly and report honestly what they scanned.

use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_kernel::{BoundingBox, RoadNode, RoadSegment};

use crate::dataset::{DatasetId, DatasetSnapshot};

/// The segment limit used when a client does not ask for one.
pub const DEFAULT_TOPOLOGY_SEGMENT_LIMIT: usize = 1_000;

/// The hard ceiling the server enforces on any client-supplied segment limit.
pub const MAX_TOPOLOGY_SEGMENT_LIMIT: usize = 5_000;

/// Why a topology query could not be constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TopologyQueryError {
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

/// A viewport topology query.
///
/// The bounding box is required. There is no "whole dataset" topology request:
/// a graph of every segment in a city-sized extract is not something a client
/// can draw or a server should assemble on demand.
#[derive(Debug, Clone, PartialEq)]
pub struct RoadTopologyQuery {
    bbox: BoundingBox,
    limit: usize,
}

impl RoadTopologyQuery {
    /// Builds a query, validating the limit against the server's maximum.
    pub fn new(bbox: BoundingBox, limit: usize) -> Result<Self, TopologyQueryError> {
        if limit == 0 {
            return Err(TopologyQueryError::LimitTooSmall);
        }
        if limit > MAX_TOPOLOGY_SEGMENT_LIMIT {
            return Err(TopologyQueryError::LimitTooLarge {
                requested: limit,
                maximum: MAX_TOPOLOGY_SEGMENT_LIMIT,
            });
        }
        Ok(Self { bbox, limit })
    }

    /// The requested viewport.
    pub fn bbox(&self) -> &BoundingBox {
        &self.bbox
    }

    /// The effective segment limit.
    pub fn limit(&self) -> usize {
        self.limit
    }
}

/// What the topology scan measured while answering a query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopologyQueryDiagnostics {
    /// How many segments the scan looked at.
    pub segments_examined: u64,
    /// How many segments intersected the viewport.
    pub candidates_found: u64,
    /// How many segments were actually returned.
    pub segments_returned: u64,
    /// How many distinct endpoint nodes those segments resolved to.
    pub nodes_returned: u64,
    /// How long the scan took.
    pub elapsed: Duration,
}

/// One node in a topology result, with its degree in the whole dataset.
///
/// The degree is **not** relative to the viewport. A junction where four
/// segments meet reports four even when the query returned only one of them,
/// because degree is a fact about the road network, not about the rectangle
/// somebody happens to be looking through.
#[derive(Debug, Clone)]
pub struct TopologyNodeResult {
    node: Arc<RoadNode>,
    degree: usize,
}

impl TopologyNodeResult {
    /// The node itself.
    pub fn node(&self) -> &RoadNode {
        &self.node
    }

    /// The node's degree in the complete dataset topology.
    pub fn degree(&self) -> usize {
        self.degree
    }
}

/// The answer to a viewport topology query.
#[derive(Debug, Clone)]
pub struct TopologyQueryResult {
    dataset_id: DatasetId,
    segments: Vec<Arc<RoadSegment>>,
    nodes: Vec<TopologyNodeResult>,
    limit: usize,
    truncated: bool,
    diagnostics: TopologyQueryDiagnostics,
}

impl TopologyQueryResult {
    /// The dataset the result came from.
    pub fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    /// The matching segments, in deterministic segment-id order.
    pub fn segments(&self) -> &[Arc<RoadSegment>] {
        &self.segments
    }

    /// The deduplicated endpoints of the returned segments, in node-id order.
    ///
    /// Every endpoint of every returned segment is here, including the ones
    /// whose coordinate lies outside the viewport. A response in which a
    /// segment named a node the response did not carry would not be
    /// internally resolvable, and a client would have to guess.
    pub fn nodes(&self) -> &[TopologyNodeResult] {
        &self.nodes
    }

    /// The limit that was applied.
    pub fn limit(&self) -> usize {
        self.limit
    }

    /// Whether more segments matched than were returned.
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// What the scan measured.
    pub fn diagnostics(&self) -> &TopologyQueryDiagnostics {
        &self.diagnostics
    }
}

/// Answers viewport topology queries.
pub trait TopologyQuery {
    /// Returns every segment that intersects the query box, up to its limit.
    fn query_topology(&self, query: &RoadTopologyQuery) -> TopologyQueryResult;
}

impl TopologyQuery for DatasetSnapshot {
    /// A linear scan over the snapshot's segments.
    ///
    /// The same deliberate absence of a spatial index as the feature query:
    /// the datasets are small, the scan is predictable, and an index would be
    /// an optimisation with no measured problem to solve. The scan continues
    /// past the limit so that `candidates_found` is the true match count and
    /// truncation is honest.
    fn query_topology(&self, query: &RoadTopologyQuery) -> TopologyQueryResult {
        let started_at = Instant::now();
        let topology = self.topology();
        let mut examined = 0_u64;
        let mut candidates = 0_u64;
        let mut segments: Vec<Arc<RoadSegment>> = Vec::new();

        for segment in topology.segments() {
            examined += 1;
            if !segment.geometry().intersects_bounding_box(query.bbox()) {
                continue;
            }
            candidates += 1;
            if segments.len() < query.limit() {
                segments.push(Arc::clone(segment));
            }
        }

        // The endpoints of what is actually being returned, not of what
        // matched: a truncated response still resolves every segment it
        // carries, and carries nothing it does not need.
        let mut node_ids: Vec<_> = segments
            .iter()
            .flat_map(|segment| [segment.start().clone(), segment.end().clone()])
            .collect();
        node_ids.sort();
        node_ids.dedup();

        let nodes: Vec<TopologyNodeResult> = node_ids
            .into_iter()
            .filter_map(|id| {
                topology.node(&id).map(|node| TopologyNodeResult {
                    node: Arc::clone(node),
                    degree: topology.degree(&id),
                })
            })
            .collect();

        let returned = segments.len() as u64;
        TopologyQueryResult {
            dataset_id: self.id().clone(),
            limit: query.limit(),
            truncated: candidates > returned,
            diagnostics: TopologyQueryDiagnostics {
                segments_examined: examined,
                candidates_found: candidates,
                segments_returned: returned,
                nodes_returned: nodes.len() as u64,
                elapsed: started_at.elapsed(),
            },
            segments,
            nodes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::{DatasetBuilder, DatasetId};
    use crate::import::FeatureSink;
    use crate::registry::DatasetRegistry;
    use crate::test_support::{imported_with_path, metadata, outcome};

    /// A road described as `(feature id, [(point id, longitude, latitude)])`.
    type RoadFixture<'a> = (&'a str, &'a [(&'a str, f64, f64)]);

    fn snapshot(roads: &[RoadFixture<'_>]) -> DatasetSnapshot {
        let registry = DatasetRegistry::new();
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        for (id, points) in roads {
            builder
                .accept(imported_with_path(id, points))
                .expect("sink accepts");
        }
        registry.publish(builder.finish(outcome()).expect("dataset builds"));
        registry.snapshot().expect("snapshot")
    }

    fn bbox(west: f64, south: f64, east: f64, north: f64) -> BoundingBox {
        BoundingBox::from_degrees(west, south, east, north).expect("valid bounding box")
    }

    fn query(bbox: BoundingBox, limit: usize) -> RoadTopologyQuery {
        RoadTopologyQuery::new(bbox, limit).expect("valid query")
    }

    fn segment_ids(result: &TopologyQueryResult) -> Vec<String> {
        result
            .segments()
            .iter()
            .map(|segment| segment.id().as_str().to_owned())
            .collect()
    }

    fn node_ids(result: &TopologyQueryResult) -> Vec<String> {
        result
            .nodes()
            .iter()
            .map(|node| node.node().id().as_str().to_owned())
            .collect()
    }

    /// Three roads in a row, sharing endpoints, spanning 0..6 in longitude.
    fn chain() -> DatasetSnapshot {
        snapshot(&[
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 2.0, 0.0)]),
            ("osm:way:2", &[("n:2", 2.0, 0.0), ("n:3", 4.0, 0.0)]),
            ("osm:way:3", &[("n:3", 4.0, 0.0), ("n:4", 6.0, 0.0)]),
        ])
    }

    #[test]
    fn a_topology_query_rejects_a_zero_limit() {
        assert_eq!(
            RoadTopologyQuery::new(bbox(0.0, 0.0, 1.0, 1.0), 0),
            Err(TopologyQueryError::LimitTooSmall)
        );
    }

    #[test]
    fn a_topology_query_enforces_the_server_maximum() {
        assert_eq!(
            RoadTopologyQuery::new(bbox(0.0, 0.0, 1.0, 1.0), MAX_TOPOLOGY_SEGMENT_LIMIT + 1),
            Err(TopologyQueryError::LimitTooLarge {
                requested: MAX_TOPOLOGY_SEGMENT_LIMIT + 1,
                maximum: MAX_TOPOLOGY_SEGMENT_LIMIT
            })
        );
        assert!(
            RoadTopologyQuery::new(bbox(0.0, 0.0, 1.0, 1.0), MAX_TOPOLOGY_SEGMENT_LIMIT).is_ok()
        );
    }

    #[test]
    fn the_documented_limits_are_what_the_contract_says() {
        assert_eq!(DEFAULT_TOPOLOGY_SEGMENT_LIMIT, 1_000);
        assert_eq!(MAX_TOPOLOGY_SEGMENT_LIMIT, 5_000);
    }

    #[test]
    fn only_segments_intersecting_the_viewport_are_returned() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-0.5, -0.5, 0.5, 0.5), 10));
        assert_eq!(segment_ids(&result), vec!["osm:way:1:segment:0"]);
        assert!(!result.truncated());
    }

    #[test]
    fn intersection_is_exact_not_a_bounds_approximation() {
        // An elbow whose bounding box covers the query box while neither of
        // its two legs enters it.
        let elbow = snapshot(&[(
            "osm:way:1",
            &[
                ("n:1", -5.0, 15.0),
                ("n:2", 15.0, 15.0),
                ("n:3", 15.0, -5.0),
            ],
        )]);
        let result = elbow.query_topology(&query(bbox(0.0, 0.0, 10.0, 10.0), 10));
        assert!(segment_ids(&result).is_empty());
        assert_eq!(result.diagnostics().segments_examined, 1);
        assert_eq!(result.diagnostics().candidates_found, 0);

        // A segment crossing the box with both endpoints outside it does
        // count, which is the other half of "exact".
        let crossing = snapshot(&[("osm:way:1", &[("n:1", -5.0, 5.0), ("n:2", 15.0, 5.0)])]);
        let result = crossing.query_topology(&query(bbox(0.0, 0.0, 10.0, 10.0), 10));
        assert_eq!(segment_ids(&result), vec!["osm:way:1:segment:0"]);
    }

    #[test]
    fn returned_nodes_are_the_deduplicated_endpoints_of_returned_segments() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 10));
        assert_eq!(
            segment_ids(&result),
            vec![
                "osm:way:1:segment:0",
                "osm:way:2:segment:0",
                "osm:way:3:segment:0"
            ]
        );
        // Four nodes, not six: the two shared endpoints appear once each.
        assert_eq!(node_ids(&result), vec!["n:1", "n:2", "n:3", "n:4"]);
        assert_eq!(result.diagnostics().nodes_returned, 4);
    }

    #[test]
    fn endpoints_outside_the_viewport_are_still_returned() {
        // A box that catches the middle of the first segment and neither of
        // its ends. Both ends come back anyway, or the segment the response
        // carries would name nodes the response does not have.
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(0.8, -0.1, 1.2, 0.1), 10));
        assert_eq!(segment_ids(&result), vec!["osm:way:1:segment:0"]);
        assert_eq!(node_ids(&result), vec!["n:1", "n:2"]);
        for node in result.nodes() {
            assert!(
                !bbox(0.8, -0.1, 1.2, 0.1).contains(&node.node().coordinate()),
                "both endpoints of this segment sit outside the query box"
            );
        }
    }

    #[test]
    fn a_truncated_query_still_resolves_every_segment_it_returns() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 2));
        assert_eq!(
            segment_ids(&result),
            vec!["osm:way:1:segment:0", "osm:way:2:segment:0"]
        );
        assert!(result.truncated());
        assert_eq!(result.limit(), 2);
        assert_eq!(result.diagnostics().candidates_found, 3);
        assert_eq!(result.diagnostics().segments_returned, 2);

        // Every endpoint named by a returned segment is in the response, and
        // the third segment's far endpoint is not, because that segment was
        // not returned.
        assert_eq!(node_ids(&result), vec!["n:1", "n:2", "n:3"]);
        for segment in result.segments() {
            for end in [segment.start(), segment.end()] {
                assert!(
                    result.nodes().iter().any(|node| node.node().id() == end),
                    "segment {} names node {end}, which the response must carry",
                    segment.id()
                );
            }
        }
    }

    #[test]
    fn a_full_but_not_overflowing_result_is_not_truncated() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 3));
        assert_eq!(result.segments().len(), 3);
        assert!(!result.truncated());
    }

    #[test]
    fn degree_is_global_not_relative_to_the_viewport() {
        // `n:2` joins two segments. A query that returns only one of them
        // still reports the degree the node has in the whole dataset.
        let snapshot = chain();
        let narrow = snapshot.query_topology(&query(bbox(-0.5, -0.5, 0.5, 0.5), 10));
        assert_eq!(segment_ids(&narrow), vec!["osm:way:1:segment:0"]);
        let shared = narrow
            .nodes()
            .iter()
            .find(|node| node.node().id().as_str() == "n:2")
            .expect("the shared endpoint is returned");
        assert_eq!(shared.degree(), 2);

        let wide = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 10));
        let same = wide
            .nodes()
            .iter()
            .find(|node| node.node().id().as_str() == "n:2")
            .expect("the shared endpoint is returned");
        assert_eq!(same.degree(), shared.degree());
    }

    #[test]
    fn a_self_loop_reports_degree_two_at_its_single_node() {
        let snapshot = snapshot(&[(
            "osm:way:609",
            &[
                ("n:17", 0.0, 0.0),
                ("n:18", 1.0, 1.0),
                ("n:19", 2.0, 0.0),
                ("n:17", 0.0, 0.0),
            ],
        )]);
        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 3.0, 2.0), 10));
        assert_eq!(segment_ids(&result), vec!["osm:way:609:segment:0"]);
        assert_eq!(node_ids(&result), vec!["n:17"]);
        assert_eq!(result.nodes()[0].degree(), 2);
        assert_eq!(result.diagnostics().nodes_returned, 1);
    }

    #[test]
    fn diagnostics_describe_the_scan() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-0.5, -0.5, 0.5, 0.5), 10));
        let diagnostics = result.diagnostics();
        assert_eq!(diagnostics.segments_examined, 3);
        assert_eq!(diagnostics.candidates_found, 1);
        assert_eq!(diagnostics.segments_returned, 1);
        assert_eq!(diagnostics.nodes_returned, 2);
    }

    #[test]
    fn segment_order_is_deterministic_regardless_of_emission_order() {
        let forwards = snapshot(&[
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 2.0, 0.0)]),
            ("osm:way:2", &[("n:2", 2.0, 0.0), ("n:3", 4.0, 0.0)]),
            ("osm:way:3", &[("n:3", 4.0, 0.0), ("n:4", 6.0, 0.0)]),
        ]);
        let backwards = snapshot(&[
            ("osm:way:3", &[("n:3", 4.0, 0.0), ("n:4", 6.0, 0.0)]),
            ("osm:way:2", &[("n:2", 2.0, 0.0), ("n:3", 4.0, 0.0)]),
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 2.0, 0.0)]),
        ]);
        let viewport = bbox(-1.0, -1.0, 7.0, 1.0);
        assert_eq!(
            segment_ids(&forwards.query_topology(&query(viewport, 10))),
            segment_ids(&backwards.query_topology(&query(viewport, 10)))
        );
        assert_eq!(
            node_ids(&forwards.query_topology(&query(viewport, 10))),
            node_ids(&backwards.query_topology(&query(viewport, 10)))
        );
    }

    #[test]
    fn results_carry_the_dataset_they_came_from() {
        let snapshot = chain();
        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 10));
        assert_eq!(result.dataset_id(), &DatasetId::new("ds-test"));
    }

    #[test]
    fn a_snapshot_keeps_answering_from_the_dataset_it_started_with() {
        let registry = DatasetRegistry::new();
        let mut first = DatasetBuilder::new(DatasetId::new("ds-1"), metadata());
        first
            .accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 2.0, 0.0)],
            ))
            .expect("sink accepts");
        registry.publish(first.finish(outcome()).expect("dataset builds"));
        let snapshot = registry.snapshot().expect("snapshot");

        let mut second = DatasetBuilder::new(DatasetId::new("ds-2"), metadata());
        second
            .accept(imported_with_path(
                "osm:way:9",
                &[("n:8", 0.0, 0.0), ("n:9", 2.0, 0.0)],
            ))
            .expect("sink accepts");
        registry.publish(second.finish(outcome()).expect("dataset builds"));

        let result = snapshot.query_topology(&query(bbox(-1.0, -1.0, 7.0, 1.0), 10));
        assert_eq!(result.dataset_id(), &DatasetId::new("ds-1"));
        assert_eq!(segment_ids(&result), vec!["osm:way:1:segment:0"]);
    }
}
