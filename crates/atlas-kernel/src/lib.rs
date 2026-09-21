#![forbid(unsafe_code)]

//! The Atlas domain kernel.
//!
//! This crate owns the geospatial vocabulary that the rest of Atlas is written
//! against. It deliberately knows nothing about OpenStreetMap, HTTP, JSON,
//! databases, async runtimes or map renderers: those all live in adapters that
//! depend on the kernel, never the other way around.
//!
//! Everything here is validated on construction and immutable afterwards, so a
//! value that exists is a value that is already known to be well formed.

mod access;
mod bounding_box;
mod coordinate;
mod feature;
mod geometry;
mod speed;
mod topology;
mod traversal;

pub use access::{AccessRule, RoadAccess};
pub use bounding_box::{BoundingBox, BoundingBoxError};
pub use coordinate::{CoordinateError, GeoCoordinate, Latitude, Longitude};
pub use feature::{FeatureError, FeatureId, FeatureKind, MapFeature, RoadClass, SourceReference};
pub use geometry::{Geometry, GeometryError, LineString};
pub use speed::{
    ConditionalSpeedLimit, DirectionalSpeedLimits, ImplicitSpeedCode, RoadSpeedLimits, Speed,
    SpeedDirection, SpeedError, SpeedLimitFact, SpeedLimitValue, SpeedUnit, VariableSpeedLimit,
};
pub use topology::{RoadNode, RoadNodeId, RoadSegment, RoadSegmentId, TopologyError};
pub use traversal::{RoadTraversal, TravelDirection, TravelMode};
