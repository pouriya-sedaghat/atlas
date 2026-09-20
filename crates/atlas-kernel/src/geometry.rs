//! The geometry model Atlas needs for this milestone.
//!
//! Only line strings exist today because the only features Atlas imports are
//! roads. Points and polygons will be added when a use case asks for them.

use crate::bounding_box::{BoundingBox, BoundingBoxError};
use crate::coordinate::GeoCoordinate;

/// Everything that can go wrong while constructing geometry.
#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
pub enum GeometryError {
    /// A line string was built from fewer than two coordinates.
    #[error("a line string needs at least 2 coordinates, got {count}")]
    TooFewCoordinates {
        /// How many coordinates were supplied.
        count: usize,
    },
    /// The bounds of the line string could not be derived.
    #[error(transparent)]
    Bounds(#[from] BoundingBoxError),
}

/// An immutable polyline of at least two coordinates.
///
/// The bounding box is computed once at construction time and cached, because
/// viewport queries test it for every feature on every request.
#[derive(Debug, Clone, PartialEq)]
pub struct LineString {
    coordinates: Box<[GeoCoordinate]>,
    bounds: BoundingBox,
}

impl LineString {
    /// The smallest number of coordinates a line string may have.
    pub const MIN_COORDINATES: usize = 2;

    /// Builds a line string, rejecting anything shorter than two coordinates.
    pub fn new(coordinates: Vec<GeoCoordinate>) -> Result<Self, GeometryError> {
        if coordinates.len() < Self::MIN_COORDINATES {
            return Err(GeometryError::TooFewCoordinates {
                count: coordinates.len(),
            });
        }
        let bounds = BoundingBox::from_coordinates(&coordinates)?;
        Ok(Self {
            coordinates: coordinates.into_boxed_slice(),
            bounds,
        })
    }

    /// Read-only access to the coordinates, in order.
    pub fn coordinates(&self) -> &[GeoCoordinate] {
        &self.coordinates
    }

    /// How many coordinates the line has.
    pub fn coordinate_count(&self) -> usize {
        self.coordinates.len()
    }

    /// The cached bounding box of the line.
    pub fn bounds(&self) -> &BoundingBox {
        &self.bounds
    }

    /// Whether any part of the line lies inside `bbox`, edges included.
    ///
    /// This is an exact test, not a bounds-versus-bounds approximation: a
    /// segment that crosses the box while both of its endpoints sit outside it
    /// still counts as an intersection.
    pub fn intersects_bounding_box(&self, bbox: &BoundingBox) -> bool {
        // Cheap rejection first; most features in a large dataset fail here.
        if !self.bounds.intersects(bbox) {
            return false;
        }
        if self.coordinates.iter().any(|point| bbox.contains(point)) {
            return true;
        }
        self.coordinates
            .windows(2)
            .any(|segment| segment_intersects_box(segment[0], segment[1], bbox))
    }
}

/// Liang-Barsky clipping, used purely as a yes/no intersection test.
///
/// Comparisons are non-strict so that a segment merely touching an edge or a
/// corner is reported as intersecting.
fn segment_intersects_box(start: GeoCoordinate, end: GeoCoordinate, bbox: &BoundingBox) -> bool {
    let x0 = start.longitude_degrees();
    let y0 = start.latitude_degrees();
    let dx = end.longitude_degrees() - x0;
    let dy = end.latitude_degrees() - y0;

    let edges = [
        (-dx, x0 - bbox.west()),
        (dx, bbox.east() - x0),
        (-dy, y0 - bbox.south()),
        (dy, bbox.north() - y0),
    ];

    let mut enter = 0.0_f64;
    let mut leave = 1.0_f64;
    for (direction, distance) in edges {
        if direction == 0.0 {
            // The segment is parallel to this edge: it can only be rejected,
            // never clipped.
            if distance < 0.0 {
                return false;
            }
            continue;
        }
        let crossing = distance / direction;
        if direction < 0.0 {
            if crossing > leave {
                return false;
            }
            if crossing > enter {
                enter = crossing;
            }
        } else {
            if crossing < enter {
                return false;
            }
            if crossing < leave {
                leave = crossing;
            }
        }
    }
    enter <= leave
}

/// The geometry of a map feature.
#[derive(Debug, Clone, PartialEq)]
pub enum Geometry {
    /// A polyline, currently the only supported shape.
    LineString(LineString),
}

impl Geometry {
    /// The cached bounding box of the geometry.
    pub fn bounds(&self) -> &BoundingBox {
        match self {
            Geometry::LineString(line) => line.bounds(),
        }
    }

    /// Whether any part of the geometry lies inside `bbox`, edges included.
    pub fn intersects_bounding_box(&self, bbox: &BoundingBox) -> bool {
        match self {
            Geometry::LineString(line) => line.intersects_bounding_box(bbox),
        }
    }

    /// How many coordinates the geometry is made of.
    pub fn coordinate_count(&self) -> usize {
        match self {
            Geometry::LineString(line) => line.coordinate_count(),
        }
    }
}

impl From<LineString> for Geometry {
    fn from(line: LineString) -> Self {
        Geometry::LineString(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinate(longitude: f64, latitude: f64) -> GeoCoordinate {
        GeoCoordinate::from_degrees(longitude, latitude).expect("valid test coordinate")
    }

    fn polyline(points: &[(f64, f64)]) -> LineString {
        LineString::new(
            points
                .iter()
                .map(|(longitude, latitude)| coordinate(*longitude, *latitude))
                .collect(),
        )
        .expect("valid test line")
    }

    fn bbox(west: f64, south: f64, east: f64, north: f64) -> BoundingBox {
        BoundingBox::from_degrees(west, south, east, north).expect("valid test bounding box")
    }

    #[test]
    fn rejects_lines_with_fewer_than_two_coordinates() {
        assert_eq!(
            LineString::new(vec![]),
            Err(GeometryError::TooFewCoordinates { count: 0 })
        );
        assert_eq!(
            LineString::new(vec![coordinate(0.0, 0.0)]),
            Err(GeometryError::TooFewCoordinates { count: 1 })
        );
    }

    #[test]
    fn accepts_a_two_point_line() {
        let line = polyline(&[(0.0, 0.0), (1.0, 1.0)]);
        assert_eq!(line.coordinate_count(), 2);
    }

    #[test]
    fn caches_bounds_covering_every_coordinate() {
        let line = polyline(&[(2.0, 5.0), (-1.0, 9.0), (4.0, 1.0)]);
        let bounds = line.bounds();
        assert_eq!(bounds.west(), -1.0);
        assert_eq!(bounds.south(), 1.0);
        assert_eq!(bounds.east(), 4.0);
        assert_eq!(bounds.north(), 9.0);
        // Calling again returns the same cached value rather than recomputing.
        assert_eq!(line.bounds(), bounds);
    }

    #[test]
    fn coordinates_are_read_only_and_ordered() {
        let line = polyline(&[(0.0, 0.0), (1.0, 2.0)]);
        assert_eq!(
            line.coordinates(),
            &[coordinate(0.0, 0.0), coordinate(1.0, 2.0)]
        );
    }

    #[test]
    fn point_inside_the_box_counts() {
        let line = polyline(&[(-10.0, 5.0), (5.0, 5.0)]);
        assert!(line.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn segment_crossing_the_box_with_both_endpoints_outside_counts() {
        let line = polyline(&[(-5.0, 5.0), (15.0, 5.0)]);
        assert!(line.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));

        let diagonal = polyline(&[(-5.0, -5.0), (15.0, 15.0)]);
        assert!(diagonal.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn segment_touching_an_edge_counts() {
        // Runs exactly along the northern edge of the box.
        let along_edge = polyline(&[(-5.0, 10.0), (15.0, 10.0)]);
        assert!(along_edge.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));

        // Ends exactly on the western edge.
        let touching = polyline(&[(-5.0, 5.0), (0.0, 5.0)]);
        assert!(touching.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));

        // Touches a single corner.
        let corner = polyline(&[(-5.0, 15.0), (0.0, 10.0)]);
        assert!(corner.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn line_fully_outside_does_not_count() {
        let line = polyline(&[(20.0, 20.0), (30.0, 30.0)]);
        assert!(!line.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn line_whose_bounds_overlap_but_geometry_does_not_is_rejected() {
        // An "L" shape whose bounding box covers the query box while none of
        // its segments actually enter it.
        let elbow = polyline(&[(-5.0, 15.0), (15.0, 15.0), (15.0, -5.0)]);
        assert!(elbow.bounds().intersects(&bbox(0.0, 0.0, 10.0, 10.0)));
        assert!(!elbow.intersects_bounding_box(&bbox(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn geometry_delegates_to_the_line() {
        let geometry = Geometry::from(polyline(&[(0.0, 0.0), (1.0, 1.0)]));
        assert_eq!(geometry.coordinate_count(), 2);
        assert!(geometry.intersects_bounding_box(&bbox(-1.0, -1.0, 2.0, 2.0)));
    }
}
