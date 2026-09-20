//! Query parameter parsing and validation for the map feature endpoint.
//!
//! Everything a client can send is validated here, before any domain type is
//! constructed, so handlers only ever see well-formed requests.

use std::collections::HashMap;

use atlas_engine::{
    DEFAULT_FEATURE_LIMIT, FeatureFilter, FeatureKindFilter, MAX_FEATURE_LIMIT, MapFeatureQuery,
    QueryError,
};
use atlas_kernel::{BoundingBox, BoundingBoxError};

use crate::error::{ApiError, RequestContext};

const SUPPORTED_PARAMETERS: [&str; 5] = ["bbox", "kind", "limit", "include", "dataset"];
const SUPPORTED_KINDS: [&str; 1] = ["road"];
const SUPPORTED_INCLUDES: [&str; 2] = ["diagnostics", "source"];

/// Which optional blocks the client asked to have included.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IncludeSet {
    /// Include each feature's source reference.
    pub source: bool,
    /// Include the query diagnostics block.
    pub diagnostics: bool,
}

/// A fully validated feature request.
#[derive(Debug, Clone)]
pub struct FeatureRequest {
    /// The validated domain query.
    pub query: MapFeatureQuery,
    /// The optional blocks to include in the response.
    pub include: IncludeSet,
    /// A specific dataset the client insists on, when it pinned one.
    pub dataset: Option<String>,
}

/// Parses and validates the raw query string parameters.
pub fn parse_feature_request(
    raw: &HashMap<String, String>,
    context: &RequestContext,
) -> Result<FeatureRequest, ApiError> {
    reject_unknown_parameters(raw, context)?;

    let bbox = parse_bbox(raw.get("bbox").map(String::as_str), context)?;
    let filter = parse_kind_filter(raw.get("kind").map(String::as_str), context)?;
    let limit = parse_limit(raw.get("limit").map(String::as_str), context)?;
    let include = parse_include(raw.get("include").map(String::as_str), context)?;

    let query = MapFeatureQuery::new(bbox, filter, limit).map_err(|error| match error {
        QueryError::LimitTooSmall => context
            .invalid_query("limit must be at least 1")
            .with_detail("parameter", "limit"),
        QueryError::LimitTooLarge { requested, maximum } => context
            .invalid_query(format!("limit must not exceed {maximum}"))
            .with_detail("parameter", "limit")
            .with_detail("requested", requested as u64)
            .with_detail("maximum", maximum as u64),
    })?;

    Ok(FeatureRequest {
        query,
        include,
        dataset: raw.get("dataset").map(String::to_owned),
    })
}

fn reject_unknown_parameters(
    raw: &HashMap<String, String>,
    context: &RequestContext,
) -> Result<(), ApiError> {
    let mut unknown: Vec<&str> = raw
        .keys()
        .map(String::as_str)
        .filter(|name| !SUPPORTED_PARAMETERS.contains(name))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    unknown.sort_unstable();
    Err(context
        .invalid_query(format!("unsupported query parameter `{}`", unknown[0]))
        .with_detail("unsupported", unknown.join(","))
        .with_detail("supported", SUPPORTED_PARAMETERS.join(",")))
}

fn parse_bbox(raw: Option<&str>, context: &RequestContext) -> Result<BoundingBox, ApiError> {
    let Some(raw) = raw else {
        return Err(context
            .invalid_query("bbox is required, as `west,south,east,north`")
            .with_detail("parameter", "bbox"));
    };

    let parts: Vec<&str> = raw.split(',').map(str::trim).collect();
    if parts.len() != 4 {
        return Err(context
            .invalid_query("bbox must have exactly 4 comma-separated values: west,south,east,north")
            .with_detail("parameter", "bbox")
            .with_detail("received", parts.len() as u64));
    }

    let mut values = [0.0_f64; 4];
    for (index, part) in parts.iter().enumerate() {
        let parsed = part
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                context
                    .invalid_query("bbox values must be finite numbers")
                    .with_detail("parameter", "bbox")
                    .with_detail("position", index as u64)
            })?;
        values[index] = parsed;
    }

    BoundingBox::from_degrees(values[0], values[1], values[2], values[3]).map_err(|error| {
        let message = match error {
            BoundingBoxError::WestGreaterThanEast { .. } => {
                "west must not be greater than east".to_owned()
            }
            BoundingBoxError::SouthGreaterThanNorth { .. } => {
                "south must not be greater than north".to_owned()
            }
            BoundingBoxError::Coordinate(_) => {
                "bbox coordinates must be within [-180, 180] longitude and [-90, 90] latitude"
                    .to_owned()
            }
            BoundingBoxError::NoCoordinates => "bbox is empty".to_owned(),
        };
        context
            .invalid_bounding_box(message)
            .with_detail("parameter", "bbox")
    })
}

fn parse_kind_filter(
    raw: Option<&str>,
    context: &RequestContext,
) -> Result<FeatureFilter, ApiError> {
    let Some(raw) = raw else {
        return Ok(FeatureFilter::any_kind());
    };
    let mut kinds = Vec::new();
    for value in raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let kind = FeatureKindFilter::parse(value).ok_or_else(|| {
            context
                .invalid_query(format!("unsupported kind `{value}`"))
                .with_detail("parameter", "kind")
                .with_detail("supported", SUPPORTED_KINDS.join(","))
        })?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        return Ok(FeatureFilter::any_kind());
    }
    Ok(FeatureFilter::with_kinds(kinds))
}

fn parse_limit(raw: Option<&str>, context: &RequestContext) -> Result<usize, ApiError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_FEATURE_LIMIT);
    };
    raw.trim().parse::<usize>().map_err(|_| {
        context
            .invalid_query(format!(
                "limit must be a whole number between 1 and {MAX_FEATURE_LIMIT}"
            ))
            .with_detail("parameter", "limit")
    })
}

fn parse_include(raw: Option<&str>, context: &RequestContext) -> Result<IncludeSet, ApiError> {
    let Some(raw) = raw else {
        return Ok(IncludeSet::default());
    };
    let mut include = IncludeSet::default();
    for value in raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match value {
            "source" => include.source = true,
            "diagnostics" => include.diagnostics = true,
            other => {
                return Err(context
                    .invalid_query(format!("unsupported include `{other}`"))
                    .with_detail("parameter", "include")
                    .with_detail("supported", SUPPORTED_INCLUDES.join(",")));
            }
        }
    }
    Ok(include)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ApiErrorCode;
    use crate::state::AppState;
    use atlas_engine::DatasetRegistry;
    use std::sync::Arc;

    fn context() -> RequestContext {
        RequestContext::new(&AppState::new(Arc::new(DatasetRegistry::new())))
    }

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn parse(pairs: &[(&str, &str)]) -> Result<FeatureRequest, ApiError> {
        parse_feature_request(&params(pairs), &context())
    }

    #[test]
    fn parses_a_complete_request() {
        let request = parse(&[
            ("bbox", "51.380,35.680,51.400,35.700"),
            ("kind", "road"),
            ("limit", "250"),
            ("include", "source,diagnostics"),
        ])
        .expect("request is valid");
        assert_eq!(request.query.bbox().west(), 51.380);
        assert_eq!(request.query.bbox().south(), 35.680);
        assert_eq!(request.query.bbox().east(), 51.400);
        assert_eq!(request.query.bbox().north(), 35.700);
        assert_eq!(request.query.limit(), 250);
        assert_eq!(request.query.filter().kinds(), &[FeatureKindFilter::Road]);
        assert_eq!(
            request.include,
            IncludeSet {
                source: true,
                diagnostics: true
            }
        );
    }

    #[test]
    fn defaults_are_applied_when_optional_parameters_are_missing() {
        let request = parse(&[("bbox", "0,0,1,1")]).expect("request is valid");
        assert_eq!(request.query.limit(), DEFAULT_FEATURE_LIMIT);
        assert!(request.query.filter().is_unrestricted());
        assert_eq!(request.include, IncludeSet::default());
        assert_eq!(request.dataset, None);
    }

    #[test]
    fn bbox_is_required() {
        let error = parse(&[]).expect_err("bbox is mandatory");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn bbox_arity_is_validated() {
        let error = parse(&[("bbox", "0,0,1")]).expect_err("three values is not a bbox");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn bbox_values_must_be_finite_numbers() {
        for value in ["0,0,1,abc", "0,0,1,NaN", "0,0,1,inf"] {
            let error = parse(&[("bbox", value)]).expect_err("non-numeric bbox must fail");
            assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
        }
    }

    #[test]
    fn bbox_ordering_is_validated() {
        let error = parse(&[("bbox", "51.4,35.68,51.38,35.70")]).expect_err("west beyond east");
        assert_eq!(error.code(), ApiErrorCode::InvalidBoundingBox);

        let error = parse(&[("bbox", "51.38,35.70,51.40,35.68")]).expect_err("south beyond north");
        assert_eq!(error.code(), ApiErrorCode::InvalidBoundingBox);
    }

    #[test]
    fn bbox_coordinate_ranges_are_validated() {
        let error = parse(&[("bbox", "-181,0,10,10")]).expect_err("longitude out of range");
        assert_eq!(error.code(), ApiErrorCode::InvalidBoundingBox);

        let error = parse(&[("bbox", "0,-91,10,10")]).expect_err("latitude out of range");
        assert_eq!(error.code(), ApiErrorCode::InvalidBoundingBox);
    }

    #[test]
    fn unknown_kinds_are_rejected() {
        let error = parse(&[("bbox", "0,0,1,1"), ("kind", "building")]).expect_err("unknown kind");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn repeated_kinds_are_deduplicated() {
        let request =
            parse(&[("bbox", "0,0,1,1"), ("kind", "road,road")]).expect("request is valid");
        assert_eq!(request.query.filter().kinds(), &[FeatureKindFilter::Road]);
    }

    #[test]
    fn limit_must_be_a_number_in_range() {
        for value in ["abc", "-1", "0"] {
            let error = parse(&[("bbox", "0,0,1,1"), ("limit", value)]).expect_err("bad limit");
            assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
        }
        let error = parse(&[
            ("bbox", "0,0,1,1"),
            ("limit", &(MAX_FEATURE_LIMIT + 1).to_string()),
        ])
        .expect_err("limit above the server maximum");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn the_server_maximum_limit_is_accepted() {
        let request = parse(&[
            ("bbox", "0,0,1,1"),
            ("limit", &MAX_FEATURE_LIMIT.to_string()),
        ])
        .expect("the maximum itself is allowed");
        assert_eq!(request.query.limit(), MAX_FEATURE_LIMIT);
    }

    #[test]
    fn unknown_includes_are_rejected() {
        let error =
            parse(&[("bbox", "0,0,1,1"), ("include", "everything")]).expect_err("unknown include");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn unknown_parameters_are_rejected() {
        let error = parse(&[("bbox", "0,0,1,1"), ("zoom", "12")]).expect_err("unknown parameter");
        assert_eq!(error.code(), ApiErrorCode::InvalidQuery);
    }

    #[test]
    fn a_pinned_dataset_is_carried_through() {
        let request = parse(&[("bbox", "0,0,1,1"), ("dataset", "ds-1")]).expect("request is valid");
        assert_eq!(request.dataset.as_deref(), Some("ds-1"));
    }
}
