//! The raw OSM types, private to this crate.
//!
//! These exist only for the duration of an import. Nothing outside
//! `atlas-osm` ever sees them, which is what keeps OSM's data model from
//! leaking into the Atlas domain.

use std::collections::HashMap;

use atlas_kernel::GeoCoordinate;

/// An OSM node that survived coordinate validation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct OsmNode {
    pub(crate) id: i64,
    pub(crate) coordinate: GeoCoordinate,
}

/// The tags of one OSM element.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OsmTags(HashMap<String, String>);

impl OsmTags {
    /// Records one tag, keeping the last value if a key repeats.
    pub(crate) fn insert(&mut self, key: String, value: String) {
        self.0.insert(key, value);
    }

    /// Looks a tag up by key.
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    /// How many tags the element carries.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
}

/// An OSM way as read from the file, before any Atlas interpretation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OsmWay {
    pub(crate) id: Option<i64>,
    pub(crate) node_refs: Vec<i64>,
    pub(crate) tags: OsmTags,
}

/// An OSM relation.
///
/// Atlas counts relations and does not interpret them: route relations, turn
/// restrictions and multipolygons are all out of scope for this milestone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OsmRelation {
    pub(crate) id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_keep_the_last_value_for_a_repeated_key() {
        let mut tags = OsmTags::default();
        tags.insert("highway".to_owned(), "residential".to_owned());
        tags.insert("highway".to_owned(), "service".to_owned());
        assert_eq!(tags.get("highway"), Some("service"));
        assert_eq!(tags.len(), 1);
    }

    #[test]
    fn missing_tags_read_as_none() {
        let tags = OsmTags::default();
        assert_eq!(tags.get("highway"), None);
    }

    #[test]
    fn a_relation_carries_only_its_id() {
        assert_eq!(OsmRelation { id: Some(7) }.id, Some(7));
    }

    #[test]
    fn a_node_carries_its_validated_coordinate() {
        let node = OsmNode {
            id: 1,
            coordinate: GeoCoordinate::from_degrees(51.38, 35.68).expect("valid coordinate"),
        };
        assert_eq!(node.coordinate.longitude_degrees(), 51.38);
    }
}
