//! Viewport feature queries.

use std::collections::HashMap;

use atlas_engine::MapQuery;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::dto::{FeatureCollectionV1, GEOJSON_CONTENT_TYPE};
use crate::error::{ApiError, RequestContext};
use crate::params::parse_feature_request;
use crate::state::SharedState;

/// `GET /api/v1/map/features`
///
/// Returns GeoJSON. Errors, by contrast, are plain JSON: a client that failed
/// to send a usable bounding box is not helped by an empty feature collection.
pub async fn query(
    State(state): State<SharedState>,
    Query(raw): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let context = RequestContext::new(&state);
    let request = parse_feature_request(&raw, &context)?;

    let registry = state.registry();
    let Some(snapshot) = registry.snapshot() else {
        let status = registry.status();
        return Err(context
            .dataset_not_ready("no dataset is published yet")
            .with_detail("datasetStatus", status.as_str()));
    };

    // A client may pin the dataset it started rendering, so that it notices a
    // swap instead of silently mixing features from two imports.
    if let Some(requested) = request.dataset.as_deref()
        && requested != snapshot.id().as_str()
    {
        return Err(context
            .dataset_not_found(format!("dataset `{requested}` is not the active dataset"))
            .with_detail("requested", requested.to_owned())
            .with_detail("active", snapshot.id().as_str().to_owned()));
    }

    let result = snapshot.query_features(&request.query);
    let collection = FeatureCollectionV1::from_result(
        &result,
        request.query.bbox(),
        request.include.source,
        request.include.diagnostics,
    );

    let body = serde_json::to_vec(&collection).map_err(|error| {
        tracing::error!(
            request_id = context.request_id(),
            %error,
            "failed to serialise the feature collection"
        );
        context.internal_error("the response could not be serialised")
    })?;

    Ok(([(header::CONTENT_TYPE, GEOJSON_CONTENT_TYPE)], body).into_response())
}
