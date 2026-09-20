#![forbid(unsafe_code)]

//! The Atlas HTTP boundary.
//!
//! This crate is the only place in Atlas that knows about HTTP, JSON and
//! GeoJSON. Domain and application types never appear on the wire directly:
//! every response goes through an explicit, versioned DTO in [`dto`] so that
//! refactoring a domain struct cannot silently change the public API.

pub mod dto;
pub mod error;
pub mod import;
pub mod params;
pub mod routes;
pub mod state;

use axum::Router;
use axum::routing::get;
use tower_http::trace::TraceLayer;

pub use state::{AppState, SharedState};

/// Builds the Atlas HTTP router.
pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/health/live", get(routes::health::live))
        .route("/health/ready", get(routes::health::ready))
        .route("/api/v1/datasets/current", get(routes::datasets::current))
        .route("/api/v1/map/features", get(routes::features::query))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
