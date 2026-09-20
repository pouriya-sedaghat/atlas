//! Validated geographic coordinate values.

use std::fmt;

/// Everything that can go wrong while constructing a coordinate component.
#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
pub enum CoordinateError {
    /// The longitude was `NaN` or infinite.
    #[error("longitude must be a finite number")]
    LongitudeNotFinite,
    /// The longitude was finite but outside the inclusive WGS84 range.
    #[error("longitude {degrees} is outside the inclusive range [-180, 180]")]
    LongitudeOutOfRange {
        /// The rejected value.
        degrees: f64,
    },
    /// The latitude was `NaN` or infinite.
    #[error("latitude must be a finite number")]
    LatitudeNotFinite,
    /// The latitude was finite but outside the inclusive WGS84 range.
    #[error("latitude {degrees} is outside the inclusive range [-90, 90]")]
    LatitudeOutOfRange {
        /// The rejected value.
        degrees: f64,
    },
}

/// A WGS84 longitude in degrees, guaranteed finite and within `[-180, 180]`.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct Longitude(f64);

impl Longitude {
    /// The smallest accepted longitude.
    pub const MIN_DEGREES: f64 = -180.0;
    /// The largest accepted longitude.
    pub const MAX_DEGREES: f64 = 180.0;

    /// Builds a longitude, rejecting non-finite and out-of-range values.
    pub fn new(degrees: f64) -> Result<Self, CoordinateError> {
        if !degrees.is_finite() {
            return Err(CoordinateError::LongitudeNotFinite);
        }
        if !(Self::MIN_DEGREES..=Self::MAX_DEGREES).contains(&degrees) {
            return Err(CoordinateError::LongitudeOutOfRange { degrees });
        }
        Ok(Self(degrees))
    }

    /// The longitude in degrees.
    pub fn degrees(self) -> f64 {
        self.0
    }
}

impl fmt::Display for Longitude {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// A WGS84 latitude in degrees, guaranteed finite and within `[-90, 90]`.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct Latitude(f64);

impl Latitude {
    /// The smallest accepted latitude.
    pub const MIN_DEGREES: f64 = -90.0;
    /// The largest accepted latitude.
    pub const MAX_DEGREES: f64 = 90.0;

    /// Builds a latitude, rejecting non-finite and out-of-range values.
    pub fn new(degrees: f64) -> Result<Self, CoordinateError> {
        if !degrees.is_finite() {
            return Err(CoordinateError::LatitudeNotFinite);
        }
        if !(Self::MIN_DEGREES..=Self::MAX_DEGREES).contains(&degrees) {
            return Err(CoordinateError::LatitudeOutOfRange { degrees });
        }
        Ok(Self(degrees))
    }

    /// The latitude in degrees.
    pub fn degrees(self) -> f64 {
        self.0
    }
}

impl fmt::Display for Latitude {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// A point on the globe.
///
/// The argument order is always `longitude, latitude` (x, y), matching GeoJSON,
/// and the components keep their own types so that they cannot be swapped by
/// accident the way an anonymous `(f64, f64)` tuple can.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoCoordinate {
    longitude: Longitude,
    latitude: Latitude,
}

impl GeoCoordinate {
    /// Builds a coordinate from already validated components.
    pub fn new(longitude: Longitude, latitude: Latitude) -> Self {
        Self {
            longitude,
            latitude,
        }
    }

    /// Builds a coordinate from raw degrees, validating both components.
    pub fn from_degrees(longitude: f64, latitude: f64) -> Result<Self, CoordinateError> {
        Ok(Self::new(
            Longitude::new(longitude)?,
            Latitude::new(latitude)?,
        ))
    }

    /// The longitude component.
    pub fn longitude(self) -> Longitude {
        self.longitude
    }

    /// The latitude component.
    pub fn latitude(self) -> Latitude {
        self.latitude
    }

    /// The longitude in degrees.
    pub fn longitude_degrees(self) -> f64 {
        self.longitude.degrees()
    }

    /// The latitude in degrees.
    pub fn latitude_degrees(self) -> f64 {
        self.latitude.degrees()
    }
}

impl fmt::Display for GeoCoordinate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "({}, {})", self.longitude, self.latitude)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_longitudes() {
        for degrees in [-180.0, -0.0, 0.0, 51.389, 180.0] {
            let longitude = Longitude::new(degrees).expect("longitude should be accepted");
            assert_eq!(longitude.degrees(), degrees);
        }
    }

    #[test]
    fn rejects_out_of_range_longitude() {
        assert_eq!(
            Longitude::new(180.000_1),
            Err(CoordinateError::LongitudeOutOfRange { degrees: 180.000_1 })
        );
        assert_eq!(
            Longitude::new(-180.000_1),
            Err(CoordinateError::LongitudeOutOfRange {
                degrees: -180.000_1
            })
        );
    }

    #[test]
    fn rejects_non_finite_longitude() {
        assert_eq!(
            Longitude::new(f64::NAN),
            Err(CoordinateError::LongitudeNotFinite)
        );
        assert_eq!(
            Longitude::new(f64::INFINITY),
            Err(CoordinateError::LongitudeNotFinite)
        );
        assert_eq!(
            Longitude::new(f64::NEG_INFINITY),
            Err(CoordinateError::LongitudeNotFinite)
        );
    }

    #[test]
    fn accepts_valid_latitudes() {
        for degrees in [-90.0, 0.0, 35.689, 90.0] {
            let latitude = Latitude::new(degrees).expect("latitude should be accepted");
            assert_eq!(latitude.degrees(), degrees);
        }
    }

    #[test]
    fn rejects_out_of_range_latitude() {
        assert_eq!(
            Latitude::new(90.5),
            Err(CoordinateError::LatitudeOutOfRange { degrees: 90.5 })
        );
        assert_eq!(
            Latitude::new(-95.0),
            Err(CoordinateError::LatitudeOutOfRange { degrees: -95.0 })
        );
    }

    #[test]
    fn rejects_non_finite_latitude() {
        assert_eq!(
            Latitude::new(f64::NAN),
            Err(CoordinateError::LatitudeNotFinite)
        );
        assert_eq!(
            Latitude::new(f64::INFINITY),
            Err(CoordinateError::LatitudeNotFinite)
        );
    }

    #[test]
    fn coordinate_keeps_longitude_latitude_order() {
        let coordinate =
            GeoCoordinate::from_degrees(51.389, 35.689).expect("coordinate should be accepted");
        assert_eq!(coordinate.longitude_degrees(), 51.389);
        assert_eq!(coordinate.latitude_degrees(), 35.689);
    }

    #[test]
    fn coordinate_rejects_swapped_arguments_that_leave_valid_ranges() {
        // 100 is a valid longitude but not a valid latitude, so passing the
        // components the wrong way round fails loudly instead of silently.
        assert!(GeoCoordinate::from_degrees(35.689, 100.0).is_err());
    }
}
