//! Immutable datasets and the builder that produces them.

use std::fmt;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use atlas_kernel::{BoundingBox, FeatureId, MapFeature};

use crate::import::{
    Attribution, FeatureSink, ImportReport, SinkError, SourceImportOutcome, SourceMetadata,
};
use crate::topology::{ImportedRoad, RoadPath, RoadTopology, derive_topology};

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
///
/// Every variant below the first describes an **impossible state**, not an
/// imperfection in the source. A file that names a node it never defined is
/// ordinary bad data and becomes a bounded warning on a skipped road; a road
/// path whose identity claims two different positions, or a segment pointing
/// at a node nobody built, means Atlas itself produced something incoherent.
/// Those fail the build outright rather than publishing a dataset whose
/// topology quietly disagrees with its features.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DatasetBuildError {
    /// The build produced no features at all.
    #[error("the import produced no features, so there is nothing to publish")]
    NoFeatures,
    /// One opaque point identity was seen at two different coordinates.
    #[error("point identity `{point}` was seen at two different coordinates")]
    ConflictingPointCoordinate {
        /// The identity that could not be resolved to one position.
        point: String,
    },
    /// Two topology nodes claimed the same public identifier.
    #[error("two topology nodes claim the id `{id}`")]
    DuplicateNodeId {
        /// The identifier that appeared twice.
        id: String,
    },
    /// Two topology segments claimed the same public identifier.
    #[error("two topology segments claim the id `{id}`")]
    DuplicateSegmentId {
        /// The identifier that appeared twice.
        id: String,
    },
    /// A segment referenced a node the topology does not hold.
    #[error("segment `{segment}` references node `{node}`, which was not built")]
    UnknownSegmentNode {
        /// The segment holding the dangling reference.
        segment: String,
        /// The node that does not exist.
        node: String,
    },
    /// A segment referenced a feature the dataset does not hold.
    #[error("segment `{segment}` belongs to feature `{feature}`, which is not in the dataset")]
    UnknownSegmentFeature {
        /// The segment holding the dangling reference.
        segment: String,
        /// The feature that does not exist.
        feature: String,
    },
    /// A topology value could not be constructed from the derived parts.
    #[error("a topology value could not be built: {detail}")]
    InvalidTopology {
        /// Internal detail, safe for logs but not for HTTP responses.
        detail: String,
    },
}

impl DatasetBuildError {
    /// A short, stable category name that is safe to show to API clients.
    ///
    /// The variants carry identifiers and parser detail, which belong in logs
    /// only, so the public answer says which *kind* of thing went wrong and
    /// nothing more.
    pub fn public_category(&self) -> &'static str {
        match self {
            DatasetBuildError::NoFeatures => "empty-dataset",
            _ => "topology-build-failed",
        }
    }

    /// A short, stable sentence that is safe to show to API clients.
    pub fn public_message(&self) -> &'static str {
        match self {
            DatasetBuildError::NoFeatures => {
                "The configured map source contained no importable road features."
            }
            _ => "The imported road topology could not be built.",
        }
    }
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
    topology: RoadTopology,
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

    /// The structural road topology derived from this dataset's roads.
    ///
    /// Published in the same step as the features, never separately: a client
    /// that can see a feature can already see the segments derived from it.
    pub fn topology(&self) -> &RoadTopology {
        &self.topology
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
    /// The import-time paths, kept only until `finish` derives the topology.
    paths: Vec<(FeatureId, RoadPath)>,
    topology_points: usize,
    bounds: Option<BoundingBox>,
    capacity: usize,
    topology_point_capacity: usize,
    started_at: Instant,
}

impl DatasetBuilder {
    /// The largest number of features one dataset may hold in this milestone.
    ///
    /// In-memory storage means an unbounded import could exhaust the process,
    /// so the builder fails loudly instead.
    pub const DEFAULT_CAPACITY: usize = 5_000_000;

    /// The largest number of road-path points one import may retain.
    ///
    /// A bound on features is not a bound on topology. Feature geometry is
    /// handed to the sink and forgotten, but path points are held for the
    /// whole import so that the cross-road occurrence count can be taken at
    /// `finish`, and one pathological way can carry tens of thousands of them.
    /// Ten points per feature is generous for real extracts and still puts a
    /// ceiling on what an import can retain.
    pub const DEFAULT_TOPOLOGY_POINT_CAPACITY: usize = 50_000_000;

    /// Starts a build for `id` from `source`.
    pub fn new(id: DatasetId, source: SourceMetadata) -> Self {
        Self::with_capacity(id, source, Self::DEFAULT_CAPACITY)
    }

    /// Starts a build with an explicit feature capacity.
    pub fn with_capacity(id: DatasetId, source: SourceMetadata, capacity: usize) -> Self {
        Self::with_capacities(id, source, capacity, Self::DEFAULT_TOPOLOGY_POINT_CAPACITY)
    }

    /// Starts a build with an explicit feature and topology-point capacity.
    pub fn with_capacities(
        id: DatasetId,
        source: SourceMetadata,
        capacity: usize,
        topology_point_capacity: usize,
    ) -> Self {
        Self {
            id,
            source,
            features: Vec::new(),
            paths: Vec::new(),
            topology_points: 0,
            bounds: None,
            capacity,
            topology_point_capacity,
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

    /// How many road-path points have been retained so far.
    pub fn topology_point_count(&self) -> usize {
        self.topology_points
    }

    /// Consumes the builder and produces the immutable dataset.
    ///
    /// Features are sorted by identifier so that queries have a deterministic
    /// output order regardless of the order the source happened to emit them.
    ///
    /// The topology is derived here, and here only, because this is the first
    /// moment every accepted road is known. Deciding whether a point is a
    /// junction needs the occurrence count across *all* roads, which no
    /// single-way pass can have. The import-time paths are dropped as soon as
    /// the derivation is done: nothing downstream may come to depend on them.
    ///
    /// Features and topology leave this method together, inside one `Dataset`.
    /// A topology that cannot be built takes the whole dataset with it rather
    /// than publishing features whose connectivity is missing or partial.
    pub fn finish(mut self, outcome: SourceImportOutcome) -> Result<Dataset, DatasetBuildError> {
        if self.features.is_empty() {
            return Err(DatasetBuildError::NoFeatures);
        }
        self.features
            .sort_by(|left, right| left.id().cmp(right.id()));
        let topology = derive_topology(&self.features, &self.paths)?;
        // The paths have done their job. Dropping them now is what makes them
        // import-time data rather than a second, quietly diverging geometry.
        self.paths = Vec::new();

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
            topology,
            bounds: self.bounds,
            report,
        })
    }
}

impl FeatureSink for DatasetBuilder {
    /// Accepts one road and its path as one indivisible unit.
    ///
    /// Both capacities are checked before anything is stored, so a rejected
    /// road leaves the builder exactly as it found it.
    fn accept(&mut self, road: ImportedRoad) -> Result<(), SinkError> {
        if self.features.len() >= self.capacity {
            return Err(SinkError::CapacityExceeded {
                capacity: self.capacity,
            });
        }
        // Checked, because the sum of two counts a caller controls is the one
        // place in this method where arithmetic can leave the range it is
        // being compared in. An overflow is not a different outcome from
        // exceeding the bound: a total that cannot be represented is
        // certainly larger than any capacity, so both answers are the same
        // atomic rejection.
        //
        // The checked total is kept rather than recomputed below. Adding the
        // points a second time after the gate would reintroduce the very
        // operation the gate exists to make safe, and would leave the stored
        // count and the checked count as two things that have to agree.
        let next_topology_points = match self.topology_points.checked_add(road.path().len()) {
            Some(total) if total <= self.topology_point_capacity => total,
            _ => {
                return Err(SinkError::TopologyCapacityExceeded {
                    capacity: self.topology_point_capacity,
                });
            }
        };

        // Every gate has passed, so from here the builder is mutated.
        let (feature, path) = road.into_parts();
        self.bounds = Some(match self.bounds {
            Some(current) => current.union(feature.bounds()),
            None => *feature.bounds(),
        });
        self.topology_points = next_topology_points;
        self.paths.push((feature.id().clone(), path));
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

    /// The topology of the snapshotted dataset.
    ///
    /// The same snapshot discipline as the features: a topology query keeps
    /// working on exactly the dataset it started with, so its segments can
    /// never be resolved against a newer dataset's features.
    pub fn topology(&self) -> &RoadTopology {
        self.dataset.topology()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::Attribution;
    use crate::test_support::{imported, imported_with_path, metadata, outcome};

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
                .accept(imported(id, &[(0.0, 0.0), (1.0, 1.0)]))
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
            .accept(imported("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("sink accepts");
        builder
            .accept(imported("osm:way:2", &[(-3.0, 4.0), (2.0, 9.0)]))
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
            .accept(imported("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
            .expect("first feature fits");
        assert_eq!(
            builder.accept(imported("osm:way:2", &[(0.0, 0.0), (1.0, 1.0)])),
            Err(SinkError::CapacityExceeded { capacity: 1 })
        );
    }

    #[test]
    fn builder_bounds_topology_points_separately_from_features() {
        // Feature capacity is generous and path-point capacity is not, which
        // is the case the second bound exists for: topology memory grows with
        // path points, and a dataset well inside its feature ceiling can still
        // be holding far too many of them.
        let mut builder =
            DatasetBuilder::with_capacities(DatasetId::new("ds-test"), metadata(), 1_000, 5);
        builder
            .accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)],
            ))
            .expect("three points fit");
        assert_eq!(builder.topology_point_count(), 3);

        // Two more would make five, which is the capacity, so they fit.
        builder
            .accept(imported_with_path(
                "osm:way:2",
                &[("n:4", 3.0, 3.0), ("n:5", 4.0, 4.0)],
            ))
            .expect("the capacity itself is allowed");
        assert_eq!(builder.topology_point_count(), 5);

        assert_eq!(
            builder.accept(imported_with_path(
                "osm:way:3",
                &[("n:6", 5.0, 5.0), ("n:7", 6.0, 6.0)]
            )),
            Err(SinkError::TopologyCapacityExceeded { capacity: 5 })
        );
        // A rejected road leaves the builder exactly as it found it: nothing
        // was half-stored on the way to the refusal.
        assert_eq!(builder.topology_point_count(), 5);
        assert_eq!(builder.accepted_count(), 2);
    }

    #[test]
    fn a_topology_point_total_that_would_overflow_is_rejected_atomically() {
        // The one case a `+` cannot survive: a running total so close to the
        // top of `usize` that one more path takes it over. The capacity here
        // is `usize::MAX`, so the bound itself is not what rejects this — the
        // sum is simply not representable, and `checked_add` says so. Plain
        // arithmetic would panic in a debug build and silently wrap to a tiny
        // number in a release one, which would *admit* the road.
        //
        // Reaching this state through `accept` would mean accepting
        // `usize::MAX - 1` points, so the field is set directly. This module
        // is a child of the one that declares it and can see it.
        let mut builder = DatasetBuilder::with_capacities(
            DatasetId::new("ds-test"),
            metadata(),
            1_000,
            usize::MAX,
        );
        builder.topology_points = usize::MAX - 1;

        let road = imported_with_path("osm:way:1", &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]);
        assert_eq!(
            builder.accept(road),
            Err(SinkError::TopologyCapacityExceeded {
                capacity: usize::MAX
            })
        );

        // Nothing moved. The rejection is atomic: the count did not advance,
        // no feature was stored, no path was retained, and no bounds were
        // widened by a road that was refused.
        assert_eq!(builder.topology_point_count(), usize::MAX - 1);
        assert_eq!(builder.accepted_count(), 0);
        assert!(builder.features.is_empty());
        assert!(builder.paths.is_empty());
        assert!(builder.bounds.is_none());
    }

    #[test]
    fn the_topology_point_capacity_is_compared_without_overflowing() {
        // The two ends of the ordinary range, where the sum is representable
        // and the bound itself is what decides.
        //
        // At the top: a capacity of `usize::MAX` accepts, because the sum is
        // representable and within the bound. A saturating sum could not tell
        // that apart from the overflow case above.
        let mut generous =
            DatasetBuilder::with_capacities(DatasetId::new("ds-test"), metadata(), 10, usize::MAX);
        generous
            .accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)],
            ))
            .expect("a representable total within an enormous capacity fits");
        assert_eq!(generous.topology_point_count(), 2);
        assert_eq!(generous.accepted_count(), 1);

        // At the bottom: a capacity of zero admits nothing, because a path
        // always carries at least two points.
        let mut none =
            DatasetBuilder::with_capacities(DatasetId::new("ds-test"), metadata(), 10, 0);
        assert_eq!(
            none.accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)]
            )),
            Err(SinkError::TopologyCapacityExceeded { capacity: 0 })
        );
        assert_eq!(none.topology_point_count(), 0);
        assert_eq!(none.accepted_count(), 0);
        assert!(none.bounds.is_none());
    }

    #[test]
    fn the_topology_point_capacity_has_a_documented_default() {
        assert_eq!(DatasetBuilder::DEFAULT_TOPOLOGY_POINT_CAPACITY, 50_000_000);
        let builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        assert_eq!(builder.topology_point_count(), 0);
    }

    #[test]
    fn features_and_topology_are_published_in_one_dataset() {
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        builder
            .accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)],
            ))
            .expect("sink accepts");
        builder
            .accept(imported_with_path(
                "osm:way:2",
                &[("n:2", 1.0, 1.0), ("n:3", 2.0, 2.0)],
            ))
            .expect("sink accepts");

        let dataset = builder.finish(outcome()).expect("dataset builds");
        assert_eq!(dataset.feature_count(), 2);
        assert_eq!(dataset.topology().segment_count(), 2);
        assert_eq!(dataset.topology().node_count(), 3);
        // Every segment names a feature this same dataset holds. There is no
        // window in which one exists without the other.
        for segment in dataset.topology().segments() {
            assert!(
                dataset
                    .features()
                    .iter()
                    .any(|feature| feature.id() == segment.road()),
                "segment {} must belong to a feature of this dataset",
                segment.id()
            );
        }
    }

    #[test]
    fn a_topology_failure_takes_the_whole_dataset_with_it() {
        // One identity claiming two positions. The features are all perfectly
        // valid, and none of them is published: a dataset whose topology could
        // not be derived is not a dataset with missing topology, it is not a
        // dataset at all.
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        builder
            .accept(imported_with_path(
                "osm:way:1",
                &[("n:1", 0.0, 0.0), ("n:2", 1.0, 1.0)],
            ))
            .expect("sink accepts");
        builder
            .accept(imported_with_path(
                "osm:way:2",
                &[("n:2", 9.0, 9.0), ("n:3", 2.0, 2.0)],
            ))
            .expect("sink accepts");

        let error = builder
            .finish(outcome())
            .expect_err("the topology cannot be derived");
        assert_eq!(
            error,
            DatasetBuildError::ConflictingPointCoordinate {
                point: "n:2".to_owned()
            }
        );
    }

    #[test]
    fn build_failures_expose_safe_public_text_only() {
        // The detail names an internal identifier, so it stays in the logs.
        let topology = DatasetBuildError::ConflictingPointCoordinate {
            point: "osm:node:42".to_owned(),
        };
        assert_eq!(topology.public_category(), "topology-build-failed");
        assert_eq!(
            topology.public_message(),
            "The imported road topology could not be built."
        );
        assert!(!topology.public_message().contains("osm:node:42"));
        assert!(topology.to_string().contains("osm:node:42"));

        // The pre-existing empty-dataset wording is untouched: a client that
        // already recognises it keeps recognising it.
        assert_eq!(
            DatasetBuildError::NoFeatures.public_category(),
            "empty-dataset"
        );
        assert_eq!(
            DatasetBuildError::NoFeatures.public_message(),
            "The configured map source contained no importable road features."
        );

        for error in [
            DatasetBuildError::DuplicateNodeId {
                id: "osm:node:1".to_owned(),
            },
            DatasetBuildError::DuplicateSegmentId {
                id: "osm:way:1:segment:0".to_owned(),
            },
            DatasetBuildError::UnknownSegmentNode {
                segment: "osm:way:1:segment:0".to_owned(),
                node: "osm:node:9".to_owned(),
            },
            DatasetBuildError::UnknownSegmentFeature {
                segment: "osm:way:1:segment:0".to_owned(),
                feature: "osm:way:1".to_owned(),
            },
            DatasetBuildError::InvalidTopology {
                detail: "a road node id must not be blank".to_owned(),
            },
        ] {
            assert_eq!(error.public_category(), "topology-build-failed");
            assert_eq!(
                error.public_message(),
                "The imported road topology could not be built."
            );
        }
    }

    #[test]
    fn dataset_carries_report_and_attribution() {
        let mut builder = DatasetBuilder::new(DatasetId::new("ds-test"), metadata());
        builder
            .accept(imported("osm:way:1", &[(0.0, 0.0), (1.0, 1.0)]))
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
