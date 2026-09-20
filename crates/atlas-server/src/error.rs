//! Structured API errors.
//!
//! Errors are plain JSON, never GeoJSON, and never carry stack traces, file
//! system paths or parser internals: those belong in the server's logs.

use std::collections::BTreeMap;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::state::AppState;

/// The stable error codes the API can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiErrorCode {
    /// A query parameter was missing, malformed or unsupported.
    InvalidQuery,
    /// The bounding box itself was not usable.
    InvalidBoundingBox,
    /// A specific dataset was requested and does not exist.
    DatasetNotFound,
    /// No dataset is published, so queries cannot be served yet.
    DatasetNotReady,
    /// Something went wrong inside Atlas.
    InternalError,
}

impl ApiErrorCode {
    /// The stable wire form of the code.
    pub fn as_str(self) -> &'static str {
        match self {
            ApiErrorCode::InvalidQuery => "INVALID_QUERY",
            ApiErrorCode::InvalidBoundingBox => "INVALID_BOUNDING_BOX",
            ApiErrorCode::DatasetNotFound => "DATASET_NOT_FOUND",
            ApiErrorCode::DatasetNotReady => "DATASET_NOT_READY",
            ApiErrorCode::InternalError => "INTERNAL_ERROR",
        }
    }

    /// The HTTP status the code maps to.
    pub fn status(self) -> StatusCode {
        match self {
            ApiErrorCode::InvalidQuery | ApiErrorCode::InvalidBoundingBox => {
                StatusCode::BAD_REQUEST
            }
            ApiErrorCode::DatasetNotFound => StatusCode::NOT_FOUND,
            ApiErrorCode::DatasetNotReady => StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// An error ready to be serialised as the API's error envelope.
#[derive(Debug, Clone)]
pub struct ApiError {
    code: ApiErrorCode,
    message: String,
    request_id: String,
    details: BTreeMap<String, serde_json::Value>,
}

impl ApiError {
    /// Attaches one detail field to the error.
    #[must_use]
    pub fn with_detail(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }

    /// The error code.
    pub fn code(&self) -> ApiErrorCode {
        self.code
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    request_id: &'a str,
    details: &'a BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.code.status();
        let body = Json(ErrorEnvelope {
            error: ErrorBody {
                code: self.code.as_str(),
                message: &self.message,
                request_id: &self.request_id,
                details: &self.details,
            },
        });
        (status, body).into_response()
    }
}

/// Per-request context, currently just the identifier echoed back to clients.
#[derive(Debug, Clone)]
pub struct RequestContext {
    request_id: String,
}

impl RequestContext {
    /// Starts a request context, allocating a fresh request identifier.
    pub fn new(state: &AppState) -> Self {
        Self {
            request_id: state.next_request_id(),
        }
    }

    /// The identifier echoed in error responses and log lines.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Builds an error carrying this request's identifier.
    pub fn error(&self, code: ApiErrorCode, message: impl Into<String>) -> ApiError {
        ApiError {
            code,
            message: message.into(),
            request_id: self.request_id.clone(),
            details: BTreeMap::new(),
        }
    }

    /// Shorthand for [`ApiErrorCode::InvalidQuery`].
    pub fn invalid_query(&self, message: impl Into<String>) -> ApiError {
        self.error(ApiErrorCode::InvalidQuery, message)
    }

    /// Shorthand for [`ApiErrorCode::InvalidBoundingBox`].
    pub fn invalid_bounding_box(&self, message: impl Into<String>) -> ApiError {
        self.error(ApiErrorCode::InvalidBoundingBox, message)
    }

    /// Shorthand for [`ApiErrorCode::DatasetNotFound`].
    pub fn dataset_not_found(&self, message: impl Into<String>) -> ApiError {
        self.error(ApiErrorCode::DatasetNotFound, message)
    }

    /// Shorthand for [`ApiErrorCode::DatasetNotReady`].
    pub fn dataset_not_ready(&self, message: impl Into<String>) -> ApiError {
        self.error(ApiErrorCode::DatasetNotReady, message)
    }

    /// Shorthand for [`ApiErrorCode::InternalError`].
    pub fn internal_error(&self, message: impl Into<String>) -> ApiError {
        self.error(ApiErrorCode::InternalError, message)
    }
}
