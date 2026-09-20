//! Streaming import of plain OSM XML.

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_engine::{
    Attribution, FeatureSink, ImportError, ImportStats, IssueCode, IssueLog, MapSource,
    SourceImportOutcome, SourceMetadata,
};
use atlas_kernel::{
    FeatureId, FeatureKind, GeoCoordinate, Geometry, LineString, MapFeature, RoadClass,
    SourceReference,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use crate::access::derive_access;
use crate::direction::derive_traversal;
use crate::model::{OsmNode, OsmNodeRef, OsmRelation, OsmWay};

/// The attribution every OpenStreetMap-derived dataset must carry.
pub const OSM_ATTRIBUTION_TEXT: &str = "© OpenStreetMap contributors";

/// The licence page clients must be able to reach.
pub const OSM_LICENSE_URL: &str = "https://www.openstreetmap.org/copyright";

const SOURCE_FORMAT: &str = "osm-xml";
const SOURCE_SYSTEM: &str = "openstreetmap";
const UNKNOWN_ENTITY: &str = "unknown";

#[derive(Debug, Clone)]
enum OsmXmlInput {
    File(PathBuf),
    Memory(Arc<[u8]>),
}

/// A plain `.osm` XML file, read as a stream.
///
/// The file is read twice: once to build the node index and once to turn ways
/// into features. That costs a second pass over the bytes but removes any
/// assumption that nodes are declared before the ways that use them, while
/// still never holding the XML document itself in memory.
#[derive(Debug, Clone)]
pub struct OsmXmlSource {
    input: OsmXmlInput,
    display_name: String,
    max_issue_samples: usize,
}

impl OsmXmlSource {
    /// Reads OSM XML from a file on disk.
    ///
    /// The display name is the bare file name: absolute paths are internal
    /// detail and must never reach an API response.
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let display_name = path.file_name().map_or_else(
            || UNKNOWN_ENTITY.to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        Self {
            input: OsmXmlInput::File(path),
            display_name,
            max_issue_samples: IssueLog::DEFAULT_MAX_SAMPLES,
        }
    }

    /// Reads OSM XML from an in-memory document, which is what tests use.
    pub fn from_xml(display_name: impl Into<String>, xml: impl Into<String>) -> Self {
        Self {
            input: OsmXmlInput::Memory(Arc::from(xml.into().into_bytes())),
            display_name: display_name.into(),
            max_issue_samples: IssueLog::DEFAULT_MAX_SAMPLES,
        }
    }

    /// Overrides how many sample entity ids are retained per issue code.
    pub fn with_max_issue_samples(mut self, max_issue_samples: usize) -> Self {
        self.max_issue_samples = max_issue_samples;
        self
    }

    /// The path this source reads, when it reads a file.
    pub fn path(&self) -> Option<&Path> {
        match &self.input {
            OsmXmlInput::File(path) => Some(path),
            OsmXmlInput::Memory(_) => None,
        }
    }

    fn open(&self) -> Result<Box<dyn BufRead + '_>, ImportError> {
        match &self.input {
            OsmXmlInput::File(path) => {
                let file = File::open(path).map_err(|error| ImportError::SourceUnavailable {
                    detail: format!("{}: {error}", path.display()),
                })?;
                Ok(Box::new(BufReader::new(file)))
            }
            OsmXmlInput::Memory(bytes) => Ok(Box::new(Cursor::new(bytes.as_ref()))),
        }
    }

    fn byte_len(&self) -> Option<u64> {
        match &self.input {
            OsmXmlInput::File(path) => std::fs::metadata(path).ok().map(|meta| meta.len()),
            OsmXmlInput::Memory(bytes) => Some(bytes.len() as u64),
        }
    }

    fn reader(&self) -> Result<Reader<Box<dyn BufRead + '_>>, ImportError> {
        let mut reader = Reader::from_reader(self.open()?);
        let config = reader.config_mut();
        config.trim_text(true);
        config.check_end_names = true;
        Ok(reader)
    }

    /// First pass: validate every node and build the node index.
    fn index_nodes(
        &self,
        stats: &mut ImportStats,
        issues: &mut IssueLog,
    ) -> Result<HashMap<i64, GeoCoordinate>, ImportError> {
        let mut reader = self.reader()?;
        let mut buffer = Vec::new();
        let mut index: HashMap<i64, GeoCoordinate> = HashMap::new();

        loop {
            match reader.read_event_into(&mut buffer).map_err(malformed)? {
                Event::Eof => break,
                Event::Start(element) | Event::Empty(element) => {
                    if element.local_name().as_ref() == "node" {
                        stats.nodes_seen += 1;
                        match read_node(&element) {
                            Ok(node) => {
                                stats.nodes_indexed += 1;
                                index.insert(node.id, node.coordinate);
                            }
                            // Broken markup is the file's problem, not this
                            // node's, so it stops the import rather than
                            // becoming one more warning among thousands.
                            Err(NodeProblem::Source(error)) => return Err(error.into()),
                            Err(NodeProblem::Entity(problem)) => {
                                issues.record(problem.code, problem.entity);
                            }
                        }
                    }
                }
                _ => {}
            }
            buffer.clear();
        }

        Ok(index)
    }

    /// Second pass: turn highway ways into Atlas features, counting relations.
    fn emit_features(
        &self,
        nodes: &HashMap<i64, GeoCoordinate>,
        sink: &mut dyn FeatureSink,
        stats: &mut ImportStats,
        issues: &mut IssueLog,
    ) -> Result<(), ImportError> {
        let mut reader = self.reader()?;
        let mut buffer = Vec::new();
        let mut current_way: Option<OsmWay> = None;

        loop {
            match reader.read_event_into(&mut buffer).map_err(malformed)? {
                Event::Eof => break,
                Event::Start(element) => match element.local_name().as_ref() {
                    "way" => {
                        stats.ways_seen += 1;
                        current_way = Some(OsmWay {
                            id: read_id(&element)?,
                            ..OsmWay::default()
                        });
                    }
                    "relation" => {
                        count_relation(&element, stats, issues)?;
                    }
                    "nd" | "tag" => {
                        collect_way_child(&element, current_way.as_mut())?;
                    }
                    _ => {}
                },
                Event::Empty(element) => match element.local_name().as_ref() {
                    "way" => {
                        // A way with no children at all: no tags, so not a road.
                        stats.ways_seen += 1;
                    }
                    "relation" => {
                        count_relation(&element, stats, issues)?;
                    }
                    "nd" | "tag" => {
                        collect_way_child(&element, current_way.as_mut())?;
                    }
                    _ => {}
                },
                Event::End(element) => {
                    if element.local_name().as_ref() == "way"
                        && let Some(way) = current_way.take()
                    {
                        emit_way(way, nodes, sink, stats, issues)?;
                    }
                }
                _ => {}
            }
            buffer.clear();
        }

        Ok(())
    }
}

impl MapSource for OsmXmlSource {
    fn source_name(&self) -> &str {
        &self.display_name
    }

    fn source_metadata(&self) -> SourceMetadata {
        SourceMetadata::new(
            self.display_name.clone(),
            SOURCE_FORMAT,
            Some(Attribution::new(OSM_ATTRIBUTION_TEXT, OSM_LICENSE_URL)),
        )
    }

    fn import(&self, sink: &mut dyn FeatureSink) -> Result<SourceImportOutcome, ImportError> {
        let mut stats = ImportStats {
            bytes_read: self.byte_len(),
            ..ImportStats::default()
        };
        let mut issues = IssueLog::with_max_samples(self.max_issue_samples);

        let nodes = self.index_nodes(&mut stats, &mut issues)?;
        self.emit_features(&nodes, sink, &mut stats, &mut issues)?;

        Ok(SourceImportOutcome { stats, issues })
    }
}

/// A problem with one entity that is reported and skipped, never fatal.
struct EntityProblem {
    code: IssueCode,
    entity: String,
}

/// An attribute that could not be decoded at all.
///
/// This is a problem with the XML, not with the data it carries, so it fails
/// the whole import. An attribute that decodes cleanly but holds a value Atlas
/// cannot use is an [`EntityProblem`] instead: bounded warning, import
/// continues.
#[derive(Debug)]
struct AttributeDecodeError {
    detail: String,
}

impl From<AttributeDecodeError> for ImportError {
    fn from(error: AttributeDecodeError) -> Self {
        ImportError::MalformedSource {
            detail: error.detail,
        }
    }
}

/// Why a node could not be indexed.
enum NodeProblem {
    /// The XML could not be decoded: fatal for the import.
    Source(AttributeDecodeError),
    /// The node's data was unusable: bounded warning, import continues.
    Entity(EntityProblem),
}

impl From<AttributeDecodeError> for NodeProblem {
    fn from(error: AttributeDecodeError) -> Self {
        NodeProblem::Source(error)
    }
}

/// Why a selected road way could not become a feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WayGeometryProblem {
    /// One `<nd>` reference could not be read at all.
    MalformedReference,
    /// Every reference parsed, but one named a node the file never defined.
    MissingNode,
}

impl WayGeometryProblem {
    fn issue_code(self) -> IssueCode {
        match self {
            WayGeometryProblem::MalformedReference => IssueCode::MalformedEntity,
            WayGeometryProblem::MissingNode => IssueCode::MissingNodeReference,
        }
    }
}

fn malformed(error: quick_xml::Error) -> ImportError {
    ImportError::MalformedSource {
        detail: error.to_string(),
    }
}

fn decode_error(
    element: &BytesStart<'_>,
    what: &str,
    error: &dyn fmt::Display,
) -> AttributeDecodeError {
    AttributeDecodeError {
        detail: format!(
            "<{}>: could not decode {what}: {error}",
            element.local_name().as_ref()
        ),
    }
}

/// Reads one attribute, refusing to guess when the XML cannot be decoded.
///
/// The whole attribute list is walked and every value is normalised, even once
/// `wanted` has been found. Returning early would make the outcome depend on
/// attribute order: `<node id="1" broken=1/>` would import cleanly while
/// `<node broken=1 id="1"/>` would fail, and a file Atlas cannot actually
/// decode would be reported as though it had been read.
///
/// Any error, from the iterator or from normalisation, fails the import. A
/// value Atlas can decode but cannot use is a different thing entirely and
/// stays an entity-level warning.
///
/// The cost is that an element's attributes are decoded once per lookup. With
/// a handful of attributes per OSM element that is not worth a multi-attribute
/// reader until a profile says otherwise.
fn attribute_value(
    element: &BytesStart<'_>,
    wanted: &str,
) -> Result<Option<String>, AttributeDecodeError> {
    let mut found: Option<String> = None;

    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| decode_error(element, "an attribute", &error))?;
        let key = attribute.key.local_name();
        let key_name = key.as_ref();
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|error| {
                decode_error(element, &format!("the `{key_name}` attribute"), &error)
            })?;
        // Keep the first occurrence. quick-xml rejects duplicate keys outright,
        // so this only matters if it ever stops doing so.
        if key_name == wanted && found.is_none() {
            found = Some(value.into_owned());
        }
    }

    Ok(found)
}

fn read_id(element: &BytesStart<'_>) -> Result<Option<i64>, AttributeDecodeError> {
    Ok(attribute_value(element, "id")?.and_then(|value| value.trim().parse().ok()))
}

fn read_node(element: &BytesStart<'_>) -> Result<OsmNode, NodeProblem> {
    let id = read_id(element)?.ok_or_else(|| {
        NodeProblem::Entity(EntityProblem {
            code: IssueCode::MalformedEntity,
            entity: format!("node/{UNKNOWN_ENTITY}"),
        })
    })?;
    let entity = format!("node/{id}");

    let longitude = attribute_value(element, "lon")?.and_then(|value| parse_degrees(&value));
    let latitude = attribute_value(element, "lat")?.and_then(|value| parse_degrees(&value));
    let (Some(longitude), Some(latitude)) = (longitude, latitude) else {
        return Err(NodeProblem::Entity(EntityProblem {
            code: IssueCode::InvalidCoordinate,
            entity,
        }));
    };

    let coordinate = GeoCoordinate::from_degrees(longitude, latitude).map_err(|_| {
        NodeProblem::Entity(EntityProblem {
            code: IssueCode::InvalidCoordinate,
            entity,
        })
    })?;

    Ok(OsmNode { id, coordinate })
}

fn parse_degrees(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|degrees| degrees.is_finite())
}

fn count_relation(
    element: &BytesStart<'_>,
    stats: &mut ImportStats,
    issues: &mut IssueLog,
) -> Result<(), AttributeDecodeError> {
    stats.relations_seen += 1;
    let relation = OsmRelation {
        id: read_id(element)?,
    };
    let entity = relation.id.map_or_else(
        || format!("relation/{UNKNOWN_ENTITY}"),
        |id| format!("relation/{id}"),
    );
    issues.record(IssueCode::UnsupportedRelation, entity);
    Ok(())
}

fn collect_way_child(
    element: &BytesStart<'_>,
    way: Option<&mut OsmWay>,
) -> Result<(), AttributeDecodeError> {
    let Some(way) = way else { return Ok(()) };
    match element.local_name().as_ref() {
        "nd" => {
            let node_ref =
                attribute_value(element, "ref")?.and_then(|value| value.trim().parse::<i64>().ok());
            // A reference Atlas cannot read is recorded as a hole, never
            // skipped: silently closing the gap would join the nodes on either
            // side into a segment the source never described.
            way.node_refs.push(match node_ref {
                Some(id) => OsmNodeRef::Id(id),
                None => OsmNodeRef::Malformed,
            });
        }
        "tag" => {
            // A key with no `v` is kept, with an empty value.
            //
            // `<tag k="access"/>` is well-formed XML and a real thing to find
            // in a file. Dropping it here would delete the mapper's statement
            // before anything could judge it: the road would look untagged,
            // and `Unspecified` — the one rule that means "nobody said
            // anything" — would be recording something the source never did.
            // Kept as an empty value, it reaches the semantic adapter as the
            // unreadable value it is, and `<tag k="access"/>` and
            // `<tag k="access" v=""/>` say the same thing, as they should.
            //
            // This is a normalisation, not a relaxation of the decode
            // contract. `attribute_value` walks and decodes the element's
            // entire attribute list on the lookup above, so a malformed or
            // unresolvable attribute anywhere in the tag has already failed
            // the import by the time an absent `v` is turned into a blank.
            //
            // A tag with no usable `k` is still dropped: it names nothing, so
            // there is no key under which to record it.
            if let Some(key) = attribute_value(element, "k")? {
                let value = attribute_value(element, "v")?.unwrap_or_default();
                way.tags.insert(key, value);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Turns one finished way into a feature, or reports why it could not be.
///
/// A broken way is always a skipped way with a bounded warning, never a panic
/// and never a failed import: external data is expected to be imperfect.
fn emit_way(
    way: OsmWay,
    nodes: &HashMap<i64, GeoCoordinate>,
    sink: &mut dyn FeatureSink,
    stats: &mut ImportStats,
    issues: &mut IssueLog,
) -> Result<(), ImportError> {
    // Ways that are not roads are dropped before anything else is inspected,
    // which is what keeps a city-sized extract cheap to import: no identifier
    // is parsed, no reference is resolved and no warning is recorded.
    let Some(highway) = way.tags.get("highway") else {
        return Ok(());
    };
    stats.road_ways_selected += 1;

    // A road way counts as selected even when its own identifier is unusable,
    // so that selected = emitted + skipped always reconciles.
    let Some(id) = way.id else {
        issues.record(IssueCode::MalformedEntity, format!("way/{UNKNOWN_ENTITY}"));
        stats.features_skipped += 1;
        return Ok(());
    };
    let entity = format!("way/{id}");

    let highway = highway.trim();
    if highway.is_empty() {
        issues.record(IssueCode::MalformedEntity, entity);
        stats.features_skipped += 1;
        return Ok(());
    }

    let coordinates = match resolve_coordinates(&way, nodes) {
        Ok(coordinates) => coordinates,
        Err(problem) => {
            issues.record(problem.issue_code(), entity);
            stats.features_skipped += 1;
            return Ok(());
        }
    };

    let Ok(line) = LineString::new(coordinates) else {
        issues.record(IssueCode::TooFewCoordinates, entity);
        stats.features_skipped += 1;
        return Ok(());
    };

    let road_class = RoadClass::from_source_value(highway);
    if road_class.is_other() {
        issues.record(IssueCode::UnknownHighwayClass, entity.clone());
    }

    // Direction and access are derived only for ways that actually become
    // features, so a road skipped for broken geometry never contributes
    // semantic warnings about a road nobody can see.
    //
    // They are derived independently and neither is an input to the other:
    // access does not read the direction tags, direction does not read the
    // access tags, and access is not given the classification at all.
    let derived = derive_traversal(&way.tags, &road_class);
    for code in derived.issues.codes() {
        issues.record(code, entity.clone());
    }

    let access = derive_access(&way.tags);
    for code in access.issues.codes() {
        issues.record(code, entity.clone());
    }

    let feature_id = FeatureId::new(format!("osm:way:{id}"));
    let reference = SourceReference::new(SOURCE_SYSTEM, "way", id.to_string());
    let (Ok(feature_id), Ok(reference)) = (feature_id, reference) else {
        issues.record(IssueCode::MalformedEntity, entity);
        stats.features_skipped += 1;
        return Ok(());
    };

    let feature = MapFeature::new(
        feature_id,
        FeatureKind::Road {
            class: road_class,
            traversal: derived.traversal,
            access: access.access,
        },
        Geometry::from(line),
        way.tags.get("name").map(str::to_owned),
        Some(reference),
    );
    sink.accept(feature)?;
    stats.features_emitted += 1;
    Ok(())
}

/// Resolves node references, collapsing adjacent duplicates.
///
/// Gives up as soon as a reference cannot be turned into a coordinate, whether
/// because the reference itself was unreadable or because it named a node the
/// file never defined. Either way the remaining nodes are never joined across
/// the gap: a road with a hole silently stitched shut would be worse than no
/// road at all.
fn resolve_coordinates(
    way: &OsmWay,
    nodes: &HashMap<i64, GeoCoordinate>,
) -> Result<Vec<GeoCoordinate>, WayGeometryProblem> {
    let mut coordinates: Vec<GeoCoordinate> = Vec::with_capacity(way.node_refs.len());
    for node_ref in &way.node_refs {
        let OsmNodeRef::Id(id) = node_ref else {
            return Err(WayGeometryProblem::MalformedReference);
        };
        let coordinate = nodes.get(id).ok_or(WayGeometryProblem::MissingNode)?;
        if coordinates.last() != Some(coordinate) {
            coordinates.push(*coordinate);
        }
    }
    Ok(coordinates)
}

/// A sink that keeps every feature, used by the crate's own tests.
#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct CollectingSink {
    pub(crate) features: Vec<MapFeature>,
}

#[cfg(test)]
impl FeatureSink for CollectingSink {
    fn accept(&mut self, feature: MapFeature) -> Result<(), atlas_engine::SinkError> {
        self.features.push(feature);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import(xml: &str) -> (CollectingSink, SourceImportOutcome) {
        let source = OsmXmlSource::from_xml("test.osm", xml);
        let mut sink = CollectingSink::default();
        let outcome = source.import(&mut sink).expect("import succeeds");
        (sink, outcome)
    }

    fn names(sink: &CollectingSink) -> Vec<Option<String>> {
        sink.features
            .iter()
            .map(|feature| feature.name().map(str::to_owned))
            .collect()
    }

    fn road_classes(sink: &CollectingSink) -> Vec<String> {
        sink.features
            .iter()
            .filter_map(|feature| feature.kind().road_class())
            .map(|class| class.as_str().to_owned())
            .collect()
    }

    #[test]
    fn imports_a_simple_valid_way() {
        let (sink, outcome) = import(
            r#"<osm version="0.6">
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/>
                   <nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="name" v="Main Street"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(sink.features.len(), 1);
        assert_eq!(outcome.stats.nodes_seen, 2);
        assert_eq!(outcome.stats.nodes_indexed, 2);
        assert_eq!(outcome.stats.ways_seen, 1);
        assert_eq!(outcome.stats.road_ways_selected, 1);
        assert_eq!(outcome.stats.features_emitted, 1);
        assert_eq!(outcome.stats.features_skipped, 0);

        let feature = &sink.features[0];
        assert_eq!(feature.id().as_str(), "osm:way:10");
        assert_eq!(feature.name(), Some("Main Street"));
        assert_eq!(feature.kind().name(), "road");
        assert_eq!(road_classes(&sink), vec!["residential"]);
        let reference = feature.source().expect("source reference attached");
        assert_eq!(reference.system(), "openstreetmap");
        assert_eq!(reference.entity_type(), "way");
        assert_eq!(reference.entity_id(), "10");
    }

    #[test]
    fn geometry_keeps_longitude_latitude_order() {
        let (sink, _) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="service"/></way>
               </osm>"#,
        );
        let Geometry::LineString(line) = sink.features[0].geometry();
        assert_eq!(line.coordinates()[0].longitude_degrees(), 51.38);
        assert_eq!(line.coordinates()[0].latitude_degrees(), 35.68);
    }

    #[test]
    fn ways_without_a_highway_tag_are_ignored() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="building" v="yes"/>
                 </way>
               </osm>"#,
        );
        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.ways_seen, 1);
        assert_eq!(outcome.stats.road_ways_selected, 0);
        assert_eq!(outcome.stats.features_skipped, 0);
        assert!(outcome.issues.is_empty());
    }

    #[test]
    fn a_malformed_node_reference_never_joins_the_nodes_around_it() {
        // The middle reference cannot be read. Dropping it would leave a tidy
        // two-point road straight from node 1 to node 3 that the source never
        // described, which is the one outcome that must not happen.
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="3" lat="35.70" lon="51.40"/>
                 <way id="10">
                   <nd ref="1"/>
                   <nd ref="not-a-number"/>
                   <nd ref="3"/>
                   <tag k="highway" v="residential"/>
                 </way>
               </osm>"#,
        );

        assert!(
            sink.features.is_empty(),
            "a road was invented across the malformed reference"
        );
        assert_eq!(outcome.stats.road_ways_selected, 1);
        assert_eq!(outcome.stats.features_emitted, 0);
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::MalformedEntity), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::MalformedEntity),
            &["way/10".to_owned()]
        );
        // Both real nodes exist, so this is not a missing-node problem.
        assert_eq!(outcome.issues.count_of(IssueCode::MissingNodeReference), 0);
    }

    #[test]
    fn an_nd_element_with_no_ref_attribute_is_a_malformed_reference() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="3" lat="35.70" lon="51.40"/>
                 <way id="10">
                   <nd ref="1"/><nd/><nd ref="3"/>
                   <tag k="highway" v="residential"/>
                 </way>
               </osm>"#,
        );
        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::MalformedEntity), 1);
    }

    #[test]
    fn a_malformed_reference_and_a_missing_node_are_reported_differently() {
        // Way 10 has an unreadable reference; way 11 has a perfectly readable
        // reference to a node the file never defines. They are not the same
        // problem and must not be counted as the same problem.
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="3" lat="35.70" lon="51.40"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="oops"/><nd ref="3"/>
                   <tag k="highway" v="residential"/>
                 </way>
                 <way id="11">
                   <nd ref="1"/><nd ref="404"/>
                   <tag k="highway" v="service"/>
                 </way>
               </osm>"#,
        );

        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.road_ways_selected, 2);
        assert_eq!(outcome.stats.features_skipped, 2);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::MalformedEntity),
            &["way/10".to_owned()]
        );
        assert_eq!(
            outcome.issues.samples_of(IssueCode::MissingNodeReference),
            &["way/11".to_owned()]
        );
    }

    #[test]
    fn a_highway_way_without_a_usable_id_is_counted_and_skipped() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way>
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                 </way>
               </osm>"#,
        );

        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.ways_seen, 1);
        assert_eq!(outcome.stats.road_ways_selected, 1);
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::MalformedEntity), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::MalformedEntity),
            &["way/unknown".to_owned()]
        );
    }

    #[test]
    fn non_highway_ways_stay_cheap_to_ignore_even_when_broken() {
        // No id and an unreadable reference, but also no highway tag: Atlas
        // must not resolve it, count it or warn about it.
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <way>
                   <nd ref="1"/><nd ref="garbage"/><nd/>
                   <tag k="building" v="yes"/>
                 </way>
               </osm>"#,
        );

        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.ways_seen, 1);
        assert_eq!(outcome.stats.road_ways_selected, 0);
        assert_eq!(outcome.stats.features_skipped, 0);
        assert!(
            outcome.issues.is_empty(),
            "a non-highway way produced warnings: {:?}",
            outcome.issues
        );
    }

    #[test]
    fn selected_road_ways_always_reconcile_with_emitted_plus_skipped() {
        let (_, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
                 <way id="11"><nd ref="1"/><nd ref="bad"/><tag k="highway" v="service"/></way>
                 <way id="12"><nd ref="1"/><nd ref="404"/><tag k="highway" v="primary"/></way>
                 <way id="13"><nd ref="1"/><tag k="highway" v="track"/></way>
                 <way id="14"><nd ref="1"/><nd ref="2"/><tag k="highway" v=""/></way>
                 <way><nd ref="1"/><nd ref="2"/><tag k="highway" v="path"/></way>
                 <way id="16"><nd ref="1"/><nd ref="2"/><tag k="building" v="yes"/></way>
               </osm>"#,
        );

        let stats = outcome.stats;
        assert_eq!(stats.ways_seen, 7);
        assert_eq!(stats.road_ways_selected, 6);
        assert_eq!(stats.features_emitted, 1);
        assert_eq!(stats.features_skipped, 5);
        assert_eq!(
            stats.road_ways_selected,
            stats.features_emitted + stats.features_skipped
        );
    }

    #[test]
    fn an_undecodable_attribute_fails_the_whole_import() {
        // An unquoted attribute value: the attribute iterator cannot walk the
        // element, which makes this a broken file rather than a broken entity.
        let source = OsmXmlSource::from_xml(
            "broken-attribute.osm",
            r#"<osm><node id=1 lat="35.68" lon="51.38"/></osm>"#,
        );
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("an undecodable attribute must fail the import");
        assert!(matches!(error, ImportError::MalformedSource { .. }));
        assert_eq!(error.public_category(), "malformed-source");
    }

    #[test]
    fn an_unresolvable_entity_reference_fails_the_whole_import() {
        let source = OsmXmlSource::from_xml(
            "broken-entity.osm",
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="name" v="&bogus;"/>
                 </way>
               </osm>"#,
        );
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("an unresolvable entity must fail the import");
        assert!(matches!(error, ImportError::MalformedSource { .. }));
    }

    #[test]
    fn a_malformed_trailing_attribute_fails_the_import() {
        // Everything Atlas needs from this node comes before the broken
        // attribute. Stopping at `lon` would report a clean import of a file
        // that cannot actually be decoded.
        let source = OsmXmlSource::from_xml(
            "trailing-attribute.osm",
            r#"<osm><node id="1" lat="35.68" lon="51.38" broken=1/></osm>"#,
        );
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("a malformed trailing attribute must fail the import");
        assert!(matches!(error, ImportError::MalformedSource { .. }));
        assert_eq!(error.public_category(), "malformed-source");
    }

    #[test]
    fn an_unresolvable_trailing_entity_on_a_tag_fails_the_import() {
        // `k` and `v` are both read and both fine; the damage is in an
        // attribute Atlas does not even want.
        let source = OsmXmlSource::from_xml(
            "trailing-entity.osm",
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential" note="&bogus;"/>
                 </way>
               </osm>"#,
        );
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("an unresolvable trailing entity must fail the import");
        assert!(matches!(error, ImportError::MalformedSource { .. }));
    }

    #[test]
    fn attributes_after_the_ones_atlas_reads_do_not_disturb_a_valid_import() {
        // Real extracts carry version, timestamp, changeset and user metadata
        // that Atlas ignores. Walking the whole attribute list must decode
        // them without tripping over them, escapes included.
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38" version="3" timestamp="2024-01-01T00:00:00Z" changeset="99" user="mapper"/>
                 <node id="2" lat="35.69" lon="51.39" version="1" user="Tom &amp; Jerry"/>
                 <way id="10" version="2" visible="true" user="mapper">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential" note="a &amp; b"/>
                   <tag k="name" v="Main Street"/>
                 </way>
               </osm>"#,
        );

        assert_eq!(outcome.stats.nodes_seen, 2);
        assert_eq!(outcome.stats.nodes_indexed, 2);
        assert_eq!(outcome.stats.features_emitted, 1);
        assert_eq!(outcome.stats.features_skipped, 0);
        assert!(outcome.issues.is_empty());

        let feature = &sink.features[0];
        assert_eq!(feature.id().as_str(), "osm:way:10");
        assert_eq!(feature.name(), Some("Main Street"));
        assert_eq!(road_classes(&sink), vec!["residential"]);
    }

    #[test]
    fn missing_node_references_skip_the_way_with_a_warning() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="404"/>
                   <tag k="highway" v="primary"/>
                 </way>
               </osm>"#,
        );
        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.road_ways_selected, 1);
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::MissingNodeReference), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::MissingNodeReference),
            &["way/10".to_owned()]
        );
    }

    #[test]
    fn invalid_node_coordinates_are_reported_and_not_indexed() {
        let (_, outcome) = import(
            r#"<osm>
                 <node id="1" lat="95.0" lon="51.38"/>
                 <node id="2" lat="35.69" lon="551.39"/>
                 <node id="3" lat="not-a-number" lon="51.39"/>
                 <node id="4" lon="51.39"/>
               </osm>"#,
        );
        assert_eq!(outcome.stats.nodes_seen, 4);
        assert_eq!(outcome.stats.nodes_indexed, 0);
        assert_eq!(outcome.issues.count_of(IssueCode::InvalidCoordinate), 4);
    }

    #[test]
    fn nodes_without_an_id_are_malformed() {
        let (_, outcome) = import(r#"<osm><node lat="35.68" lon="51.38"/></osm>"#);
        assert_eq!(outcome.stats.nodes_seen, 1);
        assert_eq!(outcome.stats.nodes_indexed, 0);
        assert_eq!(outcome.issues.count_of(IssueCode::MalformedEntity), 1);
    }

    #[test]
    fn adjacent_duplicate_coordinates_are_collapsed() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.68" lon="51.38"/>
                 <node id="3" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/><nd ref="3"/>
                   <tag k="highway" v="residential"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(outcome.stats.features_emitted, 1);
        let Geometry::LineString(line) = sink.features[0].geometry();
        assert_eq!(line.coordinate_count(), 2);
    }

    #[test]
    fn a_way_that_collapses_to_one_point_is_skipped() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.68" lon="51.38"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                 </way>
               </osm>"#,
        );
        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::TooFewCoordinates), 1);
    }

    #[test]
    fn a_single_node_way_is_skipped() {
        let (_, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <way id="10"><nd ref="1"/><tag k="highway" v="residential"/></way>
               </osm>"#,
        );
        assert_eq!(outcome.stats.features_skipped, 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::TooFewCoordinates),
            &["way/10".to_owned()]
        );
    }

    #[test]
    fn unknown_highway_values_are_preserved_and_reported() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="corn_maze"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(road_classes(&sink), vec!["corn_maze"]);
        assert_eq!(outcome.stats.features_emitted, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::UnknownHighwayClass), 1);
    }

    #[test]
    fn an_empty_highway_value_is_malformed() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v=""/></way>
               </osm>"#,
        );
        assert!(sink.features.is_empty());
        assert_eq!(outcome.stats.road_ways_selected, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::MalformedEntity), 1);
    }

    #[test]
    fn unicode_names_survive_the_import() {
        let (sink, _) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="name" v="خیابان ولیعصر"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(names(&sink), vec![Some("خیابان ولیعصر".to_owned())]);
    }

    #[test]
    fn xml_entities_in_names_are_unescaped() {
        let (sink, _) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="name" v="Tom &amp; Jerry &lt;Street&gt;"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(names(&sink), vec![Some("Tom & Jerry <Street>".to_owned())]);
    }

    #[test]
    fn relations_are_counted_but_never_interpreted() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
                 <relation id="20">
                   <member type="way" ref="10" role=""/>
                   <tag k="type" v="route"/>
                   <tag k="highway" v="motorway"/>
                 </relation>
               </osm>"#,
        );
        assert_eq!(outcome.stats.relations_seen, 1);
        assert_eq!(outcome.issues.count_of(IssueCode::UnsupportedRelation), 1);
        // The relation's own tags must not leak into the way's feature.
        assert_eq!(road_classes(&sink), vec!["residential"]);
    }

    #[test]
    fn every_emitted_road_carries_access_for_every_mode() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
                 <way id="11">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="service"/>
                   <tag k="access" v="no"/>
                   <tag k="foot" v="yes"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(sink.features.len(), 2);

        // A road with no access tags says so; it does not say "allowed".
        let untagged = sink.features[0].kind().road_access().expect("a road");
        assert_eq!(*untagged, atlas_kernel::RoadAccess::unspecified());

        let tagged = sink.features[1].kind().road_access().expect("a road");
        assert_eq!(tagged.motorcar(), atlas_kernel::AccessRule::Prohibited);
        assert_eq!(tagged.bicycle(), atlas_kernel::AccessRule::Prohibited);
        assert_eq!(tagged.foot(), atlas_kernel::AccessRule::Allowed);
        assert!(outcome.issues.is_empty());
    }

    #[test]
    fn access_problems_warn_without_failing_the_import_or_skipping_the_road() {
        let (sink, outcome) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="motorcar" v="maybe"/>
                 </way>
                 <way id="11">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="access" v="designated"/>
                 </way>
                 <way id="12">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="access:conditional" v="no @ (Mo-Fr 07:00-09:00)"/>
                 </way>
               </osm>"#,
        );
        // Every road is still a feature: an access problem is a warning about
        // a road, never a reason to drop one.
        assert_eq!(sink.features.len(), 3);
        assert_eq!(outcome.stats.features_emitted, 3);
        assert_eq!(outcome.stats.features_skipped, 0);

        assert_eq!(outcome.issues.count_of(IssueCode::UnknownAccessValue), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::UnknownAccessValue),
            &["way/10"]
        );
        assert_eq!(outcome.issues.count_of(IssueCode::InvalidAccessScope), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::InvalidAccessScope),
            &["way/11"]
        );
        assert_eq!(
            outcome
                .issues
                .count_of(IssueCode::UnsupportedConditionalAccess),
            1
        );
        assert_eq!(
            outcome
                .issues
                .samples_of(IssueCode::UnsupportedConditionalAccess),
            &["way/12"]
        );
    }

    // -- a tag key with no value survives the XML boundary ----------------

    /// Two nodes and one way carrying `tags`, as a complete document.
    ///
    /// These tests go through the real XML reader on purpose. The seam this
    /// section guards is between the parser and the semantic adapter, and a
    /// test that hands `derive_access` a hand-built `OsmTags` walks straight
    /// past it: it can only assert what the adapter does with a value the
    /// parser might never have handed over.
    fn road_with_tags(tags: &str) -> String {
        format!(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   {tags}
                 </way>
               </osm>"#
        )
    }

    /// The access of the single road in such a document.
    fn access_of(tags: &str) -> (atlas_kernel::RoadAccess, SourceImportOutcome) {
        let (sink, outcome) = import(&road_with_tags(tags));
        assert_eq!(sink.features.len(), 1, "the road must still be emitted");
        let access = *sink.features[0].kind().road_access().expect("a road");
        (access, outcome)
    }

    #[test]
    fn a_static_access_key_with_no_value_is_still_read() {
        // `<tag k="access"/>` is well-formed XML and a real thing to find in a
        // file. Dropping it would turn a broken tag into no tag at all, and
        // `unspecified` — the one answer that means "nobody said anything" —
        // would be recording something the source never did.
        use atlas_kernel::AccessRule::Indeterminate;
        let (access, outcome) = access_of(r#"<tag k="access"/>"#);
        assert_eq!(access.motorcar(), Indeterminate);
        assert_eq!(access.bicycle(), Indeterminate);
        assert_eq!(access.foot(), Indeterminate);
        assert_eq!(outcome.issues.count_of(IssueCode::UnknownAccessValue), 1);
        assert_eq!(
            outcome.issues.samples_of(IssueCode::UnknownAccessValue),
            &["way/10"]
        );
        assert_eq!(outcome.stats.features_emitted, 1);
        assert_eq!(outcome.stats.features_skipped, 0);
    }

    #[test]
    fn a_specific_access_key_with_no_value_never_falls_back() {
        // The empty `motorcar` is an explicit statement about motorcars that
        // Atlas cannot read. Falling through to the perfectly readable
        // `access` below it would answer a question the mapper did not ask.
        use atlas_kernel::AccessRule::{Allowed, Indeterminate};
        let (access, outcome) = access_of(
            r#"<tag k="access" v="yes"/>
               <tag k="motorcar"/>"#,
        );
        assert_eq!(access.motorcar(), Indeterminate);
        assert_eq!(access.bicycle(), Allowed);
        assert_eq!(access.foot(), Allowed);
        assert_eq!(outcome.issues.count_of(IssueCode::UnknownAccessValue), 1);
    }

    #[test]
    fn a_conditional_key_with_no_value_is_still_detected() {
        // Conditional detection is by key and the value is never parsed, so
        // an absent value changes nothing about what Atlas can claim. Dropping
        // the tag, though, would make the road look unconditioned.
        use atlas_kernel::AccessRule::Conditional;
        let (access, outcome) = access_of(r#"<tag k="access:conditional"/>"#);
        assert_eq!(access.motorcar(), Conditional);
        assert_eq!(access.bicycle(), Conditional);
        assert_eq!(access.foot(), Conditional);
        assert_eq!(
            outcome
                .issues
                .count_of(IssueCode::UnsupportedConditionalAccess),
            1
        );
        // An unparsed conditional is not a malformed value.
        assert_eq!(outcome.issues.count_of(IssueCode::UnknownAccessValue), 0);
    }

    #[test]
    fn a_shadowed_conditional_with_no_value_stays_selected_only() {
        // Preserving the key must not change the selected-only rule: this
        // conditional is out-ranked for every mode, so it decides nothing and
        // reports nothing.
        use atlas_kernel::AccessRule::Allowed;
        let (access, outcome) = access_of(
            r#"<tag k="access:conditional"/>
               <tag k="motorcar" v="yes"/>
               <tag k="bicycle" v="yes"/>
               <tag k="foot" v="yes"/>"#,
        );
        assert_eq!(access.motorcar(), Allowed);
        assert_eq!(access.bicycle(), Allowed);
        assert_eq!(access.foot(), Allowed);
        assert!(outcome.issues.is_empty(), "{:?}", outcome.issues);
    }

    #[test]
    fn an_ordinary_valued_tag_is_unaffected() {
        // The control case: nothing about a normal tag changes.
        use atlas_kernel::AccessRule::{Allowed, Prohibited};
        let (access, outcome) = access_of(
            r#"<tag k="access" v="no"/>
               <tag k="foot" v="yes"/>"#,
        );
        assert_eq!(access.motorcar(), Prohibited);
        assert_eq!(access.bicycle(), Prohibited);
        assert_eq!(access.foot(), Allowed);
        assert!(outcome.issues.is_empty());

        // A tag whose value is genuinely an empty string reads the same way as
        // a tag with no `v` at all, which is the point of normalising one to
        // the other.
        let (explicit, _) = access_of(r#"<tag k="access" v=""/>"#);
        let (absent, _) = access_of(r#"<tag k="access"/>"#);
        assert_eq!(explicit, absent);
    }

    #[test]
    fn a_tag_with_no_key_is_still_ignored() {
        // Out of scope for this pass and deliberately unchanged: a tag with no
        // `k` names nothing, so there is no key under which to record it.
        let (access, outcome) = access_of(r#"<tag v="yes"/>"#);
        assert_eq!(access, atlas_kernel::RoadAccess::unspecified());
        assert!(outcome.issues.is_empty());
    }

    #[test]
    fn an_undecodable_tag_attribute_is_still_fatal() {
        // Preserving an absent `v` must not weaken the decode contract. An
        // attribute Atlas cannot decode at all is still a broken document, and
        // still fails the whole import rather than becoming a blank value.
        for document in [
            // Unquoted attribute value.
            r#"<osm><way id="10"><tag k=access v="yes"/></way></osm>"#,
            // Unresolvable entity in the value.
            r#"<osm><way id="10"><tag k="access" v="&nope;"/></way></osm>"#,
            // Unresolvable entity in the key.
            r#"<osm><way id="10"><tag k="&nope;" v="yes"/></way></osm>"#,
            // A malformed attribute after the ones Atlas reads.
            r#"<osm><way id="10"><tag k="access" v="yes" extra=1/></way></osm>"#,
        ] {
            let source = OsmXmlSource::from_xml("test.osm", document);
            let mut sink = CollectingSink::default();
            let error = source
                .import(&mut sink)
                .expect_err("an undecodable attribute must fail the import");
            assert!(
                matches!(error, ImportError::MalformedSource { .. }),
                "{document} gave {error:?}"
            );
        }
    }

    #[test]
    fn access_derivation_never_touches_the_geometry() {
        // The same two nodes in the same order, with and without a prohibition
        // on top. Coordinates must come out identical, in source order.
        let geometry_of = |xml: &str| {
            let (sink, _) = import(xml);
            let atlas_kernel::Geometry::LineString(line) = sink.features[0].geometry();
            line.coordinates()
                .iter()
                .map(|coordinate| {
                    (
                        coordinate.longitude_degrees(),
                        coordinate.latitude_degrees(),
                    )
                })
                .collect::<Vec<_>>()
        };

        let plain = geometry_of(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.685" lon="51.385"/>
                 <node id="3" lat="35.69" lon="51.39"/>
                 <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>
               </osm>"#,
        );
        let barred = geometry_of(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.685" lon="51.385"/>
                 <node id="3" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/><nd ref="3"/>
                   <tag k="highway" v="residential"/>
                   <tag k="access" v="no"/>
                   <tag k="oneway" v="-1"/>
                 </way>
               </osm>"#,
        );
        assert_eq!(
            plain,
            vec![(51.38, 35.68), (51.385, 35.685), (51.39, 35.69)]
        );
        assert_eq!(plain, barred);
    }

    #[test]
    fn access_and_direction_are_derived_independently() {
        // A forward one-way that bars motorcars keeps both facts whole: the
        // arrow still points forward, and the prohibition is still recorded.
        let (sink, _) = import(
            r#"<osm>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
                 <way id="10">
                   <nd ref="1"/><nd ref="2"/>
                   <tag k="highway" v="residential"/>
                   <tag k="oneway" v="yes"/>
                   <tag k="motor_vehicle" v="no"/>
                 </way>
               </osm>"#,
        );
        let kind = sink.features[0].kind();
        let traversal = kind.road_traversal().expect("a road");
        let access = kind.road_access().expect("a road");
        assert_eq!(
            traversal.motorcar(),
            atlas_kernel::TravelDirection::Forward,
            "a prohibition must not erase the direction"
        );
        assert_eq!(access.motorcar(), atlas_kernel::AccessRule::Prohibited);
        assert_eq!(access.bicycle(), atlas_kernel::AccessRule::Unspecified);
        assert_eq!(traversal.bicycle(), atlas_kernel::TravelDirection::Forward);
    }

    #[test]
    fn nodes_declared_after_the_ways_that_use_them_still_resolve() {
        let (sink, _) = import(
            r#"<osm>
                 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
                 <node id="1" lat="35.68" lon="51.38"/>
                 <node id="2" lat="35.69" lon="51.39"/>
               </osm>"#,
        );
        assert_eq!(sink.features.len(), 1);
    }

    #[test]
    fn feature_ids_are_deterministic_across_repeated_imports() {
        let xml = r#"<osm>
                       <node id="1" lat="35.68" lon="51.38"/>
                       <node id="2" lat="35.69" lon="51.39"/>
                       <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
                       <way id="11"><nd ref="2"/><nd ref="1"/><tag k="highway" v="service"/></way>
                     </osm>"#;
        let (first, _) = import(xml);
        let (second, _) = import(xml);
        let ids = |sink: &CollectingSink| {
            sink.features
                .iter()
                .map(|feature| feature.id().as_str().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&first), vec!["osm:way:10", "osm:way:11"]);
        assert_eq!(ids(&first), ids(&second));
    }

    #[test]
    fn issue_samples_stay_bounded_for_a_pathological_file() {
        let mut xml = String::from("<osm>");
        for id in 0..200 {
            xml.push_str(&format!(
                r#"<way id="{id}"><nd ref="9999"/><nd ref="9998"/><tag k="highway" v="residential"/></way>"#
            ));
        }
        xml.push_str("</osm>");
        let source = OsmXmlSource::from_xml("pathological.osm", xml).with_max_issue_samples(4);
        let mut sink = CollectingSink::default();
        let outcome = source.import(&mut sink).expect("import succeeds");
        assert_eq!(outcome.stats.features_skipped, 200);
        assert_eq!(
            outcome.issues.count_of(IssueCode::MissingNodeReference),
            200
        );
        assert_eq!(
            outcome
                .issues
                .samples_of(IssueCode::MissingNodeReference)
                .len(),
            4
        );
    }

    #[test]
    fn malformed_xml_fails_the_whole_import() {
        let source = OsmXmlSource::from_xml(
            "broken.osm",
            r#"<osm><node id="1" lat="35.68" lon="51.38"></osm>"#,
        );
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("malformed XML must fail");
        assert!(matches!(error, ImportError::MalformedSource { .. }));
        assert_eq!(error.public_category(), "malformed-source");
    }

    #[test]
    fn an_unreadable_file_fails_the_whole_import() {
        let source = OsmXmlSource::from_path("/nonexistent/atlas/does-not-exist.osm");
        let mut sink = CollectingSink::default();
        let error = source
            .import(&mut sink)
            .expect_err("missing file must fail");
        assert!(matches!(error, ImportError::SourceUnavailable { .. }));
        assert_eq!(source.source_name(), "does-not-exist.osm");
    }

    #[test]
    fn source_metadata_carries_osm_attribution() {
        let source = OsmXmlSource::from_xml("sample.osm", "<osm/>");
        let metadata = source.source_metadata();
        assert_eq!(metadata.name(), "sample.osm");
        assert_eq!(metadata.format(), "osm-xml");
        let attribution = metadata.attribution().expect("attribution present");
        assert_eq!(attribution.text(), "© OpenStreetMap contributors");
        assert_eq!(
            attribution.license_url(),
            "https://www.openstreetmap.org/copyright"
        );
    }

    #[test]
    fn bytes_read_is_reported_for_in_memory_sources() {
        let xml = "<osm/>";
        let source = OsmXmlSource::from_xml("sample.osm", xml);
        let mut sink = CollectingSink::default();
        let outcome = source.import(&mut sink).expect("import succeeds");
        assert_eq!(outcome.stats.bytes_read, Some(xml.len() as u64));
    }
}
