//! Viewport road-topology queries.

use std::collections::HashMap;

use atlas_engine::TopologyQuery;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::dto::{JSON_CONTENT_TYPE, TopologyCollectionV1};
use crate::error::{ApiError, RequestContext};
use crate::params::parse_topology_request;
use crate::state::SharedState;

/// `GET /api/v1/map/topology`
///
/// Returns plain JSON. The payload is a graph — nodes with their degree in the
/// whole dataset, and undirected segments referencing the road they came from
/// — not a GeoJSON `FeatureCollection`, and the media type says so.
///
/// This endpoint is purely additive. `/api/v1/map/features` is untouched, its
/// payload is byte-for-byte what it was, and the API version is still `1`: a
/// client that has never heard of topology cannot tell that this route exists.
pub async fn query(
    State(state): State<SharedState>,
    Query(raw): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let context = RequestContext::new(&state);
    let request = parse_topology_request(&raw, &context)?;

    let registry = state.registry();
    let Some(snapshot) = registry.snapshot() else {
        let status = registry.status();
        return Err(context
            .dataset_not_ready("no dataset is published yet")
            .with_detail("datasetStatus", status.as_str()));
    };

    // A client may pin the dataset it started rendering, so that it notices a
    // swap instead of drawing one import's topology over another's roads.
    if let Some(requested) = request.dataset.as_deref()
        && requested != snapshot.id().as_str()
    {
        return Err(context
            .dataset_not_found(format!("dataset `{requested}` is not the active dataset"))
            .with_detail("requested", requested.to_owned())
            .with_detail("active", snapshot.id().as_str().to_owned()));
    }

    let result = snapshot.query_topology(&request.query);
    let collection =
        TopologyCollectionV1::from_result(&result, request.query.bbox(), request.diagnostics);

    let body = serde_json::to_vec(&collection).map_err(|error| {
        tracing::error!(
            request_id = context.request_id(),
            %error,
            "failed to serialise the topology collection"
        );
        context.internal_error("the response could not be serialised")
    })?;

    Ok(([(header::CONTENT_TYPE, JSON_CONTENT_TYPE)], body).into_response())
}
