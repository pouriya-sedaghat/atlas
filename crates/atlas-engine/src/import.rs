//! Import contracts shared by every map source adapter.

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use atlas_kernel::{BoundingBox, MapFeature};

use crate::dataset::DatasetId;

/// Why a feature could not be accepted by a sink.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SinkError {
    /// The sink is already full.
    #[error("the feature sink reached its capacity of {capacity} features")]
    CapacityExceeded {
        /// The capacity that was hit.
        capacity: usize,
    },
}

/// Why an import failed as a whole.
///
/// Import failures are fatal for one import run. They never take down an
/// already published dataset.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImportError {
    /// The source could not be opened or read.
    #[error("the map source could not be read: {detail}")]
    SourceUnavailable {
        /// Adapter-supplied detail, safe for logs but not for HTTP responses.
        detail: String,
    },
    /// The source was readable but not parseable.
    #[error("the map source is malformed: {detail}")]
    MalformedSource {
        /// Adapter-supplied detail, safe for logs but not for HTTP responses.
        detail: String,
    },
    /// The destination sink rejected a feature.
    #[error(transparent)]
    Sink(#[from] SinkError),
}

impl ImportError {
    /// A short, stable category name that is safe to show to API clients.
    ///
    /// The `detail` payloads may contain file paths or parser internals, so
    /// they belong in logs only.
    pub fn public_category(&self) -> &'static str {
        match self {
            ImportError::SourceUnavailable { .. } => "source-unavailable",
            ImportError::MalformedSource { .. } => "malformed-source",
            ImportError::Sink(_) => "sink-rejected",
        }
    }

    /// A short, stable sentence that is safe to show to API clients.
    pub fn public_message(&self) -> &'static str {
        match self {
            ImportError::SourceUnavailable { .. } => "The configured map source could not be read.",
            ImportError::MalformedSource { .. } => "The configured map source is malformed.",
            ImportError::Sink(_) => "The dataset builder rejected the imported features.",
        }
    }
}

/// Where an importer streams the features it produces.
///
/// Sinks exist so that an importer never has to materialise one giant
/// `Vec<MapFeature>`: it emits features one at a time as it parses them.
pub trait FeatureSink {
    /// Accepts one feature.
    fn accept(&mut self, feature: MapFeature) -> Result<(), SinkError>;
}

/// A source of map features, such as a file in some external format.
pub trait MapSource {
    /// A short human-readable name for the source, for example a file name.
    ///
    /// This must not leak absolute paths: it ends up in API responses.
    fn source_name(&self) -> &str;

    /// Metadata describing the source, including its attribution requirements.
    fn source_metadata(&self) -> SourceMetadata;

    /// Streams every feature the source contains into `sink`.
    fn import(&self, sink: &mut dyn FeatureSink) -> Result<SourceImportOutcome, ImportError>;
}

/// Legal attribution that must be displayed alongside a dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    text: String,
    license_url: String,
}

impl Attribution {
    /// Builds an attribution record.
    pub fn new(text: impl Into<String>, license_url: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            license_url: license_url.into(),
        }
    }

    /// The attribution text, for example `© OpenStreetMap contributors`.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The licence URL clients should link to.
    pub fn license_url(&self) -> &str {
        &self.license_url
    }
}

/// Descriptive metadata about where a dataset came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMetadata {
    name: String,
    format: String,
    attribution: Option<Attribution>,
}

impl SourceMetadata {
    /// Builds source metadata.
    pub fn new(
        name: impl Into<String>,
        format: impl Into<String>,
        attribution: Option<Attribution>,
    ) -> Self {
        Self {
            name: name.into(),
            format: format.into(),
            attribution,
        }
    }

    /// The display name of the source, typically a bare file name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The source format, for example `osm-xml`.
    pub fn format(&self) -> &str {
        &self.format
    }

    /// The attribution the source requires, if any.
    pub fn attribution(&self) -> Option<&Attribution> {
        self.attribution.as_ref()
    }
}

/// Stable codes for the problems an import can report.
///
/// Codes are part of the public contract: clients group and display by them, so
/// they are added to rather than renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IssueCode {
    /// A coordinate was missing, non-numeric or outside the valid range.
    InvalidCoordinate,
    /// A way referenced a node that the source never defined.
    MissingNodeReference,
    /// A geometry ended up with fewer coordinates than it needs.
    TooFewCoordinates,
    /// A road classification Atlas does not model explicitly was preserved.
    UnknownHighwayClass,
    /// An entity was structurally broken, for example a missing identifier.
    MalformedEntity,
    /// A relation was counted but deliberately not interpreted.
    UnsupportedRelation,
    /// A direction value was present but is not one Atlas understands.
    UnknownOnewayValue,
    /// A plain direction value did not say which modes it applies to.
    AmbiguousOnewayScope,
    /// A direction that depends on a condition Atlas does not evaluate.
    UnsupportedConditionalOneway,
    /// An access value was present but is not one Atlas understands.
    UnknownAccessValue,
    /// An access value was used on a key where it cannot mean what it says.
    InvalidAccessScope,
    /// An access rule that depends on a condition Atlas does not evaluate.
    UnsupportedConditionalAccess,
}

impl IssueCode {
    /// The stable wire form of the code.
    pub fn as_str(self) -> &'static str {
        match self {
            IssueCode::InvalidCoordinate => "INVALID_COORDINATE",
            IssueCode::MissingNodeReference => "MISSING_NODE_REFERENCE",
            IssueCode::TooFewCoordinates => "TOO_FEW_COORDINATES",
            IssueCode::UnknownHighwayClass => "UNKNOWN_HIGHWAY_CLASS",
            IssueCode::MalformedEntity => "MALFORMED_ENTITY",
            IssueCode::UnsupportedRelation => "UNSUPPORTED_RELATION",
            IssueCode::UnknownOnewayValue => "UNKNOWN_ONEWAY_VALUE",
            IssueCode::AmbiguousOnewayScope => "AMBIGUOUS_ONEWAY_SCOPE",
            IssueCode::UnsupportedConditionalOneway => "UNSUPPORTED_CONDITIONAL_ONEWAY",
            IssueCode::UnknownAccessValue => "UNKNOWN_ACCESS_VALUE",
            IssueCode::InvalidAccessScope => "INVALID_ACCESS_SCOPE",
            IssueCode::UnsupportedConditionalAccess => "UNSUPPORTED_CONDITIONAL_ACCESS",
        }
    }
}

impl fmt::Display for IssueCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Everything recorded about one issue code during an import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueGroup {
    code: IssueCode,
    count: u64,
    samples: Vec<String>,
}

impl IssueGroup {
    /// The code this group describes.
    pub fn code(&self) -> IssueCode {
        self.code
    }

    /// How many times the issue occurred in total.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// A bounded sample of the affected entity identifiers.
    pub fn samples(&self) -> &[String] {
        &self.samples
    }
}

/// A bounded log of import issues.
///
/// Warning lists are never unbounded: for each code Atlas keeps the total count
/// plus a small sample of affected entity identifiers, so a pathological input
/// file cannot exhaust memory through warnings alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueLog {
    max_samples: usize,
    groups: BTreeMap<IssueCode, IssueGroup>,
}

impl IssueLog {
    /// How many sample identifiers are retained per code by default.
    pub const DEFAULT_MAX_SAMPLES: usize = 5;

    /// Builds a log retaining [`Self::DEFAULT_MAX_SAMPLES`] samples per code.
    pub fn new() -> Self {
        Self::with_max_samples(Self::DEFAULT_MAX_SAMPLES)
    }

    /// Builds a log retaining at most `max_samples` samples per code.
    pub fn with_max_samples(max_samples: usize) -> Self {
        Self {
            max_samples,
            groups: BTreeMap::new(),
        }
    }

    /// Records one occurrence of `code` for `entity_id`.
    pub fn record(&mut self, code: IssueCode, entity_id: impl Into<String>) {
        let max_samples = self.max_samples;
        let group = self.groups.entry(code).or_insert_with(|| IssueGroup {
            code,
            count: 0,
            samples: Vec::new(),
        });
        group.count += 1;
        if group.samples.len() < max_samples {
            group.samples.push(entity_id.into());
        }
    }

    /// The groups, ordered deterministically by code.
    pub fn groups(&self) -> impl Iterator<Item = &IssueGroup> {
        self.groups.values()
    }

    /// How many distinct codes were recorded.
    pub fn len(&self) -> usize {
        self.groups.len()
    }

    /// Whether no issue was recorded at all.
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    /// The total occurrence count for one code.
    pub fn count_of(&self, code: IssueCode) -> u64 {
        self.groups.get(&code).map_or(0, IssueGroup::count)
    }

    /// The retained samples for one code.
    pub fn samples_of(&self, code: IssueCode) -> &[String] {
        self.groups.get(&code).map_or(&[], IssueGroup::samples)
    }
}

impl Default for IssueLog {
    fn default() -> Self {
        Self::new()
    }
}

/// Counters an importer maintains while it reads a source.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ImportStats {
    /// How many node elements were encountered.
    pub nodes_seen: u64,
    /// How many nodes had usable coordinates and entered the node index.
    pub nodes_indexed: u64,
    /// How many way elements were encountered.
    pub ways_seen: u64,
    /// How many ways were selected as roads.
    pub road_ways_selected: u64,
    /// How many features were emitted into the sink.
    pub features_emitted: u64,
    /// How many selected roads were skipped because of a problem.
    pub features_skipped: u64,
    /// How many relation elements were counted.
    pub relations_seen: u64,
    /// How many bytes of source were read, when the adapter can tell.
    pub bytes_read: Option<u64>,
}

/// What an importer returns once it has streamed every feature it found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceImportOutcome {
    /// The counters collected during the run.
    pub stats: ImportStats,
    /// The bounded issue log collected during the run.
    pub issues: IssueLog,
}

/// The full, structured record of one import run.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportReport {
    dataset_id: DatasetId,
    source: SourceMetadata,
    bounds: Option<BoundingBox>,
    elapsed: Duration,
    stats: ImportStats,
    issues: IssueLog,
    feature_count: usize,
}

impl ImportReport {
    pub(crate) fn new(
        dataset_id: DatasetId,
        source: SourceMetadata,
        bounds: Option<BoundingBox>,
        elapsed: Duration,
        stats: ImportStats,
        issues: IssueLog,
        feature_count: usize,
    ) -> Self {
        Self {
            dataset_id,
            source,
            bounds,
            elapsed,
            stats,
            issues,
            feature_count,
        }
    }

    /// The dataset the import produced.
    pub fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    /// The display name of the source.
    pub fn source_name(&self) -> &str {
        self.source.name()
    }

    /// The full source metadata.
    pub fn source(&self) -> &SourceMetadata {
        &self.source
    }

    /// The bounds derived from the features that were actually imported.
    pub fn bounds(&self) -> Option<&BoundingBox> {
        self.bounds.as_ref()
    }

    /// How long the import took.
    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }

    /// The counters collected during the run.
    pub fn stats(&self) -> &ImportStats {
        &self.stats
    }

    /// The bounded issue log collected during the run.
    pub fn issues(&self) -> &IssueLog {
        &self.issues
    }

    /// How many features the resulting dataset holds.
    pub fn feature_count(&self) -> usize {
        self.feature_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_codes_have_stable_wire_forms() {
        assert_eq!(IssueCode::InvalidCoordinate.as_str(), "INVALID_COORDINATE");
        assert_eq!(
            IssueCode::MissingNodeReference.as_str(),
            "MISSING_NODE_REFERENCE"
        );
        assert_eq!(IssueCode::TooFewCoordinates.as_str(), "TOO_FEW_COORDINATES");
        assert_eq!(
            IssueCode::UnknownHighwayClass.as_str(),
            "UNKNOWN_HIGHWAY_CLASS"
        );
        assert_eq!(IssueCode::MalformedEntity.as_str(), "MALFORMED_ENTITY");
        assert_eq!(
            IssueCode::UnsupportedRelation.as_str(),
            "UNSUPPORTED_RELATION"
        );
        assert_eq!(
            IssueCode::UnknownOnewayValue.as_str(),
            "UNKNOWN_ONEWAY_VALUE"
        );
        assert_eq!(
            IssueCode::AmbiguousOnewayScope.as_str(),
            "AMBIGUOUS_ONEWAY_SCOPE"
        );
        assert_eq!(
            IssueCode::UnsupportedConditionalOneway.as_str(),
            "UNSUPPORTED_CONDITIONAL_ONEWAY"
        );
        assert_eq!(
            IssueCode::UnknownAccessValue.as_str(),
            "UNKNOWN_ACCESS_VALUE"
        );
        assert_eq!(
            IssueCode::InvalidAccessScope.as_str(),
            "INVALID_ACCESS_SCOPE"
        );
        assert_eq!(
            IssueCode::UnsupportedConditionalAccess.as_str(),
            "UNSUPPORTED_CONDITIONAL_ACCESS"
        );
    }

    #[test]
    fn access_codes_sort_after_every_earlier_code() {
        // Group order is the declaration order of the codes. The access codes
        // were appended, so a client that already groups by code sees its
        // existing warnings in exactly the order it saw them before.
        let mut log = IssueLog::new();
        log.record(IssueCode::UnsupportedConditionalAccess, "way/418");
        log.record(IssueCode::UnknownOnewayValue, "way/311");
        log.record(IssueCode::InvalidAccessScope, "way/423");
        log.record(IssueCode::InvalidCoordinate, "node/1");
        log.record(IssueCode::UnknownAccessValue, "way/417");
        log.record(IssueCode::UnsupportedConditionalOneway, "way/313");
        let codes: Vec<_> = log.groups().map(IssueGroup::code).collect();
        assert_eq!(
            codes,
            vec![
                IssueCode::InvalidCoordinate,
                IssueCode::UnknownOnewayValue,
                IssueCode::UnsupportedConditionalOneway,
                IssueCode::UnknownAccessValue,
                IssueCode::InvalidAccessScope,
                IssueCode::UnsupportedConditionalAccess,
            ]
        );
    }

    #[test]
    fn direction_codes_sort_after_the_milestone_one_codes() {
        // Group order is the declaration order of the codes, so an added code
        // must not reshuffle the warnings a Milestone 1 client already sees.
        let mut log = IssueLog::new();
        log.record(IssueCode::UnsupportedConditionalOneway, "way/3");
        log.record(IssueCode::UnknownOnewayValue, "way/1");
        log.record(IssueCode::UnsupportedRelation, "relation/1");
        log.record(IssueCode::AmbiguousOnewayScope, "way/2");
        log.record(IssueCode::InvalidCoordinate, "node/1");
        let codes: Vec<_> = log.groups().map(IssueGroup::code).collect();
        assert_eq!(
            codes,
            vec![
                IssueCode::InvalidCoordinate,
                IssueCode::UnsupportedRelation,
                IssueCode::UnknownOnewayValue,
                IssueCode::AmbiguousOnewayScope,
                IssueCode::UnsupportedConditionalOneway,
            ]
        );
    }

    #[test]
    fn issue_log_counts_everything_but_samples_are_bounded() {
        let mut log = IssueLog::with_max_samples(3);
        for index in 0..100 {
            log.record(IssueCode::MissingNodeReference, format!("way/{index}"));
        }
        assert_eq!(log.count_of(IssueCode::MissingNodeReference), 100);
        assert_eq!(
            log.samples_of(IssueCode::MissingNodeReference),
            &["way/0".to_owned(), "way/1".to_owned(), "way/2".to_owned()]
        );
    }

    #[test]
    fn issue_log_groups_are_ordered_deterministically() {
        let mut log = IssueLog::new();
        log.record(IssueCode::UnsupportedRelation, "relation/1");
        log.record(IssueCode::InvalidCoordinate, "node/1");
        log.record(IssueCode::TooFewCoordinates, "way/1");
        let codes: Vec<_> = log.groups().map(IssueGroup::code).collect();
        assert_eq!(
            codes,
            vec![
                IssueCode::InvalidCoordinate,
                IssueCode::TooFewCoordinates,
                IssueCode::UnsupportedRelation,
            ]
        );
    }

    #[test]
    fn empty_log_reports_zero_counts() {
        let log = IssueLog::new();
        assert!(log.is_empty());
        assert_eq!(log.len(), 0);
        assert_eq!(log.count_of(IssueCode::MalformedEntity), 0);
        assert!(log.samples_of(IssueCode::MalformedEntity).is_empty());
    }

    #[test]
    fn import_errors_expose_safe_public_text_only() {
        let error = ImportError::SourceUnavailable {
            detail: "/home/someone/secret/path.osm: No such file".to_owned(),
        };
        assert_eq!(error.public_category(), "source-unavailable");
        assert!(!error.public_message().contains("/home"));
    }
}
