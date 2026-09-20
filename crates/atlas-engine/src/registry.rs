//! Atomic publication of the active dataset.

use std::sync::{Arc, PoisonError, RwLock};

use crate::dataset::{Dataset, DatasetId, DatasetSnapshot, DatasetStatus};
use crate::import::ImportError;

/// Why the last import failed, in a form that is safe to show to clients.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFailure {
    category: String,
    message: String,
}

impl ImportFailure {
    /// Builds a failure record from an import error, dropping its detail.
    pub fn from_error(error: &ImportError) -> Self {
        Self {
            category: error.public_category().to_owned(),
            message: error.public_message().to_owned(),
        }
    }

    /// Builds a failure record from explicit strings.
    pub fn new(category: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            category: category.into(),
            message: message.into(),
        }
    }

    /// A short stable category, for example `malformed-source`.
    pub fn category(&self) -> &str {
        &self.category
    }

    /// A short sentence describing the failure, free of internals.
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Debug, Default)]
struct RegistryState {
    active: Option<Arc<Dataset>>,
    importing: bool,
    last_failure: Option<ImportFailure>,
}

/// Holds the dataset Atlas is currently serving.
///
/// Publication is atomic: a dataset becomes visible in one step, after its
/// import has fully succeeded. A later failed import records its failure but
/// leaves the previously published dataset in place and queryable.
#[derive(Debug)]
pub struct DatasetRegistry {
    state: RwLock<RegistryState>,
}

impl DatasetRegistry {
    /// Builds an empty registry that reports itself as loading.
    pub fn new() -> Self {
        Self {
            state: RwLock::new(RegistryState {
                active: None,
                importing: true,
                last_failure: None,
            }),
        }
    }

    /// Builds an empty registry that is not importing anything yet.
    pub fn idle() -> Self {
        Self {
            state: RwLock::new(RegistryState::default()),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, RegistryState> {
        // A poisoned lock means some other thread panicked while holding it.
        // The registry's invariants do not depend on that thread having
        // finished, so recovering is safer than propagating a panic into an
        // HTTP handler.
        self.state.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, RegistryState> {
        self.state.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records that an import has started.
    pub fn mark_loading(&self) {
        let mut state = self.write();
        state.importing = true;
    }

    /// Publishes `dataset` as the active dataset, atomically.
    pub fn publish(&self, dataset: Dataset) {
        let mut state = self.write();
        state.active = Some(Arc::new(dataset));
        state.importing = false;
        state.last_failure = None;
    }

    /// Records that an import failed, leaving any active dataset untouched.
    pub fn mark_failed(&self, failure: ImportFailure) {
        let mut state = self.write();
        state.importing = false;
        state.last_failure = Some(failure);
    }

    /// The status a client should see.
    ///
    /// A dataset that is published stays `Ready` even if a later import fails,
    /// because queries against it still work.
    pub fn status(&self) -> DatasetStatus {
        let state = self.read();
        if state.active.is_some() {
            DatasetStatus::Ready
        } else if state.importing {
            DatasetStatus::Loading
        } else if state.last_failure.is_some() {
            DatasetStatus::Failed
        } else {
            DatasetStatus::Loading
        }
    }

    /// Whether a dataset is published and queryable.
    pub fn is_ready(&self) -> bool {
        self.read().active.is_some()
    }

    /// A stable handle onto the active dataset, if there is one.
    pub fn snapshot(&self) -> Option<DatasetSnapshot> {
        self.read().active.as_ref().map(|dataset| {
            // Cloning the Arc detaches the caller from later publications.
            DatasetSnapshot::new(Arc::clone(dataset))
        })
    }

    /// The identifier of the active dataset, if there is one.
    pub fn active_id(&self) -> Option<DatasetId> {
        self.read()
            .active
            .as_ref()
            .map(|dataset| dataset.id().clone())
    }

    /// The failure recorded by the most recent unsuccessful import, if any.
    pub fn last_failure(&self) -> Option<ImportFailure> {
        self.read().last_failure.clone()
    }
}

impl Default for DatasetRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::DatasetBuilder;
    use crate::import::FeatureSink;
    use crate::test_support::{metadata, outcome, residential};

    fn dataset(id: &str, feature_id: &str) -> Dataset {
        let mut builder = DatasetBuilder::new(DatasetId::new(id), metadata());
        builder
            .accept(residential(feature_id, &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("sink accepts");
        builder.finish(outcome()).expect("dataset builds")
    }

    #[test]
    fn a_fresh_registry_is_loading_and_not_ready() {
        let registry = DatasetRegistry::new();
        assert_eq!(registry.status(), DatasetStatus::Loading);
        assert!(!registry.is_ready());
        assert!(registry.snapshot().is_none());
    }

    #[test]
    fn nothing_is_visible_before_a_successful_finish() {
        let registry = DatasetRegistry::new();
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-1"), metadata());
        builder
            .accept(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("sink accepts");
        // The builder holds a feature, but nothing was published yet.
        assert!(registry.snapshot().is_none());
        assert_eq!(registry.status(), DatasetStatus::Loading);

        registry.publish(builder.finish(outcome()).expect("dataset builds"));
        assert_eq!(registry.status(), DatasetStatus::Ready);
        assert_eq!(
            registry.snapshot().expect("snapshot").id(),
            &DatasetId::new("ds-1")
        );
    }

    #[test]
    fn a_failed_first_import_reports_failed() {
        let registry = DatasetRegistry::new();
        registry.mark_failed(ImportFailure::from_error(&ImportError::MalformedSource {
            detail: "unexpected end of file at byte 12".to_owned(),
        }));
        assert_eq!(registry.status(), DatasetStatus::Failed);
        assert!(!registry.is_ready());
        let failure = registry.last_failure().expect("failure recorded");
        assert_eq!(failure.category(), "malformed-source");
        assert!(!failure.message().contains("byte 12"));
    }

    #[test]
    fn a_failed_import_does_not_replace_an_active_dataset() {
        let registry = DatasetRegistry::new();
        registry.publish(dataset("ds-1", "osm:way:1"));

        registry.mark_loading();
        assert_eq!(registry.status(), DatasetStatus::Ready);
        registry.mark_failed(ImportFailure::new("malformed-source", "broken"));

        assert_eq!(registry.status(), DatasetStatus::Ready);
        assert!(registry.is_ready());
        assert_eq!(
            registry.snapshot().expect("snapshot").id(),
            &DatasetId::new("ds-1")
        );
        assert_eq!(
            registry
                .last_failure()
                .expect("failure recorded")
                .category(),
            "malformed-source"
        );
    }

    #[test]
    fn an_existing_snapshot_stays_usable_while_a_new_dataset_is_published() {
        let registry = DatasetRegistry::new();
        registry.publish(dataset("ds-1", "osm:way:1"));
        let snapshot = registry.snapshot().expect("snapshot");

        registry.publish(dataset("ds-2", "osm:way:2"));

        assert_eq!(snapshot.id(), &DatasetId::new("ds-1"));
        assert_eq!(snapshot.features().len(), 1);
        assert_eq!(snapshot.features()[0].id().as_str(), "osm:way:1");
        assert_eq!(
            registry.snapshot().expect("snapshot").id(),
            &DatasetId::new("ds-2")
        );
    }

    #[test]
    fn publishing_clears_a_previous_failure() {
        let registry = DatasetRegistry::new();
        registry.mark_failed(ImportFailure::new("malformed-source", "broken"));
        registry.publish(dataset("ds-1", "osm:way:1"));
        assert!(registry.last_failure().is_none());
        assert_eq!(registry.active_id(), Some(DatasetId::new("ds-1")));
    }

    #[test]
    fn an_idle_registry_is_not_importing() {
        let registry = DatasetRegistry::idle();
        assert_eq!(registry.status(), DatasetStatus::Loading);
        assert!(registry.last_failure().is_none());
    }
}
