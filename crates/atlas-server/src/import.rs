//! Startup import orchestration.
//!
//! The import runs off the request path entirely: the HTTP server starts
//! serving liveness and status immediately, and the dataset appears when, and
//! only if, the import finishes successfully.

use std::path::Path;
use std::sync::Arc;

use atlas_engine::{Dataset, DatasetBuilder, DatasetId, DatasetRegistry, ImportFailure, MapSource};
use atlas_osm::OsmXmlSource;

/// Imports one plain `.osm` file into an immutable dataset.
pub fn import_osm_file(path: &Path) -> Result<Dataset, ImportFailure> {
    let source = OsmXmlSource::from_path(path);
    let dataset_id = DatasetId::generate();
    let mut builder = DatasetBuilder::new(dataset_id, source.source_metadata());

    let outcome = source.import(&mut builder).map_err(|error| {
        // The error's detail can contain a file system path, so it is logged
        // and never returned to a client.
        tracing::error!(path = %path.display(), %error, "map source import failed");
        ImportFailure::from_error(&error)
    })?;

    builder.finish(outcome).map_err(|error| {
        tracing::error!(path = %path.display(), %error, "dataset could not be built");
        ImportFailure::new(
            "empty-dataset",
            "The configured map source contained no importable road features.",
        )
    })
}

/// Runs the import and publishes the result, or records why it failed.
pub fn import_and_publish(registry: &DatasetRegistry, path: &Path) {
    registry.mark_loading();
    match import_osm_file(path) {
        Ok(dataset) => {
            let report = dataset.report();
            tracing::info!(
                dataset_id = %dataset.id(),
                source = report.source_name(),
                features = report.feature_count(),
                elapsed_ms = report.elapsed().as_secs_f64() * 1000.0,
                warnings = report.issues().len(),
                "dataset published"
            );
            registry.publish(dataset);
        }
        Err(failure) => {
            tracing::error!(
                category = failure.category(),
                "import failed; the previously active dataset, if any, is untouched"
            );
            registry.mark_failed(failure);
        }
    }
}

/// Runs [`import_and_publish`] on a blocking task so the server can start now.
pub fn spawn_startup_import(registry: Arc<DatasetRegistry>, path: std::path::PathBuf) {
    tokio::task::spawn_blocking(move || import_and_publish(&registry, &path));
}
