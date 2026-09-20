//! Liveness and readiness probes.
//!
//! Liveness says the process is up. Readiness says a dataset can actually be
//! queried, and says so honestly: a server whose import is still running, or
//! whose import failed, is live but not ready.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};

use crate::dto::HealthV1;
use crate::error::RequestContext;
use crate::state::SharedState;

/// `GET /health/live`
pub async fn live() -> Response {
    Json(HealthV1 {
        status: "live",
        dataset_id: None,
    })
    .into_response()
}

/// `GET /health/ready`
pub async fn ready(State(state): State<SharedState>) -> Response {
    let registry = state.registry();
    match registry.active_id() {
        Some(dataset_id) => Json(HealthV1 {
            status: "ready",
            dataset_id: Some(dataset_id.as_str().to_owned()),
        })
        .into_response(),
        None => {
            let context = RequestContext::new(&state);
            let status = registry.status();
            let mut error = context
                .dataset_not_ready("no dataset is published yet")
                .with_detail("datasetStatus", status.as_str());
            if let Some(failure) = registry.last_failure() {
                error = error
                    .with_detail("failureCategory", failure.category().to_owned())
                    .with_detail("failureMessage", failure.message().to_owned());
            }
            error.into_response()
        }
    }
}
