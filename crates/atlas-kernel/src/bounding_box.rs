//! Axis-aligned geographic bounding boxes.

use std::fmt;

use crate::coordinate::{CoordinateError, GeoCoordinate};

/// Everything that can go wrong while constructing a [`BoundingBox`].
#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
pub enum BoundingBoxError {
    /// A component coordinate was invalid.
    #[error(transparent)]
    Coordinate(#[from] CoordinateError),
    /// `west` was east of `east`.
    ///
    /// Atlas does not support boxes that wrap across the antimeridian in this
    /// milestone, so such a request is rejected rather than silently treated as
    /// an ordinary box.
    #[error(
        "west ({west}) must not be greater than east ({east}); antimeridian-crossing boxes are not supported"
    )]
    WestGreaterThanEast {
        /// The western edge that was supplied.
        west: f64,
        /// The eastern edge that was supplied.
        east: f64,
    },
    /// `south` was north of `north`.
    #[error("south ({south}) must not be greater than north ({north})")]
    SouthGreaterThanNorth {
        /// The southern edge that was supplied.
        south: f64,
        /// The northern edge that was supplied.
        north: f64,
    },
    /// A bounding box was requested for an empty set of coordinates.
    #[error("a bounding box needs at least one coordinate")]
    NoCoordinates,
}

/// An inclusive, axis-aligned bounding box in WGS84 degrees.
///
/// Boxes are compared on a flat longitude/latitude plane. That is accurate
/// enough for viewport queries at the scales Atlas serves today and keeps the
/// kernel free of projection machinery.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    southwest: GeoCoordinate,
    northeast: GeoCoordinate,
}

impl BoundingBox {
    /// Builds a box from its south-west and north-east corners.
    pub fn new(
        southwest: GeoCoordinate,
        northeast: GeoCoordinate,
    ) -> Result<Self, BoundingBoxError> {
        let west = southwest.longitude_degrees();
        let east = northeast.longitude_degrees();
        if west > east {
            return Err(BoundingBoxError::WestGreaterThanEast { west, east });
        }
        let south = southwest.latitude_degrees();
        let north = northeast.latitude_degrees();
        if south > north {
            return Err(BoundingBoxError::SouthGreaterThanNorth { south, north });
        }
        Ok(Self {
            southwest,
            northeast,
        })
    }

    /// Builds a box from raw degrees in `west, south, east, north` order.
    pub fn from_degrees(
        west: f64,
        south: f64,
        east: f64,
        north: f64,
    ) -> Result<Self, BoundingBoxError> {
        Self::new(
            GeoCoordinate::from_degrees(west, south)?,
            GeoCoordinate::from_degrees(east, north)?,
        )
    }

    /// Builds the smallest box covering every supplied coordinate.
    pub fn from_coordinates(coordinates: &[GeoCoordinate]) -> Result<Self, BoundingBoxError> {
        let mut iterator = coordinates.iter();
        let first = iterator.next().ok_or(BoundingBoxError::NoCoordinates)?;
        let mut west = first.longitude_degrees();
        let mut east = west;
        let mut south = first.latitude_degrees();
        let mut north = south;
        for coordinate in iterator {
            west = west.min(coordinate.longitude_degrees());
            east = east.max(coordinate.longitude_degrees());
            south = south.min(coordinate.latitude_degrees());
            north = north.max(coordinate.latitude_degrees());
        }
        Self::from_degrees(west, south, east, north)
    }

    /// The south-west corner.
    pub fn southwest(&self) -> GeoCoordinate {
        self.southwest
    }

    /// The north-east corner.
    pub fn northeast(&self) -> GeoCoordinate {
        self.northeast
    }

    /// The western edge in degrees.
    pub fn west(&self) -> f64 {
        self.southwest.longitude_degrees()
    }

    /// The southern edge in degrees.
    pub fn south(&self) -> f64 {
        self.southwest.latitude_degrees()
    }

    /// The eastern edge in degrees.
    pub fn east(&self) -> f64 {
        self.northeast.longitude_degrees()
    }

    /// The northern edge in degrees.
    pub fn north(&self) -> f64 {
        self.northeast.latitude_degrees()
    }

    /// Whether the coordinate lies inside the box. Edges count as inside.
    pub fn contains(&self, coordinate: &GeoCoordinate) -> bool {
        let longitude = coordinate.longitude_degrees();
        let latitude = coordinate.latitude_degrees();
        longitude >= self.west()
            && longitude <= self.east()
            && latitude >= self.south()
            && latitude <= self.north()
    }

    /// Whether the two boxes share at least one point. Touching edges count.
    pub fn intersects(&self, other: &BoundingBox) -> bool {
        self.west() <= other.east()
            && other.west() <= self.east()
            && self.south() <= other.north()
            && other.south() <= self.north()
    }

    /// The smallest box covering both inputs.
    ///
    /// Both inputs are already valid and neither crosses the antimeridian, so
    /// the union is built by picking existing edges rather than by revalidating
    /// freshly computed numbers.
    pub fn union(&self, other: &BoundingBox) -> BoundingBox {
        let west = if self.west() <= other.west() {
            self.southwest.longitude()
        } else {
            other.southwest.longitude()
        };
        let south = if self.south() <= other.south() {
            self.southwest.latitude()
        } else {
            other.southwest.latitude()
        };
        let east = if self.east() >= other.east() {
            self.northeast.longitude()
        } else {
            other.northeast.longitude()
        };
        let north = if self.north() >= other.north() {
            self.northeast.latitude()
        } else {
            other.northeast.latitude()
        };
        BoundingBox {
            southwest: GeoCoordinate::new(west, south),
            northeast: GeoCoordinate::new(east, north),
        }
    }
}

impl fmt::Display for BoundingBox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "[{}, {}, {}, {}]",
            self.west(),
            self.south(),
            self.east(),
            self.north()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinate(longitude: f64, latitude: f64) -> GeoCoordinate {
        GeoCoordinate::from_degrees(longitude, latitude).expect("valid test coordinate")
    }

    fn bbox(west: f64, south: f64, east: f64, north: f64) -> BoundingBox {
        BoundingBox::from_degrees(west, south, east, north).expect("valid test bounding box")
    }

    #[test]
    fn builds_from_valid_corners() {
        let box_ = bbox(51.38, 35.68, 51.40, 35.70);
        assert_eq!(box_.west(), 51.38);
        assert_eq!(box_.south(), 35.68);
        assert_eq!(box_.east(), 51.40);
        assert_eq!(box_.north(), 35.70);
    }

    #[test]
    fn allows_degenerate_boxes() {
        let box_ = bbox(51.38, 35.68, 51.38, 35.68);
        assert!(box_.contains(&coordinate(51.38, 35.68)));
    }

    #[test]
    fn rejects_west_greater_than_east() {
        assert_eq!(
            BoundingBox::from_degrees(51.40, 35.68, 51.38, 35.70),
            Err(BoundingBoxError::WestGreaterThanEast {
                west: 51.40,
                east: 51.38
            })
        );
    }

    #[test]
    fn rejects_south_greater_than_north() {
        assert_eq!(
            BoundingBox::from_degrees(51.38, 35.70, 51.40, 35.68),
            Err(BoundingBoxError::SouthGreaterThanNorth {
                south: 35.70,
                north: 35.68
            })
        );
    }

    #[test]
    fn rejects_invalid_component_coordinates() {
        assert!(matches!(
            BoundingBox::from_degrees(-181.0, 0.0, 10.0, 10.0),
            Err(BoundingBoxError::Coordinate(_))
        ));
        assert!(matches!(
            BoundingBox::from_degrees(0.0, f64::NAN, 10.0, 10.0),
            Err(BoundingBoxError::Coordinate(_))
        ));
    }

    #[test]
    fn antimeridian_crossing_box_fails_clearly() {
        // 170E .. -170E would wrap the antimeridian; Atlas rejects it instead
        // of quietly producing a box that spans almost the whole globe.
        assert!(matches!(
            BoundingBox::from_degrees(170.0, -10.0, -170.0, 10.0),
            Err(BoundingBoxError::WestGreaterThanEast { .. })
        ));
    }

    #[test]
    fn contains_treats_edges_as_inside() {
        let box_ = bbox(0.0, 0.0, 10.0, 10.0);
        assert!(box_.contains(&coordinate(0.0, 0.0)));
        assert!(box_.contains(&coordinate(10.0, 10.0)));
        assert!(box_.contains(&coordinate(0.0, 5.0)));
        assert!(box_.contains(&coordinate(5.0, 10.0)));
        assert!(!box_.contains(&coordinate(10.000_1, 5.0)));
        assert!(!box_.contains(&coordinate(-0.000_1, 5.0)));
    }

    #[test]
    fn intersects_treats_touching_as_intersecting() {
        let box_ = bbox(0.0, 0.0, 10.0, 10.0);
        assert!(box_.intersects(&bbox(10.0, 10.0, 20.0, 20.0)));
        assert!(box_.intersects(&bbox(5.0, 5.0, 6.0, 6.0)));
        assert!(box_.intersects(&bbox(-5.0, -5.0, 15.0, 15.0)));
        assert!(!box_.intersects(&bbox(10.000_1, 0.0, 20.0, 10.0)));
        assert!(!box_.intersects(&bbox(0.0, 10.000_1, 10.0, 20.0)));
    }

    #[test]
    fn union_covers_both_inputs() {
        let union = bbox(0.0, 0.0, 10.0, 10.0).union(&bbox(5.0, -5.0, 20.0, 6.0));
        assert_eq!(union.west(), 0.0);
        assert_eq!(union.south(), -5.0);
        assert_eq!(union.east(), 20.0);
        assert_eq!(union.north(), 10.0);
    }

    #[test]
    fn from_coordinates_requires_at_least_one_point() {
        assert_eq!(
            BoundingBox::from_coordinates(&[]),
            Err(BoundingBoxError::NoCoordinates)
        );
    }

    #[test]
    fn from_coordinates_covers_every_point() {
        let box_ = BoundingBox::from_coordinates(&[
            coordinate(51.39, 35.69),
            coordinate(51.38, 35.70),
            coordinate(51.40, 35.68),
        ])
        .expect("valid bounds");
        assert_eq!(box_.west(), 51.38);
        assert_eq!(box_.south(), 35.68);
        assert_eq!(box_.east(), 51.40);
        assert_eq!(box_.north(), 35.70);
    }
}
