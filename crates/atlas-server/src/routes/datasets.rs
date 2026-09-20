//! Dataset metadata.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};

use crate::dto::CurrentDatasetV1;
use crate::state::SharedState;

/// `GET /api/v1/datasets/current`
///
/// Always answers with `200`, because "no dataset yet" and "the import failed"
/// are states Atlas Studio has to render, not transport errors. The `status`
/// field carries the truth.
pub async fn current(State(state): State<SharedState>) -> Response {
    let registry = state.registry();
    let status = registry.status();
    let failure = registry.last_failure();

    let payload = match registry.snapshot() {
        Some(snapshot) => {
            CurrentDatasetV1::from_dataset(snapshot.dataset(), status.as_str(), failure.as_ref())
        }
        None => CurrentDatasetV1::unavailable(status.as_str(), failure.as_ref()),
    };

    Json(payload).into_response()
}
