//! Immutable datasets and the builder that produces them.

use std::fmt;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use atlas_kernel::{BoundingBox, MapFeature};

use crate::import::{
    Attribution, FeatureSink, ImportReport, SinkError, SourceImportOutcome, SourceMetadata,
};

/// An opaque dataset identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DatasetId(String);

impl DatasetId {
    /// Builds an identifier from an explicit value.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Builds a fresh identifier for a newly started import.
    ///
    /// The value is opaque; clients compare it for equality to notice that the
    /// active dataset changed, and never parse it.
    pub fn generate() -> Self {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since_epoch| since_epoch.as_millis());
        Self(format!("ds-{millis}"))
    }

    /// The identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DatasetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The lifecycle state of the registry's active dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatasetStatus {
    /// An import is running and no dataset can be queried yet.
    Loading,
    /// A dataset is published and queryable.
    Ready,
    /// The last import failed and no dataset is available.
    Failed,
}

impl DatasetStatus {
    /// The stable wire form of the status.
    pub fn as_str(self) -> &'static str {
        match self {
            DatasetStatus::Loading => "loading",
            DatasetStatus::Ready => "ready",
            DatasetStatus::Failed => "failed",
        }
    }

    /// Whether queries can be served in this state.
    pub fn is_ready(self) -> bool {
        matches!(self, DatasetStatus::Ready)
    }
}

impl fmt::Display for DatasetStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Why a dataset could not be finished.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DatasetBuildError {
    /// The build produced no features at all.
    #[error("the import produced no features, so there is nothing to publish")]
    NoFeatures,
}

/// An immutable, fully imported dataset.
///
/// A `Dataset` only ever exists in a finished state: it is produced by
/// [`DatasetBuilder::finish`] after an import has succeeded, and nothing
/// mutates it afterwards.
#[derive(Debug)]
pub struct Dataset {
    id: DatasetId,
    features: Vec<Arc<MapFeature>>,
    bounds: Option<BoundingBox>,
    report: ImportReport,
}

impl Dataset {
    /// The dataset identifier.
    pub fn id(&self) -> &DatasetId {
        &self.id
    }

    /// Every feature in the dataset, ordered deterministically by feature id.
    pub fn features(&self) -> &[Arc<MapFeature>] {
        &self.features
    }

    /// How many features the dataset holds.
    pub fn feature_count(&self) -> usize {
        self.features.len()
    }

    /// The bounds derived from the imported features.
    pub fn bounds(&self) -> Option<&BoundingBox> {
        self.bounds.as_ref()
    }

    /// The structured record of the import that produced this dataset.
    pub fn report(&self) -> &ImportReport {
        &self.report
    }

    /// Metadata about the source this dataset was imported from.
    pub fn source(&self) -> &SourceMetadata {
        self.report.source()
    }

    /// The attribution the source requires, if any.
    pub fn attribution(&self) -> Option<&Attribution> {
        self.report.source().attribution()
    }
}

/// The mutable staging area an import writes into.
///
/// The builder is the only mutable representation of a dataset. It implements
/// [`FeatureSink`], so importers stream into it, and it is consumed by
/// [`DatasetBuilder::finish`] to produce the immutable [`Dataset`].
#[derive(Debug)]
pub struct DatasetBuilder {
    id: DatasetId,
    source: SourceMetadata,
    features: Vec<Arc<MapFeature>>,
    bounds: Option<BoundingBox>,
    capacity: usize,
    started_at: Instant,
}

impl DatasetBuilder {
    /// The largest number of features one dataset may hold in this milestone.
    ///
    /// In-memory storage means an unbounded import could exhaust the process,
    /// so the builder fails loudly instead.
    pub const DEFAULT_CAPACITY: usize = 5_000_000;

    /// Starts a build for `id` from `source`.
    pub fn new(id: DatasetId, source: SourceMetadata) -> Self {
        Self::with_capacity(id, source, Self::DEFAULT_CAPACITY)
    }

    /// Starts a build with an explicit feature capacity.
    pub fn with_capacity(id: DatasetId, source: SourceMetadata, capacity: usize) -> Self {
        Self {
            id,
            source,
            features: Vec::new(),
            bounds: None,
            capacity,
            started_at: Instant::now(),
        }
    }

    /// The identifier the finished dataset will carry.
    pub fn id(&self) -> &DatasetId {
        &self.id
    }

    /// How many features have been accepted so far.
    pub fn accepted_count(&self) -> usize {
        self.features.len()
    }

    /// Consumes the builder and produces the immutable dataset.
    ///
    /// Features are sorted by identifier so that queries have a deterministic
    /// output order regardless of the order the source happened to emit them.
    pub fn finish(mut self, outcome: SourceImportOutcome) -> Result<Dataset, DatasetBuildError> {
        if self.features.is_empty() {
            return Err(DatasetBuildError::NoFeatures);
        }
        self.features
            .sort_by(|left, right| left.id().cmp(right.id()));
        let report = ImportReport::new(
            self.id.clone(),
            self.source,
            self.bounds,
            self.started_at.elapsed(),
            outcome.stats,
            outcome.issues,
            self.features.len(),
        );
        Ok(Dataset {
            id: self.id,
            features: self.features,
            bounds: self.bounds,
            report,
        })
    }
}

impl FeatureSink for DatasetBuilder {
    fn accept(&mut self, feature: MapFeature) -> Result<(), SinkError> {
        if self.features.len() >= self.capacity {
            return Err(SinkError::CapacityExceeded {
                capacity: self.capacity,
            });
        }
        self.bounds = Some(match self.bounds {
            Some(current) => current.union(feature.bounds()),
            None => *feature.bounds(),
        });
        self.features.push(Arc::new(feature));
        Ok(())
    }
}

/// A stable handle onto one published dataset.
///
/// Taking a snapshot clones a reference-counted pointer, so a query keeps
/// working on exactly the dataset it started with even if a newer dataset is
/// published half way through.
#[derive(Debug, Clone)]
pub struct DatasetSnapshot {
    dataset: Arc<Dataset>,
}

impl DatasetSnapshot {
    pub(crate) fn new(dataset: Arc<Dataset>) -> Self {
        Self { dataset }
    }

    /// The dataset this snapshot points at.
    pub fn dataset(&self) -> &Dataset {
        &self.dataset
    }

    /// The identifier of the snapshotted dataset.
    pub fn id(&self) -> &DatasetId {
        self.dataset.id()
    }

    /// Every feature in the snapshotted dataset.
    pub fn features(&self) -> &[Arc<MapFeature>] {
        self.dataset.features()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::Attribution;
    use crate::test_support::{metadata, outcome, residential};

    #[test]
    fn finish_rejects_an_empty_import() {
        let builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        assert!(matches!(
            builder.finish(outcome()),
            Err(DatasetBuildError::NoFeatures)
        ));
    }

    #[test]
    fn finish_sorts_features_by_id() {
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        for id in ["osm:way:3", "osm:way:1", "osm:way:2"] {
            builder
                .accept(residential(id, &[(0.0, 0.0), (1.0, 1.0)]))
                .expect("sink accepts");
        }
        let dataset = builder.finish(outcome()).expect("dataset builds");
        let ids: Vec<_> = dataset
            .features()
            .iter()
            .map(|feature| feature.id().as_str().to_owned())
            .collect();
        assert_eq!(ids, vec!["osm:way:1", "osm:way:2", "osm:way:3"]);
    }

    #[test]
    fn bounds_are_derived_from_accepted_features() {
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        builder
            .accept(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("sink accepts");
        builder
            .accept(residential("osm:way:2", &[(-3.0, 4.0), (2.0, 9.0)]))
            .expect("sink accepts");
        let dataset = builder.finish(outcome()).expect("dataset builds");
        let bounds = dataset.bounds().expect("bounds derived");
        assert_eq!(bounds.west(), -3.0);
        assert_eq!(bounds.south(), 0.0);
        assert_eq!(bounds.east(), 2.0);
        assert_eq!(bounds.north(), 9.0);
    }

    #[test]
    fn builder_enforces_its_capacity() {
        let mut builder = DatasetBuilder::with_capacity(DatasetId::new("ds-test"), metadata(), 1);
        builder
            .accept(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("first feature fits");
        assert_eq!(
            builder.accept(residential("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)])),
            Err(SinkError::CapacityExceeded { capacity: 1 })
        );
    }

    #[test]
    fn dataset_carries_report_and_attribution() {
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        builder
            .accept(residential("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("sink accepts");
        let dataset = builder.finish(outcome()).expect("dataset builds");
        assert_eq!(dataset.report().feature_count(), 1);
        assert_eq!(dataset.source().name(), "roads-basic.osm");
        assert_eq!(
            dataset.attribution().map(Attribution::text),
            Some("© OpenStreetMap contributors")
        );
    }

    #[test]
    fn generated_dataset_ids_are_opaque_but_present() {
        assert!(!DatasetId::generate().as_str().is_empty());
    }

    #[test]
    fn dataset_status_has_stable_wire_forms() {
        assert_eq!(DatasetStatus::Loading.as_str(), "loading");
        assert_eq!(DatasetStatus::Ready.as_str(), "ready");
        assert_eq!(DatasetStatus::Failed.as_str(), "failed");
        assert!(DatasetStatus::Ready.is_ready());
        assert!(!DatasetStatus::Loading.is_ready());
    }
}
