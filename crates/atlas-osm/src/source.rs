//! Streaming import of plain OSM XML.

use std::collections::HashMap;
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

use crate::model::{OsmNode, OsmRelation, OsmWay};

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
                            Err(problem) => {
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
                            id: read_id(&element),
                            ..OsmWay::default()
                        });
                    }
                    "relation" => {
                        count_relation(&element, stats, issues);
                    }
                    "nd" | "tag" => {
                        collect_way_child(&element, current_way.as_mut());
                    }
                    _ => {}
                },
                Event::Empty(element) => match element.local_name().as_ref() {
                    "way" => {
                        // A way with no children at all: no tags, so not a road.
                        stats.ways_seen += 1;
                    }
                    "relation" => {
                        count_relation(&element, stats, issues);
                    }
                    "nd" | "tag" => {
                        collect_way_child(&element, current_way.as_mut());
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

fn malformed(error: quick_xml::Error) -> ImportError {
    ImportError::MalformedSource {
        detail: error.to_string(),
    }
}

fn attribute_value(element: &BytesStart<'_>, wanted: &str) -> Option<String> {
    for attribute in element.attributes() {
        let Ok(attribute) = attribute else { continue };
        if attribute.key.local_name().as_ref() != wanted {
            continue;
        }
        return attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .ok()
            .map(|value| value.into_owned());
    }
    None
}

fn read_id(element: &BytesStart<'_>) -> Option<i64> {
    attribute_value(element, "id").and_then(|value| value.trim().parse().ok())
}

fn read_node(element: &BytesStart<'_>) -> Result<OsmNode, EntityProblem> {
    let id = read_id(element).ok_or_else(|| EntityProblem {
        code: IssueCode::MalformedEntity,
        entity: format!("node/{UNKNOWN_ENTITY}"),
    })?;
    let entity = format!("node/{id}");

    let longitude = attribute_value(element, "lon").and_then(|value| parse_degrees(&value));
    let latitude = attribute_value(element, "lat").and_then(|value| parse_degrees(&value));
    let (Some(longitude), Some(latitude)) = (longitude, latitude) else {
        return Err(EntityProblem {
            code: IssueCode::InvalidCoordinate,
            entity,
        });
    };

    let coordinate =
        GeoCoordinate::from_degrees(longitude, latitude).map_err(|_| EntityProblem {
            code: IssueCode::InvalidCoordinate,
            entity,
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

fn count_relation(element: &BytesStart<'_>, stats: &mut ImportStats, issues: &mut IssueLog) {
    stats.relations_seen += 1;
    let relation = OsmRelation {
        id: read_id(element),
    };
    let entity = relation.id.map_or_else(
        || format!("relation/{UNKNOWN_ENTITY}"),
        |id| format!("relation/{id}"),
    );
    issues.record(IssueCode::UnsupportedRelation, entity);
}

fn collect_way_child(element: &BytesStart<'_>, way: Option<&mut OsmWay>) {
    let Some(way) = way else { return };
    match element.local_name().as_ref() {
        "nd" => {
            if let Some(node_ref) =
                attribute_value(element, "ref").and_then(|value| value.trim().parse::<i64>().ok())
            {
                way.node_refs.push(node_ref);
            }
        }
        "tag" => {
            if let (Some(key), Some(value)) =
                (attribute_value(element, "k"), attribute_value(element, "v"))
            {
                way.tags.insert(key, value);
            }
        }
        _ => {}
    }
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
    let Some(id) = way.id else {
        issues.record(IssueCode::MalformedEntity, format!("way/{UNKNOWN_ENTITY}"));
        return Ok(());
    };
    let entity = format!("way/{id}");

    // Ways that are not roads are dropped before any node reference is
    // resolved, which is what keeps a city-sized extract cheap to import.
    let Some(highway) = way.tags.get("highway") else {
        return Ok(());
    };
    stats.road_ways_selected += 1;

    let highway = highway.trim();
    if highway.is_empty() {
        issues.record(IssueCode::MalformedEntity, entity);
        stats.features_skipped += 1;
        return Ok(());
    }

    let Some(coordinates) = resolve_coordinates(&way, nodes) else {
        issues.record(IssueCode::MissingNodeReference, entity);
        stats.features_skipped += 1;
        return Ok(());
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

    let feature_id = FeatureId::new(format!("osm:way:{id}"));
    let reference = SourceReference::new(SOURCE_SYSTEM, "way", id.to_string());
    let (Ok(feature_id), Ok(reference)) = (feature_id, reference) else {
        issues.record(IssueCode::MalformedEntity, entity);
        stats.features_skipped += 1;
        return Ok(());
    };

    let feature = MapFeature::new(
        feature_id,
        FeatureKind::Road(road_class),
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
/// Returns `None` as soon as a reference cannot be resolved: a road with a hole
/// in it would be worse than no road at all.
fn resolve_coordinates(
    way: &OsmWay,
    nodes: &HashMap<i64, GeoCoordinate>,
) -> Option<Vec<GeoCoordinate>> {
    let mut coordinates: Vec<GeoCoordinate> = Vec::with_capacity(way.node_refs.len());
    for node_ref in &way.node_refs {
        let coordinate = nodes.get(node_ref)?;
        if coordinates.last() != Some(coordinate) {
            coordinates.push(*coordinate);
        }
    }
    Some(coordinates)
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
