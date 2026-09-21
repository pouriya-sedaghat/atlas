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

fn speed_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-speed.osm")
}

fn topology_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/synthetic/roads-topology.osm")
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

/// A dataset built from the fixture that exercises the speed-limit facts.
fn speed_state() -> SharedState {
    state_for(speed_fixture_path())
}

/// A dataset built from the fixture that exercises the topology rules.
fn topology_state() -> SharedState {
    state_for(topology_fixture_path())
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

/// The `speedLimits` block of a road whose source said nothing about speed.
///
/// Spelled out in full rather than omitted. Both geometry directions are
/// always published, and "the source said nothing" is a claim the wire makes
/// explicitly — a client must never have to read it out of an absent member.
fn silent_speed_limits() -> Value {
    let silent = serde_json::json!({
        "limit": { "kind": "unspecified" },
        "conditional": false,
        "variable": "not-tagged",
    });
    serde_json::json!({ "forward": silent, "backward": silent })
}

/// A `speedLimits` block with the same numeric limit in both directions.
fn uniform_speed_limits(value: &str, unit: &str) -> Value {
    let fact = serde_json::json!({
        "limit": { "kind": "numeric", "value": value, "unit": unit },
        "conditional": false,
        "variable": "not-tagged",
    });
    serde_json::json!({ "forward": fact, "backward": fact })
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
            for direction in ["forward", "backward"] {
                let fact = &traversal[mode]["speedLimits"][direction];
                assert!(
                    fact["limit"]["kind"].is_string(),
                    "{} is missing {mode} {direction} speed limit",
                    feature["id"]
                );
                assert!(
                    fact["conditional"].is_boolean(),
                    "{} is missing {mode} {direction} conditional",
                    feature["id"]
                );
                assert!(
                    fact["variable"].is_string(),
                    "{} is missing {mode} {direction} variable",
                    feature["id"]
                );
            }
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
            "motorcar": {
                "direction": "forward",
                "access": "unspecified",
                "speedLimits": silent_speed_limits(),
            },
            "bicycle": {
                "direction": "both",
                "access": "unspecified",
                "speedLimits": silent_speed_limits(),
            },
            "foot": {
                "direction": "both",
                "access": "unspecified",
                "speedLimits": silent_speed_limits(),
            },
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
                "motorcar": {
                    "direction": "reverse",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
                "bicycle": {
                    "direction": "reverse",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
                "foot": {
                    "direction": "both",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
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
        // Every OSM spelling of a conditional or speed key. The bare word
        // `conditional` is no longer on this list because it is now an Atlas
        // wire member of its own — `traversal.<mode>.speedLimits.<direction>
        // .conditional` — so the tag names are checked in full instead.
        "oneway:conditional",
        "access:conditional",
        "maxspeed",
        "minspeed",
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
                "motorcar": {
                    "direction": "both",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
                "bicycle": {
                    "direction": "both",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
                "foot": {
                    "direction": "both",
                    "access": "unspecified",
                    "speedLimits": silent_speed_limits(),
                },
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
            "motorcar": {
                "direction": "reverse",
                "access": "private",
                "speedLimits": silent_speed_limits(),
            },
            "bicycle": {
                "direction": "reverse",
                "access": "permissive",
                "speedLimits": silent_speed_limits(),
            },
            "foot": {
                "direction": "both",
                "access": "allowed",
                "speedLimits": silent_speed_limits(),
            },
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
                "motorcar": {
                    "direction": "both",
                    "access": "prohibited",
                    "speedLimits": silent_speed_limits(),
                },
                "bicycle": {
                    "direction": "both",
                    "access": "prohibited",
                    "speedLimits": silent_speed_limits(),
                },
                "foot": {
                    "direction": "both",
                    "access": "allowed",
                    "speedLimits": silent_speed_limits(),
                },
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

// -- speed limits ---------------------------------------------------------

/// The viewport that covers every road in the speed fixture.
const SPEED_VIEWPORT: &str = "bbox=51.389,35.708,51.394,35.721";

async fn speed_features(query: &str) -> Value {
    let response = get(
        speed_state(),
        &format!("/api/v1/map/features?{SPEED_VIEWPORT}{query}"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    response.body
}

/// One mode's `speedLimits` block on one feature.
fn speed_of<'a>(body: &'a Value, id: &str, mode: &str) -> &'a Value {
    &traversal_of(body, id)[mode]["speedLimits"]
}

/// One fact: the limit, the conditional flag and the variability, in one go.
fn fact_of<'a>(body: &'a Value, id: &str, mode: &str, direction: &str) -> &'a Value {
    &speed_of(body, id, mode)[direction]
}

#[tokio::test]
async fn every_road_publishes_both_directions_for_all_three_modes() {
    let body = speed_features("").await;
    let features = body["features"].as_array().expect("features is an array");
    assert_eq!(features.len(), 24);

    for feature in features {
        let traversal = &feature["properties"]["traversal"];
        for mode in ["motorcar", "bicycle", "foot"] {
            let limits = &traversal[mode]["speedLimits"];
            assert!(
                limits.is_object(),
                "{} has no {mode} speedLimits",
                feature["id"]
            );
            // Exactly two directions, always, whatever the road's direction
            // of travel says: forward and backward are properties of the
            // geometry, not of the traffic.
            assert_eq!(
                limits.as_object().expect("an object").len(),
                2,
                "{} {mode} must publish exactly forward and backward",
                feature["id"]
            );
            for direction in ["forward", "backward"] {
                let fact = &limits[direction];
                assert_eq!(
                    fact.as_object().expect("an object").len(),
                    3,
                    "{} {mode} {direction} must publish exactly limit, conditional and variable",
                    feature["id"]
                );
                assert!(fact["limit"]["kind"].is_string());
                assert!(fact["conditional"].is_boolean());
                assert!(fact["variable"].is_string());
            }
        }
    }
}

#[tokio::test]
async fn the_speed_shape_is_exactly_as_documented() {
    // Way 524 is the orthogonality road: a reverse one-way, private to cars,
    // permissive and two-way for bicycles, and signed 70 forward and 30
    // backward for every mode. It is the example in the README and in
    // ADR-009, and it is the case the whole "four independent records" rule
    // exists for — so it is written out here in full rather than built by a
    // helper.
    let body = speed_features("").await;
    let seventy_thirty = serde_json::json!({
        "forward": {
            "limit": { "kind": "numeric", "value": "70", "unit": "km/h" },
            "conditional": false,
            "variable": "not-tagged",
        },
        "backward": {
            "limit": { "kind": "numeric", "value": "30", "unit": "km/h" },
            "conditional": false,
            "variable": "not-tagged",
        },
    });
    assert_eq!(
        *traversal_of(&body, "osm:way:524"),
        serde_json::json!({
            "motorcar": {
                "direction": "reverse",
                "access": "private",
                "speedLimits": seventy_thirty,
            },
            "bicycle": {
                "direction": "both",
                "access": "permissive",
                "speedLimits": seventy_thirty,
            },
            "foot": {
                "direction": "both",
                "access": "allowed",
                "speedLimits": seventy_thirty,
            },
        })
    );
}

#[tokio::test]
async fn every_limit_kind_appears_on_the_wire_in_its_documented_shape() {
    let body = speed_features("").await;
    let cases = [
        ("osm:way:501", serde_json::json!({ "kind": "unspecified" })),
        (
            "osm:way:502",
            serde_json::json!({ "kind": "numeric", "value": "50", "unit": "km/h" }),
        ),
        (
            "osm:way:505",
            serde_json::json!({ "kind": "no-fixed-limit" }),
        ),
        ("osm:way:506", serde_json::json!({ "kind": "walking-pace" })),
        (
            "osm:way:507",
            serde_json::json!({ "kind": "implicit", "code": "RO:urban" }),
        ),
        (
            "osm:way:514",
            serde_json::json!({ "kind": "indeterminate" }),
        ),
    ];
    for (id, limit) in cases {
        for mode in ["motorcar", "bicycle", "foot"] {
            for direction in ["forward", "backward"] {
                assert_eq!(
                    fact_of(&body, id, mode, direction)["limit"],
                    limit,
                    "{id} {mode} {direction}"
                );
            }
        }
    }
}

#[tokio::test]
async fn a_multi_segment_implicit_code_reaches_the_wire_unchanged() {
    // The source documents implicit values whose context narrows more than
    // once. They are served from an inline document rather than a fixture row,
    // because the 24-way fixture is laid out to be read by a human in Studio
    // and one more near-identical row would demonstrate nothing there.
    //
    // The point of the assertion is that the code arrives *whole*: Atlas
    // preserves the jurisdiction, every context component and the colon
    // structure between them, and still resolves none of it to a number.
    let xml = r#"<osm>
      <node id="1" lat="35.70" lon="51.39"/>
      <node id="2" lat="35.70" lon="51.391"/>
      <way id="1"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="primary"/><tag k="maxspeed" v="AR:urban:primary"/></way>
      <way id="2"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="residential"/><tag k="maxspeed" v="DE:zone:30"/></way>
      <way id="3"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="residential"/><tag k="maxspeed" v="ar:URBAN:Primary"/></way>
      <way id="4"><nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="residential"/><tag k="maxspeed" v="RO:urban::extra"/></way>
    </osm>"#;
    let state = state_from_xml(xml);
    let response = get(
        state.clone(),
        "/api/v1/map/features?bbox=51.389,35.699,51.392,35.701",
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    let body = response.body;

    for (id, code) in [
        ("osm:way:1", "AR:urban:primary"),
        ("osm:way:2", "DE:zone:30"),
        // Case is normalised across every component; the structure is not.
        ("osm:way:3", "AR:urban:primary"),
    ] {
        for mode in ["motorcar", "bicycle", "foot"] {
            for direction in ["forward", "backward"] {
                assert_eq!(
                    fact_of(&body, id, mode, direction)["limit"],
                    serde_json::json!({ "kind": "implicit", "code": code }),
                    "{id} {mode} {direction}"
                );
            }
        }
    }

    // A code with an empty component is still not a code.
    assert_eq!(
        fact_of(&body, "osm:way:4", "motorcar", "forward")["limit"],
        serde_json::json!({ "kind": "indeterminate" })
    );

    // Only the malformed way earns the warning; the three valid codes do not.
    let dataset = get(state, "/api/v1/datasets/current").await;
    assert_eq!(
        dataset.body["warnings"],
        serde_json::json!([
            { "code": "UNKNOWN_MAXSPEED_VALUE", "count": 1, "samples": ["way/4"] },
        ])
    );

    // The API version and media type are untouched by any of it.
    assert_eq!(body["atlas"]["apiVersion"], "1");
    assert_eq!(dataset.body["apiVersion"], "1");
}

#[tokio::test]
async fn every_unit_reaches_the_wire_exactly_as_it_was_sourced() {
    // No conversion, anywhere. `30 mph` is not quietly 48 km/h, and the
    // magnitude is exact decimal text rather than a float.
    let body = speed_features("").await;
    for (id, value, unit) in [
        ("osm:way:502", "50", "km/h"),
        ("osm:way:503", "30", "mph"),
        ("osm:way:504", "10", "knots"),
    ] {
        assert_eq!(
            fact_of(&body, id, "motorcar", "forward")["limit"],
            serde_json::json!({ "kind": "numeric", "value": value, "unit": unit }),
            "{id}"
        );
    }
}

#[tokio::test]
async fn a_magnitude_is_an_exact_decimal_string_never_a_number() {
    // A JSON number would be a float on every client that parses it, and
    // `50.5` would stop being `50.5`. The contract is a string.
    let body = speed_features("").await;
    let value = &fact_of(&body, "osm:way:502", "motorcar", "forward")["limit"]["value"];
    assert!(value.is_string(), "a magnitude must be a string");
    assert_eq!(value, "50");
    assert!(!body.to_string().contains("\"value\":50"));
}

#[tokio::test]
async fn the_two_directions_are_published_separately() {
    let body = speed_features("").await;
    // Way 508 is signed 60 forward and 40 backward for every mode.
    for mode in ["motorcar", "bicycle", "foot"] {
        assert_eq!(
            fact_of(&body, "osm:way:508", mode, "forward")["limit"]["value"],
            "60"
        );
        assert_eq!(
            fact_of(&body, "osm:way:508", mode, "backward")["limit"]["value"],
            "40"
        );
    }
    // And 513 is unreadable forwards and perfectly readable backwards.
    assert_eq!(
        fact_of(&body, "osm:way:513", "motorcar", "forward")["limit"],
        serde_json::json!({ "kind": "indeterminate" })
    );
    assert_eq!(
        fact_of(&body, "osm:way:513", "motorcar", "backward")["limit"],
        serde_json::json!({ "kind": "numeric", "value": "50", "unit": "km/h" })
    );
}

#[tokio::test]
async fn the_modes_disagree_on_the_wire_when_the_source_makes_them() {
    let body = speed_features("").await;
    // Way 510 proves mode specificity precedes direction specificity, and the
    // wire must show all three modes disagreeing.
    let value = |mode: &str, direction: &str| {
        fact_of(&body, "osm:way:510", mode, direction)["limit"]["value"].clone()
    };
    assert_eq!(value("motorcar", "forward"), "35");
    assert_eq!(value("motorcar", "backward"), "35");
    assert_eq!(value("bicycle", "forward"), "55");
    assert_eq!(value("bicycle", "backward"), "45");
    assert_eq!(value("foot", "forward"), "60");
    assert_eq!(value("foot", "backward"), "50");
}

#[tokio::test]
async fn a_modifier_never_replaces_the_ordinary_limit_on_the_wire() {
    let body = speed_features("").await;

    // Way 517: signed 80, with a conditional beside it. Both are published.
    for mode in ["motorcar", "bicycle", "foot"] {
        for direction in ["forward", "backward"] {
            let fact = fact_of(&body, "osm:way:517", mode, direction);
            assert_eq!(
                fact["limit"],
                serde_json::json!({ "kind": "numeric", "value": "80", "unit": "km/h" })
            );
            assert_eq!(fact["conditional"], true);
            assert_eq!(fact["variable"], "not-tagged");
        }
    }

    // Way 521: signed 100, with a variable sign. Both are published.
    let fact = fact_of(&body, "osm:way:521", "motorcar", "forward");
    assert_eq!(
        fact["limit"],
        serde_json::json!({ "kind": "numeric", "value": "100", "unit": "km/h" })
    );
    assert_eq!(fact["conditional"], false);
    assert_eq!(fact["variable"], "variable");
}

#[tokio::test]
async fn every_variable_wire_form_appears() {
    let body = speed_features("").await;
    let variable =
        |id: &str, direction: &str| fact_of(&body, id, "motorcar", direction)["variable"].clone();
    assert_eq!(variable("osm:way:502", "forward"), "not-tagged");
    assert_eq!(variable("osm:way:522", "forward"), "fixed");
    assert_eq!(variable("osm:way:521", "forward"), "variable");
    assert_eq!(variable("osm:way:523", "forward"), "indeterminate");
    // The direction-specific key overrides the general one, on the wire too.
    assert_eq!(variable("osm:way:522", "backward"), "variable");
    assert_eq!(variable("osm:way:523", "backward"), "variable");
}

#[tokio::test]
async fn the_conditional_flag_is_scoped_exactly_as_the_source_scoped_it() {
    let body = speed_features("").await;
    let conditional = |id: &str, mode: &str, direction: &str| {
        fact_of(&body, id, mode, direction)["conditional"].clone()
    };

    // 518: the car's own key out-ranks the generic conditional.
    assert_eq!(conditional("osm:way:518", "motorcar", "forward"), false);
    assert_eq!(conditional("osm:way:518", "bicycle", "forward"), true);
    assert_eq!(conditional("osm:way:518", "foot", "backward"), true);

    // 519: out-ranked for every mode, so no fact carries it.
    for mode in ["motorcar", "bicycle", "foot"] {
        for direction in ["forward", "backward"] {
            assert_eq!(conditional("osm:way:519", mode, direction), false);
        }
    }

    // 520: scoped to one mode and one direction, and it reaches exactly one
    // of the six facts.
    assert_eq!(conditional("osm:way:520", "motorcar", "forward"), true);
    assert_eq!(conditional("osm:way:520", "motorcar", "backward"), false);
    assert_eq!(conditional("osm:way:520", "bicycle", "forward"), false);
}

#[tokio::test]
async fn speed_is_present_with_and_without_include_parameters() {
    let bare = speed_features("").await;
    let with_source = speed_features("&include=source").await;
    let with_diagnostics = speed_features("&include=diagnostics").await;
    let with_both = speed_features("&include=source,diagnostics").await;

    for body in [&bare, &with_source, &with_diagnostics, &with_both] {
        assert_eq!(
            *speed_of(body, "osm:way:503", "motorcar"),
            uniform_speed_limits("30", "mph"),
            "speed must not depend on include"
        );
    }

    assert!(bare["features"][0]["properties"].get("source").is_none());
    assert!(with_source["features"][0]["properties"]["source"].is_object());
    assert!(with_diagnostics["atlas"]["diagnostics"].is_object());
    assert!(with_both["features"][0]["properties"]["source"].is_object());
}

#[tokio::test]
async fn the_api_version_and_media_type_do_not_change_for_the_speed_member() {
    let response = get(
        speed_state(),
        &format!("/api/v1/map/features?{SPEED_VIEWPORT}"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.content_type, "application/geo+json");
    assert_eq!(response.body["atlas"]["apiVersion"], "1");

    let dataset = get(speed_state(), "/api/v1/datasets/current").await;
    assert_eq!(dataset.body["apiVersion"], "1");
    assert_eq!(dataset.content_type, "application/json");
}

#[tokio::test]
async fn speed_never_exposes_raw_osm_tags() {
    let body = speed_features("&include=source,diagnostics").await;
    let rendered = body.to_string();
    for leaked in [
        "maxspeed",
        "maxspeed:conditional",
        "maxspeed:variable",
        "maxspeed:type",
        "source:maxspeed",
        "motor_vehicle",
        "oneway",
        "highway",
        "@ (",
        "furlongs",
        "bogus",
        "perhaps",
    ] {
        assert!(
            !rendered.contains(leaked),
            "the response leaked the OSM tag or raw value `{leaked}`"
        );
    }
}

#[tokio::test]
async fn the_speed_dataset_reports_its_four_speed_warnings() {
    let response = get(speed_state(), "/api/v1/datasets/current").await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["apiVersion"], "1");
    assert_eq!(response.body["status"], "ready");
    assert_eq!(
        response.body["warnings"],
        serde_json::json!([
            {
                "code": "UNKNOWN_MAXSPEED_VALUE",
                "count": 4,
                "samples": ["way/512", "way/513", "way/515", "way/516"],
            },
            { "code": "UNSUPPORTED_MAXSPEED_UNIT", "count": 1, "samples": ["way/514"] },
            {
                "code": "UNSUPPORTED_CONDITIONAL_MAXSPEED",
                "count": 3,
                "samples": ["way/517", "way/518", "way/520"],
            },
            {
                "code": "UNKNOWN_VARIABLE_MAXSPEED_VALUE",
                "count": 1,
                "samples": ["way/523"],
            },
        ])
    );
    assert_eq!(response.body["statistics"]["featureCount"], 24);
    assert_eq!(response.body["statistics"]["featuresSkipped"], 0);
}

#[tokio::test]
async fn speed_does_not_disturb_the_geometry_on_the_wire() {
    let body = speed_features("").await;
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

#[tokio::test]
async fn a_client_that_ignores_speed_still_sees_the_earlier_contract() {
    let body = speed_features("&include=source").await;
    let feature = &body["features"][0];
    assert_eq!(feature["type"], "Feature");
    assert!(feature["id"].is_string());
    assert_eq!(feature["geometry"]["type"], "LineString");
    assert!(feature["properties"]["kind"].is_string());
    assert!(feature["properties"]["roadClass"].is_string());
    // Milestone 2A's and 2B's members are still exactly where they were.
    assert!(feature["properties"]["traversal"]["motorcar"]["direction"].is_string());
    assert!(feature["properties"]["traversal"]["motorcar"]["access"].is_string());
    assert_eq!(body["type"], "FeatureCollection");
    assert_eq!(body["atlas"]["apiVersion"], "1");
}

// -- topology -------------------------------------------------------------

/// A box around the whole topology fixture.
const TOPOLOGY_VIEWPORT: &str = "bbox=51.29,35.59,51.40,35.61";

/// A sliver over the stem of the T junction, east of node 4 and west of the
/// two arms, so exactly one segment intersects it.
const T_JUNCTION_VIEWPORT: &str = "bbox=51.3105,35.5995,51.3115,35.6005";

fn topology_url(query: &str) -> String {
    format!("/api/v1/map/topology?{query}")
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|entry| {
            entry[key]
                .as_str()
                .unwrap_or_else(|| panic!("{key} is a string"))
                .to_owned()
        })
        .collect()
}

#[tokio::test]
async fn topology_is_served_as_plain_json_not_geojson() {
    let response = get(topology_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(
        response.content_type.starts_with("application/json"),
        "topology is a graph, not a GeoJSON FeatureCollection: {}",
        response.content_type
    );
    assert!(!response.content_type.contains("geo+json"));
    // And it really is not a FeatureCollection.
    assert!(response.body["type"].is_null());
    assert!(response.body["features"].is_null());
}

#[tokio::test]
async fn the_topology_shape_is_exactly_as_documented() {
    // The T junction alone: three segments meeting at one node of degree 3.
    let response = get(topology_state(), &topology_url(T_JUNCTION_VIEWPORT)).await;
    assert_eq!(response.status, StatusCode::OK);
    let body = &response.body;

    assert_eq!(body["apiVersion"], "1");
    assert!(body["datasetId"].is_string());
    assert_eq!(body["bbox"][0], 51.3105);
    assert_eq!(body["bbox"][1], 35.5995);
    assert_eq!(body["bbox"][2], 51.3115);
    assert_eq!(body["bbox"][3], 35.6005);

    // Only way 602's segment is inside this box; the other two arms run east
    // of it. Both of its endpoints come back, and node 5's degree is the
    // degree it has in the whole dataset, not in this viewport.
    assert_eq!(
        string_array(&body["segments"], "id"),
        vec!["osm:way:602:segment:0"]
    );
    let segment = &body["segments"][0];
    assert_eq!(segment["id"], "osm:way:602:segment:0");
    assert_eq!(segment["roadFeatureId"], "osm:way:602");
    assert_eq!(segment["startNodeId"], "osm:node:4");
    assert_eq!(segment["endNodeId"], "osm:node:5");
    assert_eq!(segment["geometry"]["type"], "LineString");
    assert_eq!(segment["geometry"]["coordinates"][0][0], 51.3100);
    assert_eq!(segment["geometry"]["coordinates"][0][1], 35.6000);
    assert_eq!(segment["geometry"]["coordinates"][1][0], 51.3120);
    assert_eq!(segment["geometry"]["coordinates"][1][1], 35.6000);

    // A segment object has exactly these five members and no more. The
    // comparison is against the sorted member names because a parsed
    // `serde_json::Value` sorts its keys; what is being pinned here is the
    // membership, and the absence of anything else.
    let members: Vec<&String> = segment
        .as_object()
        .expect("a segment is an object")
        .keys()
        .collect();
    assert_eq!(
        members,
        vec![
            "endNodeId",
            "geometry",
            "id",
            "roadFeatureId",
            "startNodeId"
        ]
    );

    assert_eq!(
        string_array(&body["nodes"], "id"),
        vec!["osm:node:4", "osm:node:5"]
    );
    let junction = body["nodes"]
        .as_array()
        .expect("nodes is an array")
        .iter()
        .find(|node| node["id"] == "osm:node:5")
        .expect("node 5 is returned");
    assert_eq!(junction["coordinate"][0], 51.3120);
    assert_eq!(junction["coordinate"][1], 35.6000);
    assert_eq!(junction["degree"], 3);
    let node_members: Vec<&String> = junction
        .as_object()
        .expect("a node is an object")
        .keys()
        .collect();
    assert_eq!(node_members, vec!["coordinate", "degree", "id"]);

    assert_eq!(body["meta"]["segmentsReturned"], 1);
    assert_eq!(body["meta"]["nodesReturned"], 2);
    assert_eq!(body["meta"]["limit"], 1000);
    assert_eq!(body["meta"]["truncated"], false);
    assert!(body["meta"]["diagnostics"].is_null());
}

#[tokio::test]
async fn the_whole_topology_fixture_serialises_its_documented_totals() {
    let response = get(topology_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["meta"]["segmentsReturned"], 22);
    assert_eq!(response.body["meta"]["nodesReturned"], 31);
    assert_eq!(response.body["meta"]["truncated"], false);
    assert_eq!(
        string_array(&response.body["segments"], "id"),
        vec![
            "osm:way:601:segment:0",
            "osm:way:602:segment:0",
            "osm:way:603:segment:0",
            "osm:way:604:segment:0",
            "osm:way:605:segment:0",
            "osm:way:605:segment:1",
            "osm:way:606:segment:0",
            "osm:way:606:segment:1",
            "osm:way:607:segment:0",
            "osm:way:608:segment:0",
            "osm:way:609:segment:0",
            "osm:way:609:segment:1",
            "osm:way:609:segment:2",
            "osm:way:610:segment:0",
            "osm:way:611:segment:0",
            "osm:way:612:segment:0",
            "osm:way:612:segment:1",
            "osm:way:612:segment:2",
            "osm:way:613:segment:0",
            "osm:way:615:segment:0",
            "osm:way:616:segment:0",
            "osm:way:617:segment:0",
        ]
    );
}

#[tokio::test]
async fn topology_degrees_on_the_wire_match_the_fixture_table() {
    let response = get(topology_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    let nodes = response.body["nodes"]
        .as_array()
        .expect("nodes is an array");
    let degree = |id: &str| {
        nodes
            .iter()
            .find(|node| node["id"] == id)
            .unwrap_or_else(|| panic!("{id} is returned"))["degree"]
            .as_u64()
            .expect("degree is a number")
    };
    // T junction, shared-node cross, roundabout and the self-loop.
    assert_eq!(degree("osm:node:5"), 3);
    assert_eq!(degree("osm:node:9"), 4);
    assert_eq!(degree("osm:node:17"), 2);
    assert_eq!(degree("osm:node:18"), 3);
    assert_eq!(degree("osm:node:19"), 3);
    assert_eq!(degree("osm:node:23"), 4);
    // The geometric-only crossing and the shared-coordinate pair join nothing.
    for endpoint in ["13", "14", "15", "16", "34", "36", "37", "38"] {
        assert_eq!(degree(&format!("osm:node:{endpoint}")), 1);
    }
    // And the shape points never appear at all.
    for absent in ["2", "24", "27", "29", "30", "32", "35"] {
        let id = format!("osm:node:{absent}");
        assert!(
            !nodes.iter().any(|node| node["id"] == id),
            "{id} is a shape point and must not be a topology node"
        );
    }
}

#[tokio::test]
async fn topology_diagnostics_are_omitted_unless_requested() {
    let without = get(topology_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    assert!(without.body["meta"]["diagnostics"].is_null());

    let with = get(
        topology_state(),
        &topology_url(&format!("{TOPOLOGY_VIEWPORT}&include=diagnostics")),
    )
    .await;
    let diagnostics = &with.body["meta"]["diagnostics"];
    assert_eq!(diagnostics["segmentsExamined"], 22);
    assert_eq!(diagnostics["candidatesFound"], 22);
    assert_eq!(diagnostics["segmentsReturned"], 22);
    assert_eq!(diagnostics["nodesReturned"], 31);
    assert!(diagnostics["elapsedMs"].is_number());
    let members: Vec<&String> = diagnostics
        .as_object()
        .expect("diagnostics is an object")
        .keys()
        .collect();
    assert_eq!(
        members,
        vec![
            "candidatesFound",
            "elapsedMs",
            "nodesReturned",
            "segmentsExamined",
            "segmentsReturned"
        ]
    );
}

#[tokio::test]
async fn a_truncated_topology_response_still_resolves_every_segment_it_returns() {
    let response = get(
        topology_state(),
        &topology_url(&format!("{TOPOLOGY_VIEWPORT}&limit=5&include=diagnostics")),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["meta"]["segmentsReturned"], 5);
    assert_eq!(response.body["meta"]["limit"], 5);
    assert_eq!(response.body["meta"]["truncated"], true);
    // The scan reports the true match count, not the returned count.
    assert_eq!(response.body["meta"]["diagnostics"]["candidatesFound"], 22);

    let node_ids = string_array(&response.body["nodes"], "id");
    for segment in response.body["segments"]
        .as_array()
        .expect("segments is an array")
    {
        for end in ["startNodeId", "endNodeId"] {
            let id = segment[end].as_str().expect("an id is a string");
            assert!(
                node_ids.iter().any(|node| node == id),
                "segment {} names {id}, which the response must carry",
                segment["id"]
            );
        }
    }
}

#[tokio::test]
async fn topology_endpoints_outside_the_viewport_are_still_returned() {
    // A sliver over the middle of way 601 that contains neither of its ends.
    let response = get(
        topology_state(),
        &topology_url("bbox=51.3009,35.6009,51.3011,35.6011"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        string_array(&response.body["segments"], "id"),
        vec!["osm:way:601:segment:0"]
    );
    assert_eq!(
        string_array(&response.body["nodes"], "id"),
        vec!["osm:node:1", "osm:node:3"]
    );
    for node in response.body["nodes"]
        .as_array()
        .expect("nodes is an array")
    {
        let longitude = node["coordinate"][0].as_f64().expect("a number");
        assert!(
            !(51.3009..=51.3011).contains(&longitude),
            "this endpoint sits outside the requested box and is returned anyway"
        );
    }
}

#[tokio::test]
async fn a_reverse_one_way_segment_keeps_its_source_coordinate_order() {
    let response = get(
        topology_state(),
        &topology_url("bbox=51.379,35.599,51.385,35.603"),
    )
    .await;
    let segment = &response.body["segments"][0];
    assert_eq!(segment["id"], "osm:way:615:segment:0");
    assert_eq!(segment["startNodeId"], "osm:node:31");
    assert_eq!(segment["endNodeId"], "osm:node:33");
    assert_eq!(segment["geometry"]["coordinates"][0][0], 51.3800);
    assert_eq!(segment["geometry"]["coordinates"][2][0], 51.3840);

    // The road still publishes its reverse direction on the feature endpoint.
    let features = get(
        topology_state(),
        "/api/v1/map/features?bbox=51.379,35.599,51.385,35.603",
    )
    .await;
    let road = features.body["features"]
        .as_array()
        .expect("features is an array")
        .iter()
        .find(|feature| feature["id"] == "osm:way:615")
        .expect("way 615 is in the viewport");
    assert_eq!(
        road["properties"]["traversal"]["motorcar"]["direction"],
        "reverse"
    );
    // And its geometry is in the same source order as the segment.
    assert_eq!(road["geometry"]["coordinates"][0][0], 51.3800);
}

#[tokio::test]
async fn a_topology_segment_carries_no_road_semantics_and_no_raw_tags() {
    let response = get(topology_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    let serialised = response.body.to_string();

    for leaked in [
        "traversal",
        "roadClass",
        "access",
        "speedLimits",
        "direction",
        "oneway",
        "maxspeed",
        "highway",
        "junction",
        "barrier",
        "residential",
        "name",
        "source",
        "entityType",
        "openstreetmap",
    ] {
        assert!(
            !serialised.contains(leaked),
            "`{leaked}` must not appear in a topology response"
        );
    }

    // What it does carry is the join back to the road.
    for segment in response.body["segments"]
        .as_array()
        .expect("segments is an array")
    {
        assert!(
            segment["roadFeatureId"]
                .as_str()
                .expect("a road feature id")
                .starts_with("osm:way:")
        );
    }
}

#[tokio::test]
async fn topology_rejects_a_missing_or_invalid_bbox() {
    let missing = get(topology_state(), "/api/v1/map/topology").await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&missing.body), "INVALID_QUERY");
    assert_eq!(missing.body["error"]["details"]["parameter"], "bbox");

    for (query, code) in [
        ("bbox=0,0,1", "INVALID_QUERY"),
        ("bbox=0,0,1,abc", "INVALID_QUERY"),
        ("bbox=51.4,35.68,51.38,35.70", "INVALID_BOUNDING_BOX"),
        ("bbox=-181,0,10,10", "INVALID_BOUNDING_BOX"),
    ] {
        let response = get(topology_state(), &topology_url(query)).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(error_code(&response.body), code, "{query}");
    }
}

#[tokio::test]
async fn topology_rejects_bad_limits_unknown_parameters_and_unknown_includes() {
    for query in [
        format!("{TOPOLOGY_VIEWPORT}&limit=0"),
        format!("{TOPOLOGY_VIEWPORT}&limit=abc"),
        format!("{TOPOLOGY_VIEWPORT}&limit=5001"),
        format!("{TOPOLOGY_VIEWPORT}&zoom=12"),
        format!("{TOPOLOGY_VIEWPORT}&kind=road"),
        format!("{TOPOLOGY_VIEWPORT}&include=everything"),
        format!("{TOPOLOGY_VIEWPORT}&include=source"),
    ] {
        let response = get(topology_state(), &topology_url(&query)).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(error_code(&response.body), "INVALID_QUERY", "{query}");
    }

    // The documented maximum itself is accepted.
    let response = get(
        topology_state(),
        &topology_url(&format!("{TOPOLOGY_VIEWPORT}&limit=5000")),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["meta"]["limit"], 5000);
}

#[tokio::test]
async fn topology_honours_a_dataset_pin() {
    let state = topology_state();
    let active = get(state.clone(), "/api/v1/datasets/current").await.body["datasetId"]
        .as_str()
        .expect("a dataset id")
        .to_owned();

    let matching = get(
        state.clone(),
        &topology_url(&format!("{TOPOLOGY_VIEWPORT}&dataset={active}")),
    )
    .await;
    assert_eq!(matching.status, StatusCode::OK);
    assert_eq!(matching.body["datasetId"], active);

    let stale = get(
        state,
        &topology_url(&format!("{TOPOLOGY_VIEWPORT}&dataset=ds-gone")),
    )
    .await;
    assert_eq!(stale.status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&stale.body), "DATASET_NOT_FOUND");
    assert_eq!(stale.body["error"]["details"]["requested"], "ds-gone");
    assert_eq!(stale.body["error"]["details"]["active"], active);
}

#[tokio::test]
async fn topology_refuses_to_answer_before_a_dataset_is_published() {
    let loading = get(loading_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    assert_eq!(loading.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&loading.body), "DATASET_NOT_READY");
    assert_eq!(loading.body["error"]["details"]["datasetStatus"], "loading");

    let failed = get(failed_state(), &topology_url(TOPOLOGY_VIEWPORT)).await;
    assert_eq!(failed.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&failed.body), "DATASET_NOT_READY");
    assert_eq!(failed.body["error"]["details"]["datasetStatus"], "failed");
}

#[tokio::test]
async fn an_empty_viewport_answers_with_an_empty_graph_not_an_error() {
    let response = get(
        topology_state(),
        &topology_url("bbox=10.0,10.0,10.1,10.1&include=diagnostics"),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.body["segments"].as_array().map(Vec::len), Some(0));
    assert_eq!(response.body["nodes"].as_array().map(Vec::len), Some(0));
    assert_eq!(response.body["meta"]["truncated"], false);
    assert_eq!(response.body["meta"]["diagnostics"]["segmentsExamined"], 22);
    assert_eq!(response.body["meta"]["diagnostics"]["candidatesFound"], 0);
}

#[tokio::test]
async fn current_dataset_reports_the_final_topology_counts() {
    let response = get(topology_state(), "/api/v1/datasets/current").await;
    let statistics = &response.body["statistics"];

    // Final dataset counts, not source-element counters: 38 nodes were
    // indexed and 31 of them became topology nodes; 16 features were emitted
    // and they split into 22 segments.
    assert_eq!(statistics["nodesIndexed"], 38);
    assert_eq!(statistics["topologyNodes"], 31);
    assert_eq!(statistics["featuresEmitted"], 16);
    assert_eq!(statistics["featureCount"], 16);
    assert_eq!(statistics["topologySegments"], 22);
    assert_ne!(statistics["topologyNodes"], statistics["nodesIndexed"]);
    assert_ne!(statistics["topologySegments"], statistics["featureCount"]);
}

#[tokio::test]
async fn the_topology_fixture_reports_exactly_two_warnings() {
    let response = get(topology_state(), "/api/v1/datasets/current").await;
    let warnings = response.body["warnings"]
        .as_array()
        .expect("warnings is an array");
    let codes: Vec<&str> = warnings
        .iter()
        .map(|warning| warning["code"].as_str().expect("a code"))
        .collect();
    assert_eq!(
        codes,
        vec!["MISSING_NODE_REFERENCE", "UNSUPPORTED_RELATION"]
    );
    assert_eq!(warnings[0]["count"], 1);
    assert_eq!(warnings[0]["samples"][0], "way/614");
    assert_eq!(warnings[1]["count"], 1);
    assert_eq!(warnings[1]["samples"][0], "relation/700");
}

#[tokio::test]
async fn the_older_fixtures_gain_topology_counts_without_changing_anything_else() {
    // The Milestone 1 fixture's counters are exactly what they were; the two
    // topology counts are new members beside them, and the API version and
    // media type are unchanged.
    let response = get(ready_state(), "/api/v1/datasets/current").await;
    let statistics = &response.body["statistics"];
    assert_eq!(response.body["apiVersion"], "1");
    assert_eq!(statistics["nodesSeen"], 8);
    assert_eq!(statistics["nodesIndexed"], 7);
    assert_eq!(statistics["waysSeen"], 8);
    assert_eq!(statistics["roadWaysSelected"], 7);
    assert_eq!(statistics["featuresEmitted"], 4);
    assert_eq!(statistics["featuresSkipped"], 3);
    assert_eq!(statistics["relationsSeen"], 2);
    assert_eq!(statistics["featureCount"], 4);
    // Four roads sharing three nodes between them — 3 joins 101 to 106, 5
    // joins 102 to 105, and 6 joins 105 to 106 — so four segments over five
    // nodes rather than eight.
    assert_eq!(statistics["topologySegments"], 4);
    assert_eq!(statistics["topologyNodes"], 5);

    let features = get(ready_state(), &format!("/api/v1/map/features?{VIEWPORT}")).await;
    assert_eq!(features.status, StatusCode::OK);
    assert!(features.content_type.starts_with("application/geo+json"));
    assert_eq!(features.body["atlas"]["apiVersion"], "1");
    assert_eq!(features.body["type"], "FeatureCollection");
}
