//! Contract tests for the Atlas HTTP API.
//!
//! These drive the real router in-process through `tower`'s `oneshot`, so they
//! exercise routing, extraction, validation and serialisation without opening a
//! socket or touching the network.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_engine::{DatasetRegistry, ImportFailure};
use atlas_server::{AppState, SharedState, import, router};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-basic.osm")
}

fn directionality_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/roads-directionality.osm")
}

fn access_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-access.osm")
}

fn state_for(path: PathBuf) -> SharedState {
    let registry = Arc::new(DatasetRegistry::new());
    let dataset = import::import_osm_file(&path).expect("the fixture must import");
    registry.publish(dataset);
    Arc::new(AppState::new(registry))
}

fn ready_state() -> SharedState {
    state_for(fixture_path())
}

/// A dataset built from the fixture that exercises every direction value.
fn directionality_state() -> SharedState {
    state_for(directionality_fixture_path())
}

/// A dataset built from the fixture that exercises the access rules.
fn access_state() -> SharedState {
    state_for(access_fixture_path())
}

/// A dataset built from an in-memory document, for cases no fixture covers.
///
/// The fixtures on disk are laid out to be read by a human in Studio, which is
/// a different job from exhausting a vocabulary. This builds a throwaway
/// dataset from XML written inline, so the contract can assert every wire
/// value without adding rows nobody would ever look at.
fn state_from_xml(xml: &str) -> SharedState {
    let source = atlas_osm::OsmXmlSource::from_xml("inline.osm", xml);
    let mut builder = atlas_engine::DatasetBuilder::new(
        atlas_engine::DatasetId::new("ds-inline"),
        atlas_engine::MapSource::source_metadata(&source),
    );
    let outcome =
        atlas_engine::MapSource::import(&source, &mut builder).expect("the document imports");
    let dataset = builder.finish(outcome).expect("it produces features");
    let registry = Arc::new(DatasetRegistry::new());
    registry.publish(dataset);
    Arc::new(AppState::new(registry))
}

fn loading_state() -> SharedState {
    Arc::new(AppState::new(Arc::new(DatasetRegistry::new())))
}

fn failed_state() -> SharedState {
    let registry = Arc::new(DatasetRegistry::new());
    registry.mark_failed(ImportFailure::new(
        "malformed-source",
        "The configured map source is malformed.",
    ));
    Arc::new(AppState::new(registry))
}

struct ApiResponse {
    status: StatusCode,
    content_type: String,
    body: Value,
}

async fn get(state: SharedState, uri: &str) -> ApiResponse {
    let response = router(state)
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("the router answers");

    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body is readable")
        .to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        panic!(
            "response body is not JSON ({error}): {}",
            String::from_utf8_lossy(&bytes)
        )
    });

    ApiResponse {
        status,
        content_type,
        body,
    }
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().expect("error code present")
}

const VIEWPORT: &str = "bbox=51.380,35.680,51.400,35.700";

// -- health ---------------------------------------------------------------

#[tokio::test]
async fn live_succeeds_even_without_a_dataset() {
    let response = get(loading_state(), "/health/live").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["status"], "live");
}

#[tokio::test]
async fn ready_succeeds_only_once_a_dataset_is_published() {
    let response = get(ready_state(), "/health/ready").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["status"], "ready");
    assert!(response.body["datasetId"].is_string());
}

#[tokio::test]
async fn ready_fails_while_the_import_is_still_running() {
    let response = get(loading_state(), "/health/ready").await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&response.body), "DATASET_NOT_READY");
    assert_eq!(
        response.body["error"]["details"]["datasetStatus"],
        "loading"
    );
}

#[tokio::test]
async fn ready_fails_honestly_after_a_failed_import() {
    let response = get(failed_state(), "/health/ready").await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&response.body), "DATASET_NOT_READY");
    assert_eq!(response.body["error"]["details"]["datasetStatus"], "failed");
    assert_eq!(
        response.body["error"]["details"]["failureCategory"],
        "malformed-source"
    );
}

// -- current dataset ------------------------------------------------------

#[tokio::test]
async fn current_dataset_reports_the_import() {
    let response = get(ready_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.content_type.starts_with("application/json"));

    let body = &response.body;
    assert_eq!(body["apiVersion"], "1");
    assert_eq!(body["status"], "ready");
    assert!(body["datasetId"].is_string());
    assert_eq!(body["source"]["name"], "roads-basic.osm");
    assert_eq!(body["source"]["format"], "osm-xml");

    assert_eq!(body["bounds"][0], 51.3860);
    assert_eq!(body["bounds"][1], 35.6890);
    assert_eq!(body["bounds"][2], 51.3930);
    assert_eq!(body["bounds"][3], 35.6960);

    let statistics = &body["statistics"];
    assert_eq!(statistics["nodesSeen"], 8);
    assert_eq!(statistics["nodesIndexed"], 7);
    assert_eq!(statistics["waysSeen"], 8);
    assert_eq!(statistics["roadWaysSelected"], 7);
    assert_eq!(statistics["featuresEmitted"], 4);
    assert_eq!(statistics["featuresSkipped"], 3);
    assert_eq!(statistics["relationsSeen"], 2);
    assert_eq!(statistics["featureCount"], 4);
    assert!(statistics["bytesRead"].as_u64().is_some_and(|n| n > 0));
}

#[tokio::test]
async fn current_dataset_groups_warnings_with_bounded_samples() {
    let response = get(ready_state(), "/api/v1/datasets/current").await;
    let warnings = response.body["warnings"]
        .as_array()
        .expect("warnings is an array");

    let codes: Vec<&str> = warnings
        .iter()
        .map(|warning| warning["code"].as_str().expect("code is a string"))
        .collect();
    assert_eq!(
        codes,
        vec![
            "INVALID_COORDINATE",
            "MISSING_NODE_REFERENCE",
            "TOO_FEW_COORDINATES",
            "UNKNOWN_HIGHWAY_CLASS",
            "UNSUPPORTED_RELATION",
        ]
    );

    let missing = warnings
        .iter()
        .find(|warning| warning["code"] == "MISSING_NODE_REFERENCE")
        .expect("missing node reference warning present");
    assert_eq!(missing["count"], 2);
    assert_eq!(missing["samples"][0], "way/104");
    assert_eq!(missing["samples"][1], "way/107");
}

#[tokio::test]
async fn current_dataset_carries_openstreetmap_attribution() {
    let response = get(ready_state(), "/api/v1/datasets/current").await;
    assert_eq!(
        response.body["attribution"]["text"],
        "© OpenStreetMap contributors"
    );
    assert_eq!(
        response.body["attribution"]["licenseUrl"],
        "https://www.openstreetmap.org/copyright"
    );
}

#[tokio::test]
async fn current_dataset_is_honest_while_loading() {
    let response = get(loading_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["status"], "loading");
    assert!(response.body.get("datasetId").is_none());
    assert_eq!(response.body["warnings"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn current_dataset_reports_a_failure_without_leaking_internals() {
    let response = get(failed_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["status"], "failed");
    assert_eq!(response.body["failure"]["category"], "malformed-source");
    let message = response.body["failure"]["message"]
        .as_str()
        .expect("failure message present");
    assert!(!message.contains('/'), "message leaked a path: {message}");
}

// -- feature queries ------------------------------------------------------

#[tokio::test]
async fn features_are_served_as_geojson() {
    let response = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");

    let body = &response.body;
    assert_eq!(body["type"], "FeatureCollection");
    assert_eq!(body["bbox"][0], 51.380);
    assert_eq!(body["bbox"][1], 35.680);
    assert_eq!(body["bbox"][2], 51.400);
    assert_eq!(body["bbox"][3], 35.700);

    let features = body["features"].as_array().expect("features is an array");
    assert_eq!(features.len(), 4);
    for feature in features {
        assert_eq!(feature["type"], "Feature");
        assert!(feature["id"].is_string());
        assert_eq!(feature["geometry"]["type"], "LineString");
        assert_eq!(feature["properties"]["kind"], "road");
        assert!(feature["properties"]["roadClass"].is_string());
    }
}

#[tokio::test]
async fn geojson_coordinates_are_numeric_longitude_latitude_pairs() {
    let response = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    let residential = response.body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .find(|feature| feature["id"] == "osm:way:101")
        .cloned()
        .expect("way 101 is in the viewport");

    let coordinates = residential["geometry"]["coordinates"]
        .as_array()
        .expect("coordinates is an array");
    assert_eq!(coordinates.len(), 3);
    for position in coordinates {
        let pair = position.as_array().expect("a position is an array");
        assert_eq!(pair.len(), 2);
        assert!(pair[0].is_number() && pair[1].is_number());
    }
    // Longitude first, latitude second.
    assert_eq!(coordinates[0][0], 51.3880);
    assert_eq!(coordinates[0][1], 35.6890);
}

#[tokio::test]
async fn unicode_names_survive_the_wire() {
    let response = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    let names: Vec<&str> = response.body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .filter_map(|feature| feature["properties"]["name"].as_str())
        .collect();
    assert!(names.contains(&"خیابان ولیعصر"), "got {names:?}");
    assert!(names.contains(&"گذر پیاده"), "got {names:?}");
}

#[tokio::test]
async fn atlas_metadata_is_a_top_level_foreign_member() {
    let response = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    let atlas = &response.body["atlas"];
    assert_eq!(atlas["apiVersion"], "1");
    assert!(atlas["datasetId"].is_string());
    assert_eq!(atlas["returned"], 4);
    assert_eq!(atlas["truncated"], false);
    assert_eq!(atlas["limit"], 1000);
    // Optional blocks stay out unless asked for.
    assert!(atlas.get("diagnostics").is_none());
    assert!(
        response.body["features"][0]["properties"]
            .get("source")
            .is_none()
    );
}

#[tokio::test]
async fn optional_includes_add_source_and_diagnostics() {
    let response = get(
        ready_state(),
        &format!("/api/v1/map/features?{VIEWPORT}&include=source,diagnostics"),
    )
    .await;

    let diagnostics = &response.body["atlas"]["diagnostics"];
    assert_eq!(diagnostics["featuresExamined"], 4);
    assert_eq!(diagnostics["candidatesFound"], 4);
    assert_eq!(diagnostics["featuresReturned"], 4);
    assert!(diagnostics["elapsedMs"].is_number());

    let source = &response.body["features"][0]["properties"]["source"];
    assert_eq!(source["system"], "openstreetmap");
    assert_eq!(source["entityType"], "way");
    assert!(source["entityId"].is_string());
}

#[tokio::test]
async fn the_kind_filter_selects_roads() {
    let response = get(
        ready_state(),
        &format!("/api/v1/map/features?{VIEWPORT}&kind=road"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["atlas"]["returned"], 4);
}

#[tokio::test]
async fn a_small_limit_truncates_and_says_so() {
    let response = get(
        ready_state(),
        &format!("/api/v1/map/features?{VIEWPORT}&limit=2&include=diagnostics"),
    )
    .await;
    assert_eq!(response.body["features"].as_array().map(Vec::len), Some(2));
    assert_eq!(response.body["atlas"]["returned"], 2);
    assert_eq!(response.body["atlas"]["truncated"], true);
    assert_eq!(response.body["atlas"]["diagnostics"]["candidatesFound"], 4);
}

#[tokio::test]
async fn a_viewport_outside_the_data_returns_an_empty_collection() {
    let response = get(ready_state(), "/api/v1/map/features?bbox=0.0,0.0,0.1,0.1").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["type"], "FeatureCollection");
    assert_eq!(response.body["features"].as_array().map(Vec::len), Some(0));
    assert_eq!(response.body["atlas"]["truncated"], false);
}

#[tokio::test]
async fn repeated_identical_queries_return_an_identical_feature_order() {
    let uri = format!("/api/v1/map/features?{VIEWPORT}");
    let ids = |body: &Value| {
        body["features"]
            .as_array()
            .expect("features is an array")
            .iter()
            .map(|feature| feature["id"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>()
    };
    let first = get(ready_state(), &uri).await;
    let second = get(ready_state(), &uri).await;
    assert_eq!(ids(&first.body), ids(&second.body));
    assert_eq!(
        ids(&first.body),
        vec!["osm:way:101", "osm:way:102", "osm:way:105", "osm:way:106"]
    );
}

// -- errors ---------------------------------------------------------------

#[tokio::test]
async fn a_missing_bbox_is_an_invalid_query() {
    let response = get(ready_state(), "/api/v1/map/features").await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&response.body), "INVALID_QUERY");
    assert!(response.body["error"]["requestId"].is_string());
    assert!(response.body["error"]["details"].is_object());
}

#[tokio::test]
async fn errors_are_json_and_never_geojson() {
    let response = get(ready_state(), "/api/v1/map/features").await;
    assert!(response.content_type.starts_with("application/json"));
    assert!(response.body.get("type").is_none());
    assert!(response.body.get("features").is_none());
}

#[tokio::test]
async fn a_reversed_bbox_is_an_invalid_bounding_box() {
    let response = get(
        ready_state(),
        "/api/v1/map/features?bbox=51.400,35.680,51.380,35.700",
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&response.body), "INVALID_BOUNDING_BOX");
    assert_eq!(
        response.body["error"]["message"],
        "west must not be greater than east"
    );
}

#[tokio::test]
async fn out_of_range_coordinates_are_an_invalid_bounding_box() {
    let response = get(
        ready_state(),
        "/api/v1/map/features?bbox=-181.0,35.680,51.380,35.700",
    )
    .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&response.body), "INVALID_BOUNDING_BOX");
}

#[tokio::test]
async fn unsupported_parameters_and_values_are_rejected() {
    for uri in [
        "/api/v1/map/features?bbox=0,0,1,1&kind=building",
        "/api/v1/map/features?bbox=0,0,1,1&include=everything",
        "/api/v1/map/features?bbox=0,0,1,1&limit=0",
        "/api/v1/map/features?bbox=0,0,1,1&limit=5001",
        "/api/v1/map/features?bbox=0,0,1,1&zoom=12",
        "/api/v1/map/features?bbox=0,0,1",
    ] {
        let response = get(ready_state(), uri).await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{uri} should be rejected"
        );
        assert_eq!(error_code(&response.body), "INVALID_QUERY", "{uri}");
    }
}

#[tokio::test]
async fn querying_before_a_dataset_exists_is_not_ready() {
    let response = get(loading_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&response.body), "DATASET_NOT_READY");
    assert_eq!(
        response.body["error"]["details"]["datasetStatus"],
        "loading"
    );
}

#[tokio::test]
async fn pinning_a_stale_dataset_is_not_found() {
    let response = get(
        ready_state(),
        &format!("/api/v1/map/features?{VIEWPORT}&dataset=ds-gone"),
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&response.body), "DATASET_NOT_FOUND");
    assert_eq!(response.body["error"]["details"]["requested"], "ds-gone");
}

#[tokio::test]
async fn pinning_the_active_dataset_succeeds() {
    let state = ready_state();
    let active = state
        .registry()
        .active_id()
        .expect("a dataset is published")
        .as_str()
        .to_owned();
    let response = get(
        state,
        &format!("/api/v1/map/features?{VIEWPORT}&dataset={active}"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["atlas"]["datasetId"], active);
}

// -- traversal ------------------------------------------------------------

/// The viewport that covers every road in the directionality fixture.
const DIRECTION_VIEWPORT: &str = "bbox=51.389,35.690,51.397,35.699";

async fn direction_features(query: &str) -> Value {
    let response = get(
        directionality_state(),
        &format!("/api/v1/map/features?{DIRECTION_VIEWPORT}{query}"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    response.body
}

/// The traversal block of one feature, looked up by its Atlas id.
fn traversal_of<'a>(body: &'a Value, id: &str) -> &'a Value {
    let feature = body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .find(|feature| feature["id"] == id)
        .unwrap_or_else(|| panic!("{id} is in the response"));
    &feature["properties"]["traversal"]
}

#[tokio::test]
async fn every_road_carries_a_nested_traversal_block() {
    let body = direction_features("").await;
    let features = body["features"].as_array().expect("features is an array");
    assert_eq!(features.len(), 17);

    for feature in features {
        let traversal = &feature["properties"]["traversal"];
        assert!(
            traversal.is_object(),
            "{} has no traversal block",
            feature["id"]
        );
        for mode in ["motorcar", "bicycle", "foot"] {
            assert!(
                traversal[mode]["direction"].is_string(),
                "{} is missing {mode} direction",
                feature["id"]
            );
            assert!(
                traversal[mode]["access"].is_string(),
                "{} is missing {mode} access",
                feature["id"]
            );
        }
        // The wire format stays nested; nothing is flattened server side.
        assert!(feature["properties"].get("motorcarDirection").is_none());
    }
}

#[tokio::test]
async fn the_traversal_shape_is_exactly_as_documented() {
    let body = direction_features("").await;
    // A plain one-way residential street: the example in the README and ADR.
    assert_eq!(
        *traversal_of(&body, "osm:way:304"),
        serde_json::json!({
            "motorcar": { "direction": "forward", "access": "unspecified" },
            "bicycle": { "direction": "both", "access": "unspecified" },
            "foot": { "direction": "both", "access": "unspecified" },
        })
    );
    let properties = &body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .find(|feature| feature["id"] == "osm:way:304")
        .expect("way 304 is in the response")["properties"];
    assert_eq!(properties["kind"], "road");
    assert_eq!(properties["roadClass"], "residential");
}

#[tokio::test]
async fn every_wire_direction_value_appears_on_the_wire() {
    let body = direction_features("").await;
    let cases = [
        ("osm:way:301", "both", "both", "both"),
        ("osm:way:302", "forward", "forward", "both"),
        ("osm:way:303", "reverse", "reverse", "both"),
        ("osm:way:308", "reverse", "both", "forward"),
        ("osm:way:309", "reversible", "reversible", "both"),
        ("osm:way:310", "alternating", "alternating", "both"),
        ("osm:way:311", "indeterminate", "indeterminate", "both"),
        ("osm:way:312", "forward", "forward", "indeterminate"),
        ("osm:way:314", "forward", "forward", "forward"),
    ];
    for (id, motorcar, bicycle, foot) in cases {
        let traversal = traversal_of(&body, id);
        assert_eq!(
            traversal["motorcar"]["direction"], motorcar,
            "{id} motorcar"
        );
        assert_eq!(traversal["bicycle"]["direction"], bicycle, "{id} bicycle");
        assert_eq!(traversal["foot"]["direction"], foot, "{id} foot");
    }

    // Every value Atlas can emit is covered by the cases above.
    let seen: std::collections::BTreeSet<&str> = cases
        .iter()
        .flat_map(|(_, motorcar, bicycle, foot)| [*motorcar, *bicycle, *foot])
        .collect();
    assert_eq!(
        seen,
        [
            "alternating",
            "both",
            "forward",
            "indeterminate",
            "reverse",
            "reversible",
        ]
        .into_iter()
        .collect()
    );
}

#[tokio::test]
async fn traversal_is_present_with_and_without_include_parameters() {
    let bare = direction_features("").await;
    let with_source = direction_features("&include=source").await;
    let with_both = direction_features("&include=source,diagnostics").await;
    let with_diagnostics = direction_features("&include=diagnostics").await;

    for body in [&bare, &with_source, &with_both, &with_diagnostics] {
        assert_eq!(
            *traversal_of(body, "osm:way:303"),
            serde_json::json!({
                "motorcar": { "direction": "reverse", "access": "unspecified" },
                "bicycle": { "direction": "reverse", "access": "unspecified" },
                "foot": { "direction": "both", "access": "unspecified" },
            }),
            "traversal must not depend on include"
        );
    }

    // The include parameters keep doing exactly what they did before.
    assert!(bare["features"][0]["properties"].get("source").is_none());
    assert!(bare["atlas"].get("diagnostics").is_none());
    assert!(with_source["features"][0]["properties"]["source"].is_object());
    assert!(with_source["atlas"].get("diagnostics").is_none());
    assert!(
        with_diagnostics["features"][0]["properties"]
            .get("source")
            .is_none()
    );
    assert!(with_diagnostics["atlas"]["diagnostics"].is_object());
}

#[tokio::test]
async fn traversal_never_exposes_raw_osm_tags() {
    let body = direction_features("&include=source,diagnostics").await;
    let rendered = body.to_string();
    for leaked in [
        "oneway",
        "junction",
        "roundabout",
        "highway",
        "motor_vehicle",
        "conditional",
    ] {
        assert!(
            !rendered.contains(leaked),
            "the response leaked the OSM tag `{leaked}`"
        );
    }
}

#[tokio::test]
async fn the_milestone_one_fixture_gains_traversal_without_changing_anything_else() {
    // roads-basic has no direction tags at all, so every road there is simply
    // two-way. Its other properties must be untouched.
    let response = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    assert_eq!(response.body["atlas"]["returned"], 4);

    for feature in response.body["features"]
        .as_array()
        .expect("features is an array")
    {
        assert_eq!(feature["properties"]["kind"], "road");
        assert_eq!(
            feature["properties"]["traversal"],
            serde_json::json!({
                "motorcar": { "direction": "both", "access": "unspecified" },
                "bicycle": { "direction": "both", "access": "unspecified" },
                "foot": { "direction": "both", "access": "unspecified" },
            })
        );
    }
}

#[tokio::test]
async fn the_directionality_dataset_reports_its_direction_warnings() {
    let response = get(directionality_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["apiVersion"], "1");
    assert_eq!(response.body["status"], "ready");
    assert_eq!(
        response.body["warnings"],
        serde_json::json!([
            { "code": "UNKNOWN_ONEWAY_VALUE", "count": 2, "samples": ["way/311", "way/317"] },
            { "code": "AMBIGUOUS_ONEWAY_SCOPE", "count": 2, "samples": ["way/312", "way/316"] },
            {
                "code": "UNSUPPORTED_CONDITIONAL_ONEWAY",
                "count": 1,
                "samples": ["way/313"],
            },
        ])
    );
    assert_eq!(response.body["statistics"]["featureCount"], 17);
    assert_eq!(response.body["statistics"]["featuresSkipped"], 0);
}

#[tokio::test]
async fn a_client_that_ignores_traversal_still_sees_the_milestone_one_contract() {
    let body = direction_features("&include=source").await;
    let feature = &body["features"][0];
    assert_eq!(feature["type"], "Feature");
    assert!(feature["id"].is_string());
    assert_eq!(feature["geometry"]["type"], "LineString");
    assert!(feature["geometry"]["coordinates"].is_array());
    assert!(feature["properties"]["kind"].is_string());
    assert!(feature["properties"]["roadClass"].is_string());
    assert!(feature["properties"]["name"].is_string());
    assert_eq!(body["type"], "FeatureCollection");
    assert_eq!(body["atlas"]["apiVersion"], "1");
}

// -- access ---------------------------------------------------------------

/// The viewport that covers every road in the access fixture.
const ACCESS_VIEWPORT: &str = "bbox=51.389,35.698,51.394,35.711";

async fn access_features(query: &str) -> Value {
    let response = get(
        access_state(),
        &format!("/api/v1/map/features?{ACCESS_VIEWPORT}{query}"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    response.body
}

#[tokio::test]
async fn every_road_carries_access_for_all_three_modes() {
    let body = access_features("").await;
    let features = body["features"].as_array().expect("features is an array");
    assert_eq!(features.len(), 23);

    for feature in features {
        let traversal = &feature["properties"]["traversal"];
        for mode in ["motorcar", "bicycle", "foot"] {
            assert!(
                traversal[mode]["access"].is_string(),
                "{} is missing {mode} access",
                feature["id"]
            );
            assert!(
                traversal[mode]["direction"].is_string(),
                "{} is missing {mode} direction",
                feature["id"]
            );
        }
        // Access stays inside the per-mode block; nothing is flattened or
        // promoted to a top-level property server side.
        assert!(feature["properties"].get("access").is_none());
        assert!(feature["properties"].get("motorcarAccess").is_none());
    }
}

#[tokio::test]
async fn the_access_shape_is_exactly_as_documented() {
    let body = access_features("").await;
    // Way 407 layers three access keys over a reverse one-way: the example in
    // the README and in ADR-008.
    assert_eq!(
        *traversal_of(&body, "osm:way:407"),
        serde_json::json!({
            "motorcar": { "direction": "reverse", "access": "private" },
            "bicycle": { "direction": "reverse", "access": "permissive" },
            "foot": { "direction": "both", "access": "allowed" },
        })
    );
}

#[tokio::test]
async fn the_api_version_does_not_change_for_an_additive_member() {
    let body = access_features("").await;
    assert_eq!(body["atlas"]["apiVersion"], "1");
    let dataset = get(access_state(), "/api/v1/datasets/current").await;
    assert_eq!(dataset.body["apiVersion"], "1");
}

#[tokio::test]
async fn the_access_fixture_serialises_the_documented_table() {
    let body = access_features("").await;
    let cases = [
        ("osm:way:401", "unspecified", "unspecified", "unspecified"),
        ("osm:way:402", "allowed", "allowed", "allowed"),
        ("osm:way:403", "prohibited", "prohibited", "prohibited"),
        ("osm:way:404", "prohibited", "prohibited", "allowed"),
        ("osm:way:405", "prohibited", "allowed", "unspecified"),
        (
            "osm:way:406",
            "destination-only",
            "unspecified",
            "unspecified",
        ),
        ("osm:way:407", "private", "permissive", "allowed"),
        ("osm:way:408", "unspecified", "designated", "unspecified"),
        ("osm:way:409", "unspecified", "unspecified", "permissive"),
        (
            "osm:way:410",
            "customers-only",
            "customers-only",
            "customers-only",
        ),
        ("osm:way:411", "delivery-only", "unspecified", "unspecified"),
        (
            "osm:way:412",
            "unspecified",
            "dismount-required",
            "unspecified",
        ),
        ("osm:way:413", "unspecified", "use-sidepath", "unspecified"),
        (
            "osm:way:414",
            "permit-required",
            "unspecified",
            "unspecified",
        ),
        ("osm:way:415", "unspecified", "discouraged", "unspecified"),
        (
            "osm:way:416",
            "indeterminate",
            "indeterminate",
            "indeterminate",
        ),
        ("osm:way:417", "indeterminate", "allowed", "allowed"),
        ("osm:way:418", "conditional", "conditional", "conditional"),
        ("osm:way:419", "conditional", "conditional", "allowed"),
        ("osm:way:420", "allowed", "conditional", "unspecified"),
        ("osm:way:421", "conditional", "unspecified", "unspecified"),
        ("osm:way:422", "variable", "variable", "variable"),
        (
            "osm:way:423",
            "indeterminate",
            "indeterminate",
            "indeterminate",
        ),
    ];
    assert_eq!(cases.len(), 23);
    for (id, motorcar, bicycle, foot) in cases {
        let traversal = traversal_of(&body, id);
        assert_eq!(traversal["motorcar"]["access"], motorcar, "{id} motorcar");
        assert_eq!(traversal["bicycle"]["access"], bicycle, "{id} bicycle");
        assert_eq!(traversal["foot"]["access"], foot, "{id} foot");
    }
}

#[tokio::test]
async fn every_wire_access_value_appears_on_the_wire() {
    // The fixture shows sixteen of the nineteen rules. The three
    // activity-specific ones have no fixture row, so they are serialised here
    // from an inline document: a wire vocabulary is only a contract if every
    // value in it has actually been produced by the real serialiser.
    let xml = r#"<osm>
      <node id="1" lat="35.70" lon="51.39"/>
      <node id="2" lat="35.70" lon="51.391"/>
      <way id="1"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="track"/><tag k="motorcar" v="agricultural"/></way>
      <way id="2"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="track"/><tag k="motorcar" v="forestry"/></way>
      <way id="3"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="track"/><tag k="motorcar" v="military"/></way>
    </osm>"#;
    let response = get(
        state_from_xml(xml),
        "/api/v1/map/features?bbox=51.389,35.699,51.392,35.701",
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    let extra = [
        ("osm:way:1", "agricultural-only"),
        ("osm:way:2", "forestry-only"),
        ("osm:way:3", "military-only"),
    ];
    for (id, expected) in extra {
        assert_eq!(
            traversal_of(&response.body, id)["motorcar"]["access"],
            expected
        );
    }

    // Together with the fixture table, every rule Atlas models has now been
    // seen on the wire, spelled exactly as the contract says.
    let body = access_features("").await;
    let mut seen: std::collections::BTreeSet<String> = body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .flat_map(|feature| {
            ["motorcar", "bicycle", "foot"].map(|mode| {
                feature["properties"]["traversal"][mode]["access"]
                    .as_str()
                    .expect("access is a string")
                    .to_owned()
            })
        })
        .collect();
    seen.extend(extra.iter().map(|(_, value)| (*value).to_owned()));
    assert_eq!(
        seen,
        [
            "agricultural-only",
            "allowed",
            "conditional",
            "customers-only",
            "delivery-only",
            "designated",
            "destination-only",
            "discouraged",
            "dismount-required",
            "forestry-only",
            "indeterminate",
            "military-only",
            "permissive",
            "permit-required",
            "private",
            "prohibited",
            "unspecified",
            "use-sidepath",
            "variable",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    assert_eq!(seen.len(), 19);
}

#[tokio::test]
async fn access_is_present_with_and_without_include_parameters() {
    let bare = access_features("").await;
    let with_source = access_features("&include=source").await;
    let with_diagnostics = access_features("&include=diagnostics").await;
    let with_both = access_features("&include=source,diagnostics").await;

    for body in [&bare, &with_source, &with_diagnostics, &with_both] {
        assert_eq!(
            *traversal_of(body, "osm:way:404"),
            serde_json::json!({
                "motorcar": { "direction": "both", "access": "prohibited" },
                "bicycle": { "direction": "both", "access": "prohibited" },
                "foot": { "direction": "both", "access": "allowed" },
            }),
            "access must not depend on include"
        );
    }

    // The include parameters keep doing exactly what they did before.
    assert!(bare["features"][0]["properties"].get("source").is_none());
    assert!(bare["atlas"].get("diagnostics").is_none());
    assert!(with_source["features"][0]["properties"]["source"].is_object());
    assert!(with_diagnostics["atlas"]["diagnostics"].is_object());
    assert!(with_both["features"][0]["properties"]["source"].is_object());
    assert!(with_both["atlas"]["diagnostics"].is_object());
}

#[tokio::test]
async fn access_never_exposes_raw_osm_tags() {
    let body = access_features("&include=source,diagnostics").await;
    let rendered = body.to_string();
    for leaked in [
        "access:conditional",
        "motor_vehicle",
        "motorcar:conditional",
        "vehicle:conditional",
        "use_sidepath",
        "oneway",
        "junction",
        "highway",
        "@ (",
        "Mo-Fr",
        "07:00",
    ] {
        assert!(
            !rendered.contains(leaked),
            "the response leaked the OSM tag or value `{leaked}`"
        );
    }
    // The conditional roads are on the wire, described in Atlas's own words.
    assert_eq!(
        traversal_of(&body, "osm:way:418")["motorcar"]["access"],
        "conditional"
    );
}

#[tokio::test]
async fn a_conditional_never_serialises_as_a_plain_yes_or_no() {
    // The fixture's conditional expressions all read `no @ (...)`. Reading one
    // as an unconditional prohibition would be the single worst thing Atlas
    // could do with a tag it has decided not to parse.
    let body = access_features("").await;
    for id in ["osm:way:418", "osm:way:419", "osm:way:420", "osm:way:421"] {
        let traversal = traversal_of(&body, id);
        let rules: Vec<&str> = ["motorcar", "bicycle", "foot"]
            .iter()
            .map(|mode| traversal[*mode]["access"].as_str().expect("a string"))
            .collect();
        assert!(rules.contains(&"conditional"), "{id}: {rules:?}");
        assert!(!rules.contains(&"prohibited"), "{id}: {rules:?}");
    }
}

#[tokio::test]
async fn direction_and_access_stay_independent_on_the_wire() {
    let body = access_features("").await;
    // A road closed to everyone still states its one-way direction.
    let closed = traversal_of(&body, "osm:way:403");
    assert_eq!(closed["motorcar"]["access"], "prohibited");
    assert_eq!(closed["motorcar"]["direction"], "forward");
    assert_eq!(closed["foot"]["direction"], "both");

    // Two roads with the same direction and different access, and two with the
    // same access and different direction.
    let conditional = traversal_of(&body, "osm:way:418");
    assert_eq!(conditional["motorcar"]["direction"], "forward");
    assert_ne!(
        conditional["motorcar"]["access"],
        closed["motorcar"]["access"]
    );

    let open_two_way = traversal_of(&body, "osm:way:402");
    let barred_two_way = traversal_of(&body, "osm:way:404");
    assert_eq!(
        open_two_way["motorcar"]["direction"],
        barred_two_way["motorcar"]["direction"]
    );
    assert_ne!(
        open_two_way["motorcar"]["access"],
        barred_two_way["motorcar"]["access"]
    );
}

#[tokio::test]
async fn the_older_fixtures_serialise_unspecified_for_every_mode() {
    // roads-basic and roads-directionality carry no access tags at all. The
    // honest wire answer is `unspecified`, never `allowed`.
    for state in [ready_state(), directionality_state()] {
        let viewport = "bbox=51.380,35.680,51.400,35.700";
        let response = get(state, &format!("/api/v1/map/features?{viewport}")).await;
        assert_eq!(response.status, StatusCode::OK);
        let features = response.body["features"]
            .as_array()
            .expect("features is an array");
        assert!(!features.is_empty());
        for feature in features {
            for mode in ["motorcar", "bicycle", "foot"] {
                assert_eq!(
                    feature["properties"]["traversal"][mode]["access"], "unspecified",
                    "{} {mode} must be unspecified, not allowed",
                    feature["id"]
                );
            }
        }
    }
}

#[tokio::test]
async fn the_access_dataset_reports_its_access_warnings() {
    let response = get(access_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["apiVersion"], "1");
    assert_eq!(response.body["status"], "ready");
    assert_eq!(
        response.body["warnings"],
        serde_json::json!([
            { "code": "UNKNOWN_ACCESS_VALUE", "count": 1, "samples": ["way/417"] },
            { "code": "INVALID_ACCESS_SCOPE", "count": 1, "samples": ["way/423"] },
            {
                "code": "UNSUPPORTED_CONDITIONAL_ACCESS",
                "count": 4,
                "samples": ["way/418", "way/419", "way/420", "way/421"],
            },
        ])
    );
    assert_eq!(response.body["statistics"]["featureCount"], 23);
    assert_eq!(response.body["statistics"]["featuresSkipped"], 0);
    assert_eq!(response.body["statistics"]["featuresEmitted"], 23);
}

#[tokio::test]
async fn access_problems_never_change_the_error_or_media_type_contracts() {
    // An access warning is a property of a dataset, not of a request. Every
    // error body and media type stays exactly as Milestone 1 defined it.
    let bad = get(
        access_state(),
        "/api/v1/map/features?bbox=51.400,35.680,51.380,35.700",
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.content_type, "application/json");
    assert_eq!(error_code(&bad.body), "INVALID_BOUNDING_BOX");
    assert!(bad.body["error"]["requestId"].is_string());

    let missing = get(access_state(), "/api/v1/map/features").await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.content_type, "application/json");
    assert_eq!(error_code(&missing.body), "INVALID_QUERY");

    let ok = get(
        access_state(),
        &format!("/api/v1/map/features?{ACCESS_VIEWPORT}"),
    )
    .await;
    assert_eq!(ok.content_type, "application/geo+json");
}

#[tokio::test]
async fn a_client_that_ignores_access_still_sees_the_earlier_contract() {
    let body = access_features("&include=source").await;
    let feature = &body["features"][0];
    assert_eq!(feature["type"], "Feature");
    assert!(feature["id"].is_string());
    assert_eq!(feature["geometry"]["type"], "LineString");
    assert!(feature["geometry"]["coordinates"].is_array());
    assert!(feature["properties"]["kind"].is_string());
    assert!(feature["properties"]["roadClass"].is_string());
    assert!(feature["properties"]["name"].is_string());
    // Milestone 2A's member is still exactly where it was, spelled the same.
    assert!(feature["properties"]["traversal"]["motorcar"]["direction"].is_string());
    assert_eq!(body["type"], "FeatureCollection");
    assert_eq!(body["atlas"]["apiVersion"], "1");
}

#[tokio::test]
async fn access_does_not_disturb_the_geometry_on_the_wire() {
    let body = access_features("").await;
    for feature in body["features"].as_array().expect("features is an array") {
        assert_eq!(
            feature["geometry"]["coordinates"],
            serde_json::json!([
                [51.39, feature["geometry"]["coordinates"][0][1]],
                [51.3915, feature["geometry"]["coordinates"][1][1]],
                [51.393, feature["geometry"]["coordinates"][2][1]],
            ]),
            "{} lost or reordered its coordinates",
            feature["id"]
        );
    }
}
