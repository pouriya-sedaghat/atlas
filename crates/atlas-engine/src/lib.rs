#![forbid(unsafe_code)]

//! The Atlas application layer.
//!
//! The engine owns the use cases that sit between the domain kernel and the
//! outside world: importing a map source into an immutable dataset, publishing
//! that dataset atomically, and answering viewport queries against it.
//!
//! It depends on [`atlas_kernel`] and on nothing else. In particular it knows
//! nothing about OpenStreetMap, HTTP or JSON.

mod dataset;
mod import;
mod query;
mod registry;
#[cfg(test)]
mod test_support;

pub use dataset::{
    Dataset, DatasetBuildError, DatasetBuilder, DatasetId, DatasetSnapshot, DatasetStatus,
};
pub use import::{
    Attribution, FeatureSink, ImportError, ImportReport, ImportStats, IssueCode, IssueGroup,
    IssueLog, MapSource, SinkError, SourceImportOutcome, SourceMetadata,
};
pub use query::{
    DEFAULT_FEATURE_LIMIT, FeatureFilter, FeatureKindFilter, MAX_FEATURE_LIMIT, MapFeatureQuery,
    MapQuery, MapQueryResult, QueryDiagnostics, QueryError,
};
pub use registry::{DatasetRegistry, ImportFailure};
