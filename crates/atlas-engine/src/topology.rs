//! The road topology aggregate and the import-time values it is derived from.
//!
//! The kernel owns the topology *value objects* — [`RoadNode`],
//! [`RoadSegment`] and their identifiers. The engine owns the *aggregate*:
//! which nodes and segments a dataset has, in what order, and which segments
//! meet at which node. That split is deliberate. A node is a validated value
//! that means the same thing everywhere; an adjacency index is a fact about
//! one dataset, and datasets are the engine's business.
//!
//! # What topology is, and what it is not
//!
//! Topology answers one question: **which road paths are structurally
//! connected, and into which stable segments are they split?** It is not a
//! routing graph. It says nothing about whether a mode may traverse a segment,
//! in which direction, at what cost or in how long. Those are facts on the
//! road feature, reached through [`RoadSegment::road`].
//!
//! # Identity is the only connectivity key
//!
//! Two paths connect where they share a **source point identity**, full stop.
//! Equal coordinates with different identities are not a connection. Lines
//! that cross geometrically without sharing an identity are not a connection.
//! No tag — `oneway`, `access`, `maxspeed`, `layer`, `level`, `bridge`,
//! `tunnel`, road class, barriers, relations — is consulted, and neither are
//! the coordinates themselves.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;

use atlas_kernel::{
    FeatureId, FeatureKind, GeoCoordinate, Geometry, MapFeature, RoadNode, RoadNodeId, RoadSegment,
    RoadSegmentId, TopologyError,
};

use crate::dataset::DatasetBuildError;

/// The separator between a road identity and its segment ordinal.
///
/// The resulting text is stable and tested, but it is still an **opaque
/// identifier**: clients compare segment ids for equality and must never parse
/// one to recover the road it belongs to. `roadFeatureId` is the join.
const SEGMENT_ID_INFIX: &str = ":segment:";

/// Builds the deterministic identifier for one segment of one road.
pub(crate) fn segment_id_text(road: &FeatureId, ordinal: usize) -> String {
    format!("{road}{SEGMENT_ID_INFIX}{ordinal}")
}

/// Why an imported road envelope could not be constructed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImportedRoadError {
    /// The feature handed over was not a road.
    #[error("`{feature}` is not a road, so it has no road path")]
    NotARoad {
        /// The offending feature identifier.
        feature: String,
    },
    /// The path had fewer resolved points than a connection needs.
    #[error("a road path needs at least {minimum} resolved points, got {count}")]
    PathTooShort {
        /// How many points were supplied.
        count: usize,
        /// The smallest usable number of points.
        minimum: usize,
    },
    /// A point identity was empty or blank.
    #[error("a road path point id must not be blank")]
    BlankPointId,
    /// The path did not describe the same geometry as the feature.
    #[error(
        "`{feature}` has a road path describing {path_points} distinct positions, but its \
         geometry describes {display_points}"
    )]
    GeometryMismatch {
        /// The offending feature identifier.
        feature: String,
        /// How many distinct adjacent positions the feature geometry has.
        display_points: usize,
        /// How many distinct adjacent positions the path has.
        path_points: usize,
    },
}

/// The positions of a coordinate sequence, with adjacent duplicates collapsed.
///
/// This is the one form in which a feature geometry and a road path can be
/// compared. They are allowed to disagree about *how many times* one position
/// is listed — the importer collapses an adjacent duplicate when it builds a
/// display geometry, and a path keeps both because two source identities at
/// one position are two topology positions — but they may not disagree about
/// *which positions, in which order*.
fn canonical_positions(coordinates: impl IntoIterator<Item = GeoCoordinate>) -> Vec<GeoCoordinate> {
    let mut positions: Vec<GeoCoordinate> = Vec::new();
    for coordinate in coordinates {
        if positions.last() != Some(&coordinate) {
            positions.push(coordinate);
        }
    }
    positions
}

/// One point of an import-time road path: an opaque identity and a position.
///
/// The identity is a plain string and the engine never looks inside it. The
/// OSM adapter derives it from a node id, but that is the adapter's private
/// business: nothing here parses, splits or interprets the text, and an
/// adapter for some other format is free to use any stable scheme it likes.
#[derive(Debug, Clone, PartialEq)]
pub struct RoadPathPoint {
    id: String,
    coordinate: GeoCoordinate,
}

impl RoadPathPoint {
    /// Builds a point, rejecting a blank identity.
    pub fn new(
        id: impl Into<String>,
        coordinate: GeoCoordinate,
    ) -> Result<Self, ImportedRoadError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(ImportedRoadError::BlankPointId);
        }
        Ok(Self { id, coordinate })
    }

    /// The opaque source point identity.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Where the point is.
    pub fn coordinate(&self) -> GeoCoordinate {
        self.coordinate
    }
}

/// An import-time, source-neutral ordered sequence of point identities.
///
/// A path is **not** the feature's display geometry and is not interchangeable
/// with it. The importer collapses adjacent duplicate coordinates when it
/// builds a [`MapFeature`]'s [`atlas_kernel::LineString`], because two copies
/// of one position draw nothing extra. A path keeps both, because two source
/// identities at one position are two topology positions, and merging them
/// would invent a connection the source never described.
///
/// Paths exist only for the duration of an import. [`crate::DatasetBuilder`]
/// discards them once the topology has been derived, so nothing downstream can
/// come to depend on import-time detail.
#[derive(Debug, Clone, PartialEq)]
pub struct RoadPath {
    points: Vec<RoadPathPoint>,
}

impl RoadPath {
    /// The smallest number of points that can describe a connection.
    pub const MIN_POINTS: usize = 2;

    /// Builds a path, rejecting anything shorter than two points.
    pub fn new(points: Vec<RoadPathPoint>) -> Result<Self, ImportedRoadError> {
        if points.len() < Self::MIN_POINTS {
            return Err(ImportedRoadError::PathTooShort {
                count: points.len(),
                minimum: Self::MIN_POINTS,
            });
        }
        Ok(Self { points })
    }

    /// The points, in source order.
    pub fn points(&self) -> &[RoadPathPoint] {
        &self.points
    }

    /// How many points the path has.
    pub fn len(&self) -> usize {
        self.points.len()
    }

    /// Whether the path has no points. Never true for a constructed path.
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
}

/// One accepted road, handed to the builder as one indivisible thing.
///
/// The envelope guarantees two separate things, and both matter.
///
/// **Co-presence.** The feature and its path enter the dataset together or not
/// at all. There is deliberately no way to hand over a road feature without
/// its path: an adapter that could would silently produce a dataset whose
/// topology is missing roads that its feature collection has.
///
/// **Correspondence.** The path describes *the same geometry* as the feature.
/// Co-presence alone would let an adapter pair a road drawn in one place with
/// a path running through another, and the dataset would then publish segments
/// whose coordinates fall outside the bounds of the very road they name. The
/// two are checked against one another here, at the only point where both are
/// in one hand, rather than trusted and discovered later — or never.
///
/// Correspondence is checked on **canonical positions**: the coordinate
/// sequence with adjacent duplicates collapsed, on both sides. That is exactly
/// the freedom the two representations are meant to have and no more. The
/// importer collapses an adjacent duplicate when it builds a display geometry,
/// and a path keeps both copies because two source identities at one position
/// are two topology positions — so a way whose display line has two
/// coordinates and whose path has three identities is correct and is accepted.
/// A reversed line, an unrelated line, or a line missing an intermediate
/// position is none of those things, and is rejected.
///
/// The path's identities are never mutated or collapsed by this check. Only a
/// throwaway comparison form is derived from them.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedRoad {
    feature: MapFeature,
    path: RoadPath,
}

impl ImportedRoad {
    /// Builds the envelope, rejecting a non-road feature and a path that does
    /// not describe the feature's geometry.
    ///
    /// The kind guard reads as always-true today because [`FeatureKind`] has
    /// exactly one variant. It is written anyway: the moment a second kind
    /// exists, a path attached to something that is not a road has to be
    /// rejected here rather than discovered in the topology build.
    pub fn new(feature: MapFeature, path: RoadPath) -> Result<Self, ImportedRoadError> {
        if !matches!(feature.kind(), FeatureKind::Road { .. }) {
            return Err(ImportedRoadError::NotARoad {
                feature: feature.id().as_str().to_owned(),
            });
        }

        // The exhaustive match is deliberate: a geometry kind that is not a
        // line has no ordered coordinate sequence to compare a path against,
        // and adding one must stop compiling here rather than skip the check.
        let display = match feature.geometry() {
            Geometry::LineString(line) => canonical_positions(line.coordinates().iter().copied()),
        };
        let described = canonical_positions(path.points().iter().map(RoadPathPoint::coordinate));
        if display != described {
            return Err(ImportedRoadError::GeometryMismatch {
                feature: feature.id().as_str().to_owned(),
                display_points: display.len(),
                path_points: described.len(),
            });
        }

        Ok(Self { feature, path })
    }

    /// The road feature.
    pub fn feature(&self) -> &MapFeature {
        &self.feature
    }

    /// The road's source-neutral path.
    pub fn path(&self) -> &RoadPath {
        &self.path
    }

    /// Splits the envelope into the two values it carries.
    pub fn into_parts(self) -> (MapFeature, RoadPath) {
        (self.feature, self.path)
    }
}

/// Which segments meet at one node, and how many ends they contribute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct NodeAdjacency {
    /// The distinct segments touching this node, ordered by id.
    segments: Vec<RoadSegmentId>,
    /// How many segment *ends* land here. A self-loop contributes two.
    degree: usize,
}

/// The immutable, source-derived topology of one dataset.
///
/// Undirected throughout. A segment's `start` and `end` name the first and
/// last point of its geometry, never a direction of travel, and no traversal,
/// access, speed or class fact is stored here — segments reference their road
/// and the road owns those four.
#[derive(Debug)]
pub struct RoadTopology {
    /// Sorted by node id, so lookups can binary search and output is stable.
    nodes: Vec<Arc<RoadNode>>,
    /// Sorted by segment id, for the same two reasons.
    segments: Vec<Arc<RoadSegment>>,
    adjacency: BTreeMap<RoadNodeId, NodeAdjacency>,
}

impl RoadTopology {
    /// Sorts, validates and indexes a finished set of nodes and segments.
    ///
    /// Every referential invariant is checked here rather than trusted from
    /// the derivation: duplicate public identifiers, segments pointing at
    /// nodes that do not exist, and segments owned by features the dataset
    /// does not hold are all impossible states, and an impossible state fails
    /// the build rather than publishing a half-built graph.
    pub(crate) fn assemble(
        mut nodes: Vec<RoadNode>,
        mut segments: Vec<RoadSegment>,
        features: &[Arc<MapFeature>],
    ) -> Result<Self, DatasetBuildError> {
        nodes.sort_by(|left, right| left.id().cmp(right.id()));
        segments.sort_by(|left, right| left.id().cmp(right.id()));

        for pair in nodes.windows(2) {
            if pair[0].id() == pair[1].id() {
                return Err(DatasetBuildError::DuplicateNodeId {
                    id: pair[0].id().as_str().to_owned(),
                });
            }
        }
        for pair in segments.windows(2) {
            if pair[0].id() == pair[1].id() {
                return Err(DatasetBuildError::DuplicateSegmentId {
                    id: pair[0].id().as_str().to_owned(),
                });
            }
        }

        let known_features: std::collections::HashSet<&FeatureId> =
            features.iter().map(|feature| feature.id()).collect();

        let mut adjacency: BTreeMap<RoadNodeId, NodeAdjacency> = nodes
            .iter()
            .map(|node| (node.id().clone(), NodeAdjacency::default()))
            .collect();

        for segment in &segments {
            if !known_features.contains(segment.road()) {
                return Err(DatasetBuildError::UnknownSegmentFeature {
                    segment: segment.id().as_str().to_owned(),
                    feature: segment.road().as_str().to_owned(),
                });
            }
            // Both ends are recorded separately, which is what makes a
            // self-loop contribute two to its node's degree: the segment
            // begins and finishes there, and both of those are incidences.
            for end in [segment.start(), segment.end()] {
                let entry = adjacency.get_mut(end).ok_or_else(|| {
                    DatasetBuildError::UnknownSegmentNode {
                        segment: segment.id().as_str().to_owned(),
                        node: end.as_str().to_owned(),
                    }
                })?;
                entry.degree += 1;
                if entry.segments.last() != Some(segment.id()) {
                    entry.segments.push(segment.id().clone());
                }
            }
        }

        Ok(Self {
            nodes: nodes.into_iter().map(Arc::new).collect(),
            segments: segments.into_iter().map(Arc::new).collect(),
            adjacency,
        })
    }

    /// Every node, ordered deterministically by node id.
    pub fn nodes(&self) -> &[Arc<RoadNode>] {
        &self.nodes
    }

    /// Every segment, ordered deterministically by segment id.
    pub fn segments(&self) -> &[Arc<RoadSegment>] {
        &self.segments
    }

    /// How many nodes the topology holds.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// How many segments the topology holds.
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Looks one node up by id.
    pub fn node(&self, id: &RoadNodeId) -> Option<&Arc<RoadNode>> {
        self.nodes
            .binary_search_by(|candidate| candidate.id().cmp(id))
            .ok()
            .map(|index| &self.nodes[index])
    }

    /// The node's degree in the **complete** dataset topology.
    ///
    /// Degree counts incident segment *ends*, so a self-loop contributes two.
    /// It is never relative to a viewport: a junction that happens to be drawn
    /// at the edge of a query still reports how many segments actually meet
    /// there.
    pub fn degree(&self, id: &RoadNodeId) -> usize {
        self.adjacency.get(id).map_or(0, |entry| entry.degree)
    }

    /// The distinct segments touching a node, ordered by segment id.
    ///
    /// A self-loop appears once here and counts twice in [`Self::degree`]:
    /// this answers "which segments", degree answers "how many ends".
    pub fn segments_at(&self, id: &RoadNodeId) -> &[RoadSegmentId] {
        self.adjacency
            .get(id)
            .map_or(&[], |entry| entry.segments.as_slice())
    }
}

/// Derives the whole topology from the paths of the accepted roads.
///
/// The five steps, in order:
///
/// 1. resolve every point identity to one coordinate, failing if one identity
///    claims two positions;
/// 2. count how often each identity occurs across every accepted path,
///    including repeated occurrences inside a single path;
/// 3. promote an identity to a public node when it starts a path, ends a path,
///    or occurs more than once;
/// 4. split each path at every occurrence of a public node, keeping all
///    intermediate shape coordinates in source order;
/// 5. sort, validate and index the result.
///
/// Nothing outside the paths is consulted. A way that never became a feature
/// contributed no path, so it cannot affect an occurrence count; a non-road
/// way never had a path at all.
pub(crate) fn derive_topology(
    features: &[Arc<MapFeature>],
    paths: &[(FeatureId, RoadPath)],
) -> Result<RoadTopology, DatasetBuildError> {
    // Step 1 and 2 in one walk: a point's position and its occurrence count
    // are both facts about its identity, and both are needed for every point.
    let mut occurrences: HashMap<&str, (GeoCoordinate, usize)> = HashMap::new();
    for (_, path) in paths {
        for point in path.points() {
            match occurrences.get_mut(point.id()) {
                Some((coordinate, count)) => {
                    if *coordinate != point.coordinate() {
                        return Err(DatasetBuildError::ConflictingPointCoordinate {
                            point: point.id().to_owned(),
                        });
                    }
                    *count += 1;
                }
                None => {
                    occurrences.insert(point.id(), (point.coordinate(), 1));
                }
            }
        }
    }

    // Step 3. An identity is public when it starts a path, ends a path, or
    // occurs more than once anywhere. The last rule covers both a junction
    // between two roads and a road that revisits its own point, because both
    // are the same fact: the identity was seen more than once.
    let mut public: std::collections::HashSet<&str> = occurrences
        .iter()
        .filter(|(_, (_, count))| *count > 1)
        .map(|(id, _)| *id)
        .collect();
    for (_, path) in paths {
        let points = path.points();
        public.insert(points[0].id());
        public.insert(points[points.len() - 1].id());
    }

    let mut nodes: Vec<RoadNode> = Vec::with_capacity(public.len());
    for id in &public {
        let (coordinate, _) = occurrences
            .get(id)
            .copied()
            .expect("a public identity came from the occurrence table");
        let node_id = RoadNodeId::new(*id).map_err(invalid_topology)?;
        nodes.push(RoadNode::new(node_id, coordinate));
    }
    // Indexed by id so segment construction can hand the real node to the
    // kernel constructor, which validates the geometry against its position.
    let node_index: HashMap<&str, &RoadNode> = nodes
        .iter()
        .map(|node| (node.id().as_str(), node))
        .collect();

    // Step 4. Paths are visited in a deterministic order so that a build is
    // reproducible even before the output is sorted. Segment identifiers
    // depend only on the owning road and the ordinal within that road, so the
    // order the source emitted its ways in changes nothing either way.
    let mut ordered: Vec<&(FeatureId, RoadPath)> = paths.iter().collect();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));

    let mut segments: Vec<RoadSegment> = Vec::new();
    for (road, path) in ordered {
        let points = path.points();
        let splits: Vec<usize> = points
            .iter()
            .enumerate()
            .filter(|(_, point)| public.contains(point.id()))
            .map(|(index, _)| index)
            .collect();

        for (ordinal, window) in splits.windows(2).enumerate() {
            let (from, to) = (window[0], window[1]);
            let start = *node_index
                .get(points[from].id())
                .expect("a split index is a public node");
            let end = *node_index
                .get(points[to].id())
                .expect("a split index is a public node");
            let coordinates: Vec<GeoCoordinate> = points[from..=to]
                .iter()
                .map(RoadPathPoint::coordinate)
                .collect();
            let id =
                RoadSegmentId::new(segment_id_text(road, ordinal)).map_err(invalid_topology)?;
            segments.push(
                RoadSegment::new(id, road.clone(), start, end, coordinates)
                    .map_err(invalid_topology)?,
            );
        }
    }

    RoadTopology::assemble(nodes, segments, features)
}

fn invalid_topology(error: TopologyError) -> DatasetBuildError {
    DatasetBuildError::InvalidTopology {
        detail: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{coordinates, path, residential};
    use atlas_kernel::RoadClass;

    fn point(id: &str, longitude: f64, latitude: f64) -> RoadPathPoint {
        RoadPathPoint::new(
            id,
            GeoCoordinate::from_degrees(longitude, latitude).expect("valid coordinate"),
        )
        .expect("valid point")
    }

    #[test]
    fn a_path_point_rejects_a_blank_identity() {
        let coordinate = GeoCoordinate::from_degrees(0.0, 0.0).expect("valid coordinate");
        assert_eq!(
            RoadPathPoint::new("", coordinate),
            Err(ImportedRoadError::BlankPointId)
        );
        assert_eq!(
            RoadPathPoint::new("  ", coordinate),
            Err(ImportedRoadError::BlankPointId)
        );
    }

    #[test]
    fn a_path_needs_at_least_two_points() {
        assert_eq!(
            RoadPath::new(vec![point("n:1", 0.0, 0.0)]),
            Err(ImportedRoadError::PathTooShort {
                count: 1,
                minimum: 2
            })
        );
        assert_eq!(
            RoadPath::new(Vec::new()),
            Err(ImportedRoadError::PathTooShort {
                count: 0,
                minimum: 2
            })
        );
        let valid = RoadPath::new(vec![point("n:1", 0.0, 0.0), point("n:2", 1.0, 1.0)])
            .expect("two points is a path");
        assert_eq!(valid.len(), 2);
        assert!(!valid.is_empty());
    }

    #[test]
    fn an_envelope_carries_a_road_and_its_path_together() {
        let feature = residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]);
        let road = ImportedRoad::new(
            feature.clone(),
            path(&[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
        )
        .expect("a road envelope");
        assert_eq!(road.feature().id().as_str(), "osm:way:1");
        assert_eq!(road.path().len(), 2);

        let (returned, returned_path) = road.into_parts();
        assert_eq!(returned, feature);
        assert_eq!(returned_path.len(), 2);
    }

    mod correspondence {
        use super::*;
        use crate::test_support::road as classified_road;
        use atlas_kernel::RoadClass;

        /// Builds an envelope from an explicit feature shape and path shape.
        ///
        /// The two are given separately on purpose: every test here is about
        /// what happens when they disagree.
        fn envelope(
            feature_points: &[(f64, f64)],
            path_points: &[(&str, f64, f64)],
        ) -> Result<ImportedRoad, ImportedRoadError> {
            ImportedRoad::new(residential("osm:way:1", feature_points), path(path_points))
        }

        fn mismatch(display_points: usize, path_points: usize) -> ImportedRoadError {
            ImportedRoadError::GeometryMismatch {
                feature: "osm:way:1".to_owned(),
                display_points,
                path_points,
            }
        }

        #[test]
        fn a_path_describing_the_same_line_is_accepted() {
            assert!(
                envelope(
                    &[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)],
                    &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)],
                )
                .is_ok()
            );
        }

        #[test]
        fn an_unrelated_path_is_rejected() {
            // A road drawn here and a path running there. Without this check
            // the dataset would publish segments whose coordinates fall
            // outside the bounds of the very road they name.
            let error = envelope(
                &[(0.0, 0.0), (1.0, 1.0)],
                &[("n:1", 50.0, 50.0), ("n:2", 51.0, 51.0)],
            )
            .expect_err("a path somewhere else is not this road's path");
            assert_eq!(error, mismatch(2, 2));

            // Same start, different end: a partial overlap is not an overlap.
            assert_eq!(
                envelope(
                    &[(0.0, 0.0), (1.0, 1.0)],
                    &[("n:1", 0.0, 0.0), ("n:2", 9.0, 9.0)],
                )
                .expect_err("one shared endpoint is not correspondence"),
                mismatch(2, 2)
            );
        }

        #[test]
        fn a_reversed_path_is_rejected() {
            // Direction of travel is a road fact and coordinate order is the
            // source's own. A path that runs the other way describes a
            // different ordered geometry, whatever it may share with this one.
            let error = envelope(
                &[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)],
                &[("n:3", 2.0, 2.0), ("n:2", 1.0, 1.0), ("n:1", 0.0, 0.0)],
            )
            .expect_err("a reversed path is not this road's path");
            // Both sides describe three positions; the order is what differs,
            // which is exactly why a count comparison would not be enough.
            assert_eq!(error, mismatch(3, 3));
        }

        #[test]
        fn a_path_missing_an_intermediate_position_is_rejected() {
            assert_eq!(
                envelope(
                    &[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)],
                    &[("n:1", 0.0, 0.0), ("n:3", 2.0, 2.0)],
                )
                .expect_err("a path that skips a bend is not this road's path"),
                mismatch(3, 2)
            );
            // And the other way round: a path with a position the geometry
            // never had is equally not this road's path.
            assert_eq!(
                envelope(
                    &[(0.0, 0.0), (2.0, 2.0)],
                    &[("n:1", 0.0, 0.0), ("n:2", 1.0, 5.0), ("n:3", 2.0, 2.0)],
                )
                .expect_err("an invented bend is not this road's geometry"),
                mismatch(2, 3)
            );
        }

        #[test]
        fn adjacent_duplicate_path_coordinates_are_accepted() {
            // This is the roads-basic way 106 shape: the display line has two
            // coordinates because the importer collapsed the adjacent
            // duplicate, and the path has three because two source identities
            // occupy one position. Both describe the same ordered geometry.
            let road = envelope(
                &[(0.0, 0.0), (2.0, 2.0)],
                &[("n:6", 0.0, 0.0), ("n:7", 0.0, 0.0), ("n:3", 2.0, 2.0)],
            )
            .expect("an adjacent duplicate identity is exactly what a path keeps");

            // And the path is handed on untouched: nothing here collapses an
            // identity, only a throwaway comparison form.
            assert_eq!(road.path().len(), 3);
            let ids: Vec<&str> = road.path().points().iter().map(RoadPathPoint::id).collect();
            assert_eq!(ids, vec!["n:6", "n:7", "n:3"]);
            assert_eq!(road.feature().geometry().coordinate_count(), 2);
        }

        #[test]
        fn adjacent_duplicate_feature_coordinates_are_accepted() {
            // The mirror case. A feature geometry that happens to carry an
            // adjacent duplicate still describes the same ordered positions,
            // so a path without one corresponds to it.
            let road = envelope(
                &[(0.0, 0.0), (0.0, 0.0), (2.0, 2.0)],
                &[("n:1", 0.0, 0.0), ("n:3", 2.0, 2.0)],
            )
            .expect("an adjacent duplicate on either side is collapsed for the comparison");
            assert_eq!(road.feature().geometry().coordinate_count(), 3);
            assert_eq!(road.path().len(), 2);

            // Duplicates on both sides, in different places, still correspond.
            assert!(
                envelope(
                    &[(0.0, 0.0), (0.0, 0.0), (1.0, 1.0), (2.0, 2.0)],
                    &[
                        ("n:1", 0.0, 0.0),
                        ("n:2", 1.0, 1.0),
                        ("n:3", 1.0, 1.0),
                        ("n:4", 2.0, 2.0),
                    ],
                )
                .is_ok()
            );
        }

        #[test]
        fn a_non_adjacent_repeat_is_not_a_duplicate_to_collapse() {
            // A way that returns to a position it already visited describes a
            // genuine shape, and collapsing it would make two different roads
            // look alike. Only *adjacent* duplicates are the representational
            // difference the two forms are allowed to have.
            assert!(
                envelope(
                    &[(0.0, 0.0), (1.0, 1.0), (0.0, 0.0)],
                    &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0), ("n:1", 0.0, 0.0)],
                )
                .is_ok()
            );
            assert_eq!(
                envelope(
                    &[(0.0, 0.0), (1.0, 1.0), (0.0, 0.0)],
                    &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)],
                )
                .expect_err("a closed way is not the same shape as an open one"),
                mismatch(3, 2)
            );
        }

        #[test]
        fn correspondence_is_checked_for_every_road_class() {
            // The check is about geometry, so the class changes nothing.
            for class in [RoadClass::Motorway, RoadClass::Footway, RoadClass::Steps] {
                let matching = ImportedRoad::new(
                    classified_road("osm:way:1", class.clone(), &[(0.0, 0.0), (1.0, 1.0)]),
                    path(&[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
                );
                assert!(matching.is_ok(), "{class} should be accepted");

                let mismatched = ImportedRoad::new(
                    classified_road("osm:way:1", class.clone(), &[(0.0, 0.0), (1.0, 1.0)]),
                    path(&[("n:1", 7.0, 7.0), ("n:2", 8.0, 8.0)]),
                );
                assert_eq!(
                    mismatched.expect_err("a mismatch is a mismatch on any class"),
                    mismatch(2, 2)
                );
            }
        }
    }

    #[test]
    fn every_feature_kind_that_exists_today_is_a_road() {
        // `ImportedRoad::new` rejects a feature that is not a road. There is
        // no such feature to build yet: the exhaustive match below stops
        // compiling the moment a second `FeatureKind` variant is added, which
        // is the point at which that guard becomes reachable and needs a test
        // of its own.
        let feature = residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]);
        match feature.kind() {
            FeatureKind::Road { .. } => {}
        }
        assert!(ImportedRoad::new(feature, path(&[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)])).is_ok());
    }

    /// A road described as `(feature id, [(point id, longitude, latitude)])`.
    type RoadFixture<'a> = (&'a str, &'a [(&'a str, f64, f64)]);

    /// Builds a dataset-shaped input from `(feature id, path)` pairs.
    fn topology(roads: &[RoadFixture<'_>]) -> RoadTopology {
        try_topology(roads).expect("the topology builds")
    }

    fn try_topology(roads: &[RoadFixture<'_>]) -> Result<RoadTopology, DatasetBuildError> {
        let mut features: Vec<Arc<MapFeature>> = Vec::new();
        let mut paths: Vec<(FeatureId, RoadPath)> = Vec::new();
        for (id, points) in roads {
            features.push(Arc::new(residential(id, &coordinates(points))));
            paths.push((FeatureId::new(*id).expect("valid feature id"), path(points)));
        }
        derive_topology(&features, &paths)
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

    fn node_id(value: &str) -> RoadNodeId {
        RoadNodeId::new(value).expect("valid node id")
    }

    #[test]
    fn endpoints_are_promoted_and_internal_shape_points_are_not() {
        let topology = topology(&[(
            "osm:way:601",
            &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)],
        )]);
        assert_eq!(node_ids(&topology), vec!["n:1", "n:3"]);
        assert_eq!(segment_ids(&topology), vec!["osm:way:601:segment:0"]);
        // The shape point is still drawn: it stays in the geometry, it just is
        // not a place where anything joins.
        assert_eq!(topology.segments()[0].geometry().coordinate_count(), 3);
        assert_eq!(topology.degree(&node_id("n:1")), 1);
        assert_eq!(topology.degree(&node_id("n:3")), 1);
        assert_eq!(topology.degree(&node_id("n:2")), 0);
    }

    #[test]
    fn a_shared_identity_splits_every_road_that_uses_it() {
        // Two roads crossing at one shared identity: four segments, and the
        // shared node has degree four.
        let topology = topology(&[
            (
                "osm:way:605",
                &[("n:8", 0.0, 0.0), ("n:9", 1.0, 1.0), ("n:10", 2.0, 2.0)],
            ),
            (
                "osm:way:606",
                &[("n:11", 2.0, 0.0), ("n:9", 1.0, 1.0), ("n:12", 0.0, 2.0)],
            ),
        ]);
        assert_eq!(
            segment_ids(&topology),
            vec![
                "osm:way:605:segment:0",
                "osm:way:605:segment:1",
                "osm:way:606:segment:0",
                "osm:way:606:segment:1",
            ]
        );
        assert_eq!(topology.degree(&node_id("n:9")), 4);
        assert_eq!(topology.segments_at(&node_id("n:9")).len(), 4);
        for endpoint in ["n:8", "n:10", "n:11", "n:12"] {
            assert_eq!(topology.degree(&node_id(endpoint)), 1);
        }
    }

    #[test]
    fn a_repeated_identity_splits_one_road_and_forms_a_self_loop() {
        // 22-23-24-23-25: node 23 is seen twice, so it splits both times. The
        // middle segment leaves 23 and comes back to it.
        let topology = topology(&[(
            "osm:way:612",
            &[
                ("n:22", 0.0, 0.0),
                ("n:23", 1.0, 0.0),
                ("n:24", 1.5, 1.0),
                ("n:23", 1.0, 0.0),
                ("n:25", 2.0, 0.0),
            ],
        )]);
        assert_eq!(
            segment_ids(&topology),
            vec![
                "osm:way:612:segment:0",
                "osm:way:612:segment:1",
                "osm:way:612:segment:2",
            ]
        );
        // 24 is visited once, internally: a shape point, not a node.
        assert_eq!(node_ids(&topology), vec!["n:22", "n:23", "n:25"]);

        let middle = &topology.segments()[1];
        assert!(middle.is_loop());
        assert_eq!(middle.start().as_str(), "n:23");
        assert_eq!(middle.end().as_str(), "n:23");
        assert_eq!(middle.geometry().coordinate_count(), 3);

        // Three segment ends land on 23, and the loop contributes two of them.
        assert_eq!(topology.degree(&node_id("n:23")), 4);
        assert_eq!(topology.segments_at(&node_id("n:23")).len(), 3);
        assert_eq!(topology.degree(&node_id("n:22")), 1);
        assert_eq!(topology.degree(&node_id("n:25")), 1);
    }

    #[test]
    fn a_closed_way_with_one_split_point_is_a_single_self_loop() {
        let topology = topology(&[(
            "osm:way:609",
            &[
                ("n:17", 0.0, 0.0),
                ("n:18", 1.0, 1.0),
                ("n:19", 2.0, 0.0),
                ("n:17", 0.0, 0.0),
            ],
        )]);
        assert_eq!(segment_ids(&topology), vec!["osm:way:609:segment:0"]);
        assert_eq!(node_ids(&topology), vec!["n:17"]);
        let loop_segment = &topology.segments()[0];
        assert!(loop_segment.is_loop());
        assert_eq!(loop_segment.geometry().coordinate_count(), 4);
        assert_eq!(topology.degree(&node_id("n:17")), 2);
        assert_eq!(topology.segments_at(&node_id("n:17")).len(), 1);
    }

    #[test]
    fn equal_coordinates_with_different_identities_do_not_connect() {
        // Two roads whose points sit at exactly the same position but carry
        // different identities. Two disconnected segments, four nodes, and
        // nothing merged.
        let topology = topology(&[
            (
                "osm:way:616",
                &[("n:34", 0.0, 0.0), ("n:35", 1.0, 1.0), ("n:36", 2.0, 2.0)],
            ),
            ("osm:way:617", &[("n:37", 1.0, 1.0), ("n:38", 3.0, 3.0)]),
        ]);
        assert_eq!(node_ids(&topology), vec!["n:34", "n:36", "n:37", "n:38"]);
        assert_eq!(
            segment_ids(&topology),
            vec!["osm:way:616:segment:0", "osm:way:617:segment:0"]
        );
        for endpoint in ["n:34", "n:36", "n:37", "n:38"] {
            assert_eq!(topology.degree(&node_id(endpoint)), 1);
        }
        // `n:35` shares a position with `n:37` and is still only a shape
        // point: sharing a coordinate is not sharing an identity.
        assert!(topology.node(&node_id("n:35")).is_none());
    }

    #[test]
    fn geometric_crossings_without_a_shared_identity_do_not_connect() {
        // An X on the page: the two lines cross at (1,1) and share no point.
        let topology = topology(&[
            ("osm:way:607", &[("n:13", 0.0, 0.0), ("n:14", 2.0, 2.0)]),
            ("osm:way:608", &[("n:15", 0.0, 2.0), ("n:16", 2.0, 0.0)]),
        ]);
        assert_eq!(topology.segment_count(), 2);
        assert_eq!(topology.node_count(), 4);
        for endpoint in ["n:13", "n:14", "n:15", "n:16"] {
            assert_eq!(topology.degree(&node_id(endpoint)), 1);
        }
    }

    #[test]
    fn parallel_segments_between_one_pair_of_nodes_stay_distinct() {
        let topology = topology(&[
            ("osm:way:1", &[("n:a", 0.0, 0.0), ("n:b", 2.0, 0.0)]),
            (
                "osm:way:2",
                &[("n:a", 0.0, 0.0), ("n:c", 1.0, 1.0), ("n:b", 2.0, 0.0)],
            ),
        ]);
        assert_eq!(
            segment_ids(&topology),
            vec!["osm:way:1:segment:0", "osm:way:2:segment:0"]
        );
        assert_eq!(topology.degree(&node_id("n:a")), 2);
        assert_eq!(topology.degree(&node_id("n:b")), 2);
        assert_eq!(topology.segments_at(&node_id("n:a")).len(), 2);
    }

    #[test]
    fn output_order_and_identifiers_do_not_depend_on_emission_order() {
        let forwards = topology(&[
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
            ("osm:way:2", &[("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)]),
            ("osm:way:3", &[("n:3", 2.0, 2.0), ("n:4", 3.0, 3.0)]),
        ]);
        let backwards = topology(&[
            ("osm:way:3", &[("n:3", 2.0, 2.0), ("n:4", 3.0, 3.0)]),
            ("osm:way:2", &[("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)]),
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
        ]);
        assert_eq!(node_ids(&forwards), node_ids(&backwards));
        assert_eq!(segment_ids(&forwards), segment_ids(&backwards));
        assert_eq!(
            segment_ids(&forwards),
            vec![
                "osm:way:1:segment:0",
                "osm:way:2:segment:0",
                "osm:way:3:segment:0"
            ]
        );
        for id in ["n:1", "n:2", "n:3", "n:4"] {
            assert_eq!(
                forwards.degree(&node_id(id)),
                backwards.degree(&node_id(id))
            );
        }
    }

    #[test]
    fn one_identity_claiming_two_positions_fails_the_whole_build() {
        let error = try_topology(&[
            ("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
            ("osm:way:2", &[("n:2", 9.0, 9.0), ("n:3", 2.0, 2.0)]),
        ])
        .expect_err("one identity cannot be in two places");
        assert_eq!(
            error,
            DatasetBuildError::ConflictingPointCoordinate {
                point: "n:2".to_owned()
            }
        );
    }

    #[test]
    fn two_paths_for_one_road_collide_on_their_segment_identifiers() {
        let feature = Arc::new(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]));
        let id = FeatureId::new("osm:way:1").expect("valid feature id");
        let error = derive_topology(
            &[feature],
            &[
                (id.clone(), path(&[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)])),
                (id, path(&[("n:3", 2.0, 2.0), ("n:4", 3.0, 3.0)])),
            ],
        )
        .expect_err("one road cannot have two paths");
        assert_eq!(
            error,
            DatasetBuildError::DuplicateSegmentId {
                id: "osm:way:1:segment:0".to_owned()
            }
        );
    }

    #[test]
    fn a_path_for_a_feature_the_dataset_does_not_hold_fails_the_build() {
        let feature = Arc::new(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]));
        let error = derive_topology(
            &[feature],
            &[(
                FeatureId::new("osm:way:999").expect("valid feature id"),
                path(&[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]),
            )],
        )
        .expect_err("a segment cannot belong to a feature that is not there");
        assert_eq!(
            error,
            DatasetBuildError::UnknownSegmentFeature {
                segment: "osm:way:999:segment:0".to_owned(),
                feature: "osm:way:999".to_owned()
            }
        );
    }

    /// The referential guards in `assemble`, driven directly.
    ///
    /// The derivation above cannot produce these states, which is exactly why
    /// they are checked: `assemble` is the one place that decides a topology
    /// is publishable, and it must not take the derivation's word for it.
    mod assembly_guards {
        use super::*;
        use atlas_kernel::{RoadNode, RoadSegment};

        fn coordinate(longitude: f64, latitude: f64) -> GeoCoordinate {
            GeoCoordinate::from_degrees(longitude, latitude).expect("valid coordinate")
        }

        fn node(id: &str, longitude: f64, latitude: f64) -> RoadNode {
            RoadNode::new(node_id(id), coordinate(longitude, latitude))
        }

        fn segment(id: &str, road: &str, start: &RoadNode, end: &RoadNode) -> RoadSegment {
            RoadSegment::new(
                RoadSegmentId::new(id).expect("valid segment id"),
                FeatureId::new(road).expect("valid feature id"),
                start,
                end,
                vec![start.coordinate(), end.coordinate()],
            )
            .expect("valid segment")
        }

        fn features(ids: &[&str]) -> Vec<Arc<MapFeature>> {
            ids.iter()
                .map(|id| Arc::new(residential(id, &[(0.0, 0.0), (1.0, 1.0)])))
                .collect()
        }

        #[test]
        fn duplicate_node_identifiers_are_rejected() {
            let first = node("n:1", 0.0, 0.0);
            let second = node("n:1", 0.0, 0.0);
            let error =
                RoadTopology::assemble(vec![first, second], Vec::new(), &features(&["osm:way:1"]))
                    .expect_err("two nodes cannot share an id");
            assert_eq!(
                error,
                DatasetBuildError::DuplicateNodeId {
                    id: "n:1".to_owned()
                }
            );
        }

        #[test]
        fn a_segment_pointing_at_a_node_the_topology_lacks_is_rejected() {
            let start = node("n:1", 0.0, 0.0);
            let end = node("n:2", 1.0, 1.0);
            let edge = segment("s:1", "osm:way:1", &start, &end);
            // The end node is deliberately left out of the node collection.
            let error = RoadTopology::assemble(vec![start], vec![edge], &features(&["osm:way:1"]))
                .expect_err("a segment cannot point at a node that is not there");
            assert_eq!(
                error,
                DatasetBuildError::UnknownSegmentNode {
                    segment: "s:1".to_owned(),
                    node: "n:2".to_owned()
                }
            );
        }

        #[test]
        fn a_valid_assembly_indexes_degree_and_incidence() {
            let start = node("n:1", 0.0, 0.0);
            let end = node("n:2", 1.0, 1.0);
            let edge = segment("s:1", "osm:way:1", &start, &end);
            let loop_edge = segment("s:2", "osm:way:1", &end, &end);
            let topology = RoadTopology::assemble(
                vec![end.clone(), start.clone()],
                vec![loop_edge, edge],
                &features(&["osm:way:1"]),
            )
            .expect("a consistent topology assembles");

            assert_eq!(segment_ids(&topology), vec!["s:1", "s:2"]);
            assert_eq!(node_ids(&topology), vec!["n:1", "n:2"]);
            assert_eq!(topology.degree(&node_id("n:1")), 1);
            // One ordinary end plus a self-loop's two.
            assert_eq!(topology.degree(&node_id("n:2")), 3);
            assert_eq!(
                topology.segments_at(&node_id("n:2")),
                &[
                    RoadSegmentId::new("s:1").expect("valid id"),
                    RoadSegmentId::new("s:2").expect("valid id"),
                ]
            );
            assert_eq!(
                topology.node(&node_id("n:2")).map(|node| node.coordinate()),
                Some(coordinate(1.0, 1.0))
            );
            assert!(topology.node(&node_id("n:404")).is_none());
            assert_eq!(topology.degree(&node_id("n:404")), 0);
            assert!(topology.segments_at(&node_id("n:404")).is_empty());
        }
    }

    #[test]
    fn a_road_class_never_reaches_the_topology() {
        // Two identical shapes, one a motorway and one a footway. The class
        // decides nothing about connectivity, so the two topologies are the
        // same graph.
        let shape: &[(&str, f64, f64)] = &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)];
        let mut motorway_features = Vec::new();
        let mut footway_features = Vec::new();
        let mut paths = Vec::new();
        motorway_features.push(Arc::new(crate::test_support::road(
            "osm:way:1",
            RoadClass::Motorway,
            &coordinates(shape),
        )));
        footway_features.push(Arc::new(crate::test_support::road(
            "osm:way:1",
            RoadClass::Footway,
            &coordinates(shape),
        )));
        paths.push((FeatureId::new("osm:way:1").expect("valid id"), path(shape)));

        let motorway = derive_topology(&motorway_features, &paths).expect("builds");
        let footway = derive_topology(&footway_features, &paths).expect("builds");
        assert_eq!(node_ids(&motorway), node_ids(&footway));
        assert_eq!(segment_ids(&motorway), segment_ids(&footway));
    }

    #[test]
    fn segment_identifiers_are_the_documented_text() {
        let road = FeatureId::new("osm:way:10").expect("valid id");
        assert_eq!(segment_id_text(&road, 0), "osm:way:10:segment:0");
        assert_eq!(segment_id_text(&road, 7), "osm:way:10:segment:7");
    }
}
