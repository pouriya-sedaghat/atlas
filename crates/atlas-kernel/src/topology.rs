//! Source-derived road topology: which road paths are structurally joined.
//!
//! This module answers exactly one question — **which parts of which road
//! geometries are connected to which** — and deliberately answers nothing
//! else.
//!
//! # A segment is not a permitted traversal
//!
//! A [`RoadSegment`] is a *structural edge*. It says that two source point
//! identities are joined by one part of one road geometry. It does **not**
//! say:
//!
//! * that any mode may travel it — that is [`crate::RoadAccess`], on the road;
//! * which way a mode travels it — that is [`crate::RoadTraversal`], on the
//!   road;
//! * how fast the law allows — that is [`crate::RoadSpeedLimits`], on the
//!   road;
//! * what it costs, how long it takes, or whether a route should use it —
//!   Atlas does not answer routing questions at all yet.
//!
//! None of those four facts is copied onto a segment. A segment references its
//! owning [`FeatureId`], and whoever needs a road fact reads it from the road
//! through that reference. Copying would create a second place for a fact to
//! live and a second thing to keep in step with the source.
//!
//! # Segments are undirected
//!
//! `start` and `end` name the first and last point **in geometry order**, and
//! nothing more. They are not an origin and a destination, and they do not
//! imply that travel runs from one to the other. A reverse one-way is stored in
//! exactly the coordinate order the source drew it in; nothing here ever
//! reverses a geometry to match a direction of travel.
//!
//! # Identity, not position, is the connectivity key
//!
//! Two paths are connected where they share a **source point identity**. Two
//! points that merely happen to sit at the same coordinate are not connected,
//! and two lines that cross geometrically without sharing an identity are not
//! connected either. That is why [`RoadSegment`] validates its endpoints
//! against node *coordinates* but joins on node *ids*.

use std::fmt;

use crate::coordinate::GeoCoordinate;
use crate::feature::FeatureId;
use crate::geometry::{GeometryError, LineString};

/// Everything that can go wrong while constructing a topology value.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TopologyError {
    /// A road node identifier was empty or blank.
    #[error("a road node id must not be blank")]
    BlankNodeId,
    /// A road segment identifier was empty or blank.
    #[error("a road segment id must not be blank")]
    BlankSegmentId,
    /// The segment geometry itself was not usable.
    #[error(transparent)]
    Geometry(#[from] GeometryError),
    /// The first geometry coordinate was not the start node's coordinate.
    #[error("segment geometry must begin at start node `{node}`")]
    StartCoordinateMismatch {
        /// The start node the geometry disagreed with.
        node: String,
    },
    /// The last geometry coordinate was not the end node's coordinate.
    #[error("segment geometry must end at end node `{node}`")]
    EndCoordinateMismatch {
        /// The end node the geometry disagreed with.
        node: String,
    },
}

/// A stable, opaque identifier for a topology node.
///
/// The value is derived deterministically from the source point identity by
/// the input adapter, so re-importing the same file produces the same ids.
/// Clients must treat it as an opaque string and must not parse it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoadNodeId(String);

impl RoadNodeId {
    /// Builds an identifier, rejecting blank values.
    pub fn new(value: impl Into<String>) -> Result<Self, TopologyError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(TopologyError::BlankNodeId);
        }
        Ok(Self(value))
    }

    /// The identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RoadNodeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A stable, opaque identifier for a topology segment.
///
/// Derived deterministically from the owning road's identity and the segment's
/// ordinal within that road, so the same import produces the same ids. Clients
/// must treat it as an opaque string and must not parse it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoadSegmentId(String);

impl RoadSegmentId {
    /// Builds an identifier, rejecting blank values.
    pub fn new(value: impl Into<String>) -> Result<Self, TopologyError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(TopologyError::BlankSegmentId);
        }
        Ok(Self(value))
    }

    /// The identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RoadSegmentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A point where road paths are structurally joined, or where one ends.
///
/// A node is a position with an identity, and nothing else. It carries no
/// degree, no incident segments and no traffic rules: degree is a property of
/// the whole topology rather than of the node, so it is answered by the
/// aggregate that owns every segment, not by this value.
#[derive(Debug, Clone, PartialEq)]
pub struct RoadNode {
    id: RoadNodeId,
    coordinate: GeoCoordinate,
}

impl RoadNode {
    /// Builds a node from an already validated id and coordinate.
    pub fn new(id: RoadNodeId, coordinate: GeoCoordinate) -> Self {
        Self { id, coordinate }
    }

    /// The opaque node identifier.
    pub fn id(&self) -> &RoadNodeId {
        &self.id
    }

    /// Where the node is.
    pub fn coordinate(&self) -> GeoCoordinate {
        self.coordinate
    }
}

/// One structural edge of the road topology.
///
/// **A segment is a structural connection, not a permitted traversal.** It
/// records that the part of `road`'s geometry running between `start` and
/// `end` exists as one piece. Whether any mode may use it, in which direction,
/// on what terms and at what legal maximum are four separate facts that live
/// on the road itself and are reached through [`RoadSegment::road`]. None of
/// them is copied here, and no method on this type answers any of them.
///
/// `start` and `end` mean *first* and *last point in geometry order*. They are
/// not a direction of travel. The two may be equal: a closed way or a
/// self-intersecting way produces a legitimate self-loop, and a self-loop is
/// structural topology like any other segment.
#[derive(Debug, Clone, PartialEq)]
pub struct RoadSegment {
    id: RoadSegmentId,
    road: FeatureId,
    start: RoadNodeId,
    end: RoadNodeId,
    geometry: LineString,
}

impl RoadSegment {
    /// Builds a segment, validating it against the nodes it claims to join.
    ///
    /// The nodes are supplied rather than just their ids so that the
    /// coordinate invariants can actually be checked: a segment that claims to
    /// start at a node must begin at that node's position.
    ///
    /// Note what this constructor does *not* take. There is no class, no
    /// direction, no access rule and no speed limit in the signature, because
    /// a segment holds none of them.
    pub fn new(
        id: RoadSegmentId,
        road: FeatureId,
        start: &RoadNode,
        end: &RoadNode,
        coordinates: Vec<GeoCoordinate>,
    ) -> Result<Self, TopologyError> {
        let geometry = LineString::new(coordinates)?;
        let points = geometry.coordinates();
        // `LineString` has already guaranteed at least two coordinates, so
        // both ends exist.
        if points[0] != start.coordinate() {
            return Err(TopologyError::StartCoordinateMismatch {
                node: start.id().as_str().to_owned(),
            });
        }
        if points[points.len() - 1] != end.coordinate() {
            return Err(TopologyError::EndCoordinateMismatch {
                node: end.id().as_str().to_owned(),
            });
        }
        Ok(Self {
            id,
            road: road.clone(),
            start: start.id().clone(),
            end: end.id().clone(),
            geometry,
        })
    }

    /// The opaque segment identifier.
    pub fn id(&self) -> &RoadSegmentId {
        &self.id
    }

    /// The road feature this segment is part of.
    ///
    /// This is the join back to the road's class, direction, access and speed
    /// facts. It is a reference on purpose: those facts have exactly one home,
    /// and it is not here.
    pub fn road(&self) -> &FeatureId {
        &self.road
    }

    /// The node at the first coordinate of the geometry.
    ///
    /// "Start" is a position in the coordinate sequence, never a direction of
    /// travel.
    pub fn start(&self) -> &RoadNodeId {
        &self.start
    }

    /// The node at the last coordinate of the geometry.
    ///
    /// "End" is a position in the coordinate sequence, never a direction of
    /// travel.
    pub fn end(&self) -> &RoadNodeId {
        &self.end
    }

    /// The segment geometry, in the source's own coordinate order.
    pub fn geometry(&self) -> &LineString {
        &self.geometry
    }

    /// Whether both ends are the same node, making this a self-loop.
    pub fn is_loop(&self) -> bool {
        self.start == self.end
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinate(longitude: f64, latitude: f64) -> GeoCoordinate {
        GeoCoordinate::from_degrees(longitude, latitude).expect("valid test coordinate")
    }

    fn node(id: &str, longitude: f64, latitude: f64) -> RoadNode {
        RoadNode::new(
            RoadNodeId::new(id).expect("valid node id"),
            coordinate(longitude, latitude),
        )
    }

    fn segment_id(value: &str) -> RoadSegmentId {
        RoadSegmentId::new(value).expect("valid segment id")
    }

    fn road(value: &str) -> FeatureId {
        FeatureId::new(value).expect("valid feature id")
    }

    #[test]
    fn node_ids_reject_blank_values() {
        assert_eq!(RoadNodeId::new(""), Err(TopologyError::BlankNodeId));
        assert_eq!(RoadNodeId::new("   "), Err(TopologyError::BlankNodeId));
        assert_eq!(RoadNodeId::new("\t\n"), Err(TopologyError::BlankNodeId));
        let id = RoadNodeId::new("osm:node:42").expect("valid id");
        assert_eq!(id.as_str(), "osm:node:42");
        assert_eq!(id.to_string(), "osm:node:42");
    }

    #[test]
    fn segment_ids_reject_blank_values() {
        assert_eq!(RoadSegmentId::new(""), Err(TopologyError::BlankSegmentId));
        assert_eq!(
            RoadSegmentId::new("   "),
            Err(TopologyError::BlankSegmentId)
        );
        let id = RoadSegmentId::new("osm:way:10:segment:0").expect("valid id");
        assert_eq!(id.as_str(), "osm:way:10:segment:0");
        assert_eq!(id.to_string(), "osm:way:10:segment:0");
    }

    #[test]
    fn a_node_is_an_identity_and_a_position() {
        let start = node("osm:node:1", 51.38, 35.68);
        assert_eq!(start.id().as_str(), "osm:node:1");
        assert_eq!(start.coordinate(), coordinate(51.38, 35.68));
    }

    #[test]
    fn a_segment_joins_the_nodes_at_its_ends() {
        let start = node("osm:node:1", 51.38, 35.68);
        let end = node("osm:node:3", 51.40, 35.70);
        let segment = RoadSegment::new(
            segment_id("osm:way:10:segment:0"),
            road("osm:way:10"),
            &start,
            &end,
            vec![
                coordinate(51.38, 35.68),
                coordinate(51.39, 35.69),
                coordinate(51.40, 35.70),
            ],
        )
        .expect("a valid segment");

        assert_eq!(segment.id().as_str(), "osm:way:10:segment:0");
        assert_eq!(segment.road().as_str(), "osm:way:10");
        assert_eq!(segment.start().as_str(), "osm:node:1");
        assert_eq!(segment.end().as_str(), "osm:node:3");
        assert_eq!(segment.geometry().coordinate_count(), 3);
        assert!(!segment.is_loop());
    }

    #[test]
    fn segment_geometry_needs_at_least_two_coordinates() {
        let start = node("osm:node:1", 51.38, 35.68);
        assert_eq!(
            RoadSegment::new(
                segment_id("osm:way:10:segment:0"),
                road("osm:way:10"),
                &start,
                &start,
                vec![coordinate(51.38, 35.68)],
            ),
            Err(TopologyError::Geometry(GeometryError::TooFewCoordinates {
                count: 1
            }))
        );
        assert_eq!(
            RoadSegment::new(
                segment_id("osm:way:10:segment:0"),
                road("osm:way:10"),
                &start,
                &start,
                Vec::new(),
            ),
            Err(TopologyError::Geometry(GeometryError::TooFewCoordinates {
                count: 0
            }))
        );
    }

    #[test]
    fn segment_geometry_must_begin_at_its_start_node() {
        let start = node("osm:node:1", 51.38, 35.68);
        let end = node("osm:node:3", 51.40, 35.70);
        assert_eq!(
            RoadSegment::new(
                segment_id("osm:way:10:segment:0"),
                road("osm:way:10"),
                &start,
                &end,
                vec![coordinate(51.39, 35.69), coordinate(51.40, 35.70)],
            ),
            Err(TopologyError::StartCoordinateMismatch {
                node: "osm:node:1".to_owned()
            })
        );
    }

    #[test]
    fn segment_geometry_must_end_at_its_end_node() {
        let start = node("osm:node:1", 51.38, 35.68);
        let end = node("osm:node:3", 51.40, 35.70);
        assert_eq!(
            RoadSegment::new(
                segment_id("osm:way:10:segment:0"),
                road("osm:way:10"),
                &start,
                &end,
                vec![coordinate(51.38, 35.68), coordinate(51.39, 35.69)],
            ),
            Err(TopologyError::EndCoordinateMismatch {
                node: "osm:node:3".to_owned()
            })
        );
    }

    #[test]
    fn a_closed_way_is_a_valid_self_loop() {
        // A roundabout whose only split point is its own repeated endpoint:
        // one segment that starts and ends at the same node. Structural
        // topology, not a degenerate case to reject.
        let hinge = node("osm:node:17", 51.38, 35.68);
        let segment = RoadSegment::new(
            segment_id("osm:way:609:segment:0"),
            road("osm:way:609"),
            &hinge,
            &hinge,
            vec![
                coordinate(51.38, 35.68),
                coordinate(51.39, 35.69),
                coordinate(51.40, 35.68),
                coordinate(51.38, 35.68),
            ],
        )
        .expect("a closed way is valid topology");

        assert!(segment.is_loop());
        assert_eq!(segment.start(), segment.end());
        assert_eq!(segment.geometry().coordinate_count(), 4);
    }

    #[test]
    fn equal_coordinates_with_different_identities_stay_distinct_nodes() {
        // Two source points at exactly one position. They are two nodes, not
        // one: merging them would invent a connection the source never
        // described.
        let left = node("osm:node:35", 51.38, 35.68);
        let right = node("osm:node:37", 51.38, 35.68);
        assert_eq!(left.coordinate(), right.coordinate());
        assert_ne!(left.id(), right.id());
        assert_ne!(left, right);

        // And a zero-length segment between two such identities is valid: the
        // source described a structural connection, and refusing it would
        // silently delete that statement.
        let segment = RoadSegment::new(
            segment_id("osm:way:700:segment:0"),
            road("osm:way:700"),
            &left,
            &right,
            vec![coordinate(51.38, 35.68), coordinate(51.38, 35.68)],
        )
        .expect("distinct identities at one coordinate are a valid segment");
        assert_ne!(segment.start(), segment.end());
        assert!(!segment.is_loop());
        assert_eq!(segment.geometry().coordinate_count(), 2);
    }

    #[test]
    fn a_segment_carries_no_road_semantics_of_its_own() {
        // The whole public surface of a segment, bound one accessor at a time.
        // Six answers, and every one of them is structural: an identity, the
        // road it belongs to, the two ends of the geometry, the geometry, and
        // whether the two ends coincide.
        //
        // Nothing here reports a class, a direction, an access rule, a speed
        // limit, a cost, a length, a travel time or a permission, and an
        // accessor added without a line in this test is an accessor nobody
        // checked. The constructor makes the same point at compile time: none
        // of those four road records can be passed to it.
        let start = node("osm:node:1", 51.38, 35.68);
        let end = node("osm:node:2", 51.39, 35.69);
        let segment = RoadSegment::new(
            segment_id("osm:way:10:segment:0"),
            road("osm:way:10"),
            &start,
            &end,
            vec![coordinate(51.38, 35.68), coordinate(51.39, 35.69)],
        )
        .expect("a valid segment");

        let RoadSegment {
            id,
            road: owner,
            start: start_id,
            end: end_id,
            geometry,
        } = &segment;
        assert_eq!(segment.id(), id);
        assert_eq!(segment.road(), owner);
        assert_eq!(segment.start(), start_id);
        assert_eq!(segment.end(), end_id);
        assert_eq!(segment.geometry(), geometry);
        assert_eq!(segment.is_loop(), start_id == end_id);

        // The road facts are reached through the reference, never copied. Two
        // roads whose semantics differ in every way produce segments that
        // differ only in the identity they point at.
        let other = RoadSegment::new(
            segment_id("osm:way:10:segment:0"),
            road("osm:way:11"),
            &start,
            &end,
            vec![coordinate(51.38, 35.68), coordinate(51.39, 35.69)],
        )
        .expect("a valid segment");
        assert_ne!(segment.road(), other.road());
        assert_eq!(segment.geometry(), other.geometry());
        assert_eq!(segment.start(), other.start());
        assert_eq!(segment.end(), other.end());
    }

    #[test]
    fn a_segment_is_undirected_and_never_reverses_its_source_order() {
        // The same two nodes joined in both orders are two different segments,
        // and each keeps exactly the coordinate order it was given. Nothing
        // here normalises a segment to run "the right way": a reverse one-way
        // is stored as the source drew it, and the direction it is travelled
        // is a road fact read through `road()`.
        let west = node("osm:node:31", 51.38, 35.68);
        let east = node("osm:node:33", 51.40, 35.70);
        let coordinates = vec![coordinate(51.38, 35.68), coordinate(51.40, 35.70)];
        let mut reversed = coordinates.clone();
        reversed.reverse();

        let forwards = RoadSegment::new(
            segment_id("osm:way:615:segment:0"),
            road("osm:way:615"),
            &west,
            &east,
            coordinates,
        )
        .expect("a valid segment");
        let backwards = RoadSegment::new(
            segment_id("osm:way:616:segment:0"),
            road("osm:way:616"),
            &east,
            &west,
            reversed,
        )
        .expect("a valid segment");

        assert_eq!(forwards.start(), backwards.end());
        assert_eq!(forwards.end(), backwards.start());
        assert_ne!(forwards.geometry(), backwards.geometry());
        assert_eq!(
            forwards.geometry().coordinates().first(),
            Some(&coordinate(51.38, 35.68))
        );
        assert_eq!(
            backwards.geometry().coordinates().first(),
            Some(&coordinate(51.40, 35.70))
        );
    }

    /// A probe for whether a concrete type implements [`Default`].
    ///
    /// The same trick the access and speed modules use: `implements_default`
    /// is offered twice, once on `&Probe<T>` where `T: Default` and once on
    /// `Probe<T>` where nothing is required. Rust tries the fewest autorefs
    /// first, so the `Default` candidate wins wherever it applies and the
    /// fallback answers otherwise — which is what lets a test assert the
    /// *absence* of an impl, something the language cannot state directly.
    struct Probe<T>(std::marker::PhantomData<T>);

    trait DefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T: Default> DefaultedProbe for &Probe<T> {
        fn implements_default(&self) -> bool {
            true
        }
    }

    trait UndefaultedProbe {
        fn implements_default(&self) -> bool;
    }

    impl<T> UndefaultedProbe for Probe<T> {
        fn implements_default(&self) -> bool {
            false
        }
    }

    macro_rules! implements_default {
        ($subject:ty) => {
            (&&Probe::<$subject>(std::marker::PhantomData)).implements_default()
        };
    }

    #[test]
    fn source_derived_topology_values_deliberately_have_no_default() {
        // Every one of these is a claim about what a source file said. A
        // `Default` impl would let a half-built import, a forgotten field or a
        // future adapter make that claim by accident, and a default node id,
        // default position or empty segment would be indistinguishable from
        // something a real file described.
        assert!(
            !implements_default!(RoadNodeId),
            "RoadNodeId must not implement Default: there is no neutral identity"
        );
        assert!(
            !implements_default!(RoadSegmentId),
            "RoadSegmentId must not implement Default: there is no neutral identity"
        );
        assert!(
            !implements_default!(RoadNode),
            "RoadNode must not implement Default: there is no neutral position"
        );
        assert!(
            !implements_default!(RoadSegment),
            "RoadSegment must not implement Default: there is no neutral edge"
        );
        // The probe has to be able to see a real `Default`, or the assertions
        // above would pass for the wrong reason.
        assert!(implements_default!(u8));
        assert!(implements_default!(String));
        // And the road records keep the same stance they have held since 2A.
        assert!(!implements_default!(crate::access::RoadAccess));
        assert!(!implements_default!(crate::traversal::RoadTraversal));
    }
}
