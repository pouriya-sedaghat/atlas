//! Shared HTTP server state.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use atlas_engine::DatasetRegistry;

/// State shared by every request handler.
#[derive(Debug)]
pub struct AppState {
    registry: Arc<DatasetRegistry>,
    request_counter: AtomicU64,
}

impl AppState {
    /// Builds state around a dataset registry.
    pub fn new(registry: Arc<DatasetRegistry>) -> Self {
        Self {
            registry,
            request_counter: AtomicU64::new(0),
        }
    }

    /// The dataset registry this server serves from.
    pub fn registry(&self) -> &DatasetRegistry {
        &self.registry
    }

    /// Allocates a request identifier for correlating a response with a log line.
    pub fn next_request_id(&self) -> String {
        let sequence = self.request_counter.fetch_add(1, Ordering::Relaxed);
        format!("req-{sequence:08}")
    }
}

/// The reference-counted handle handlers receive.
pub type SharedState = Arc<AppState>;
