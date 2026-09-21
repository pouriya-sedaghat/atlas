#![forbid(unsafe_code)]

//! The OpenStreetMap XML input adapter.
//!
//! OSM is an input format, not the Atlas domain model. Everything in this crate
//! exists to turn a plain `.osm` XML file into [`atlas_kernel::MapFeature`]
//! values and an [`atlas_engine::SourceImportOutcome`]; the raw OSM types never
//! escape the crate.
//!
//! Only plain XML is supported. `.osm.pbf`, compressed files and network
//! downloads are deliberately out of scope for this milestone.

mod access;
mod direction;
mod model;
mod source;
mod speed;

pub use source::{OSM_ATTRIBUTION_TEXT, OSM_LICENSE_URL, OsmXmlSource};
