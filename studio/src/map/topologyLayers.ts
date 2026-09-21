/**
 * The road topology overlay: its own source, its own layers, its own root.
 *
 * This module is a **separate composition root** from `roadLayers`. It imports
 * nothing from there and nothing there imports it, so the ordinary road stack
 * cannot come to depend on topology and topology cannot reintroduce a cycle
 * through the road stack. The only thing the two share is the map they are
 * both added to, and `main.ts` is what adds them.
 *
 * Everything topology draws comes from `TOPOLOGY_SOURCE_ID`, which is a
 * different MapLibre source from the roads. Topology is never flattened into
 * road properties: the two have different shapes, different lifetimes and
 * different toggles, and merging them would mean a road query could not be
 * answered without a topology query.
 *
 * The drawing rules:
 *
 * * Thin neutral cyan lines for segments, under the nodes, and under nothing
 *   that belongs to the road stack — the overlay is a debugging aid laid over
 *   the map, not a replacement for it.
 * * Circles for nodes, sized and coloured by degree category so that a dead
 *   end and a junction are tellable apart at a glance, and without relying on
 *   colour alone.
 * * Nothing here encodes importance. A junction is drawn larger because more
 *   segment ends meet there, which is a structural fact; it is not a claim
 *   that the roads there are bigger, faster or more useful.
 */

import type { FeatureCollection, GeoJSON, LineString, Point } from 'geojson';
import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

import {
  isDrawableNode,
  isDrawableSegment,
  type DegreeCategory,
  type TopologyGraph,
} from './topology.js';

export const TOPOLOGY_SEGMENT_SOURCE_ID = 'atlas-topology-segments';
export const TOPOLOGY_NODE_SOURCE_ID = 'atlas-topology-nodes';

export const TOPOLOGY_SEGMENT_LAYER_ID = 'atlas-topology-segments-line';
export const TOPOLOGY_SEGMENT_HIT_LAYER_ID = 'atlas-topology-segments-hit';
export const TOPOLOGY_NODE_LAYER_ID = 'atlas-topology-nodes-circle';

/** The property Studio copies a topology id into, so filters can match it. */
export const TOPOLOGY_ID_KEY = 'atlasTopologyId';

/** The property carrying a node's degree category, for the circle styling. */
export const TOPOLOGY_CATEGORY_KEY = 'atlasDegreeCategory';

/** The segment line colour: neutral cyan, unlike any road class colour. */
export const TOPOLOGY_SEGMENT_COLOR = '#5ad2e6';

/**
 * How each degree category is drawn.
 *
 * Radius and colour both carry the distinction, so the categories survive a
 * greyscale screenshot and a colour-blind reader. The `unknown` category is
 * deliberately the odd one out in hue as well as size: a node whose degree the
 * server did not state must not look like a node whose degree is one.
 */
export const NODE_STYLE: Record<DegreeCategory, { color: string; radius: number }> = {
  endpoint: { color: '#8fe3c6', radius: 3 },
  through: { color: '#5ad2e6', radius: 3.6 },
  junction: { color: '#ffd166', radius: 5.2 },
  unknown: { color: '#c79bf2', radius: 4.4 },
};

/**
 * Matches a node's flattened degree category to its colour.
 *
 * The three named categories are written out rather than generated, so the
 * expression is a plain data literal a test can compare against and a category
 * added to the vocabulary has to be given a style before it can be drawn. The
 * fallback is the `unknown` style, which is where an unrecognised category
 * belongs anyway.
 */
export function nodeColor(): ExpressionSpecification {
  return [
    'match',
    ['get', TOPOLOGY_CATEGORY_KEY],
    'endpoint',
    NODE_STYLE.endpoint.color,
    'through',
    NODE_STYLE.through.color,
    'junction',
    NODE_STYLE.junction.color,
    NODE_STYLE.unknown.color,
  ];
}

/** Matches a node's flattened degree category to its base radius. */
export function nodeBaseRadius(): ExpressionSpecification {
  return [
    'match',
    ['get', TOPOLOGY_CATEGORY_KEY],
    'endpoint',
    NODE_STYLE.endpoint.radius,
    'through',
    NODE_STYLE.through.radius,
    'junction',
    NODE_STYLE.junction.radius,
    NODE_STYLE.unknown.radius,
  ];
}

/** The zoom-scaled circle radius. Nodes are dots at city scale, targets at street scale. */
export function nodeRadius(): ExpressionSpecification {
  const base = nodeBaseRadius();
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    11,
    ['*', 0.6, base],
    16,
    base,
    19,
    ['*', 1.6, base],
  ];
}

/** An empty segment collection, used before the first topology query. */
export const EMPTY_SEGMENTS: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: [],
};

/** An empty node collection, used before the first topology query. */
export const EMPTY_NODES: FeatureCollection<Point> = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * Adapts a parsed graph's segments for MapLibre.
 *
 * Segments Studio could not read a geometry for are left out rather than
 * drawn somewhere plausible. The coordinates are passed through in the order
 * the server sent them: a reverse one-way's segment is never turned around.
 */
export function toSegmentCollection(graph: TopologyGraph): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: graph.segments.filter(isDrawableSegment).map((segment) => ({
      type: 'Feature',
      id: segment.id,
      geometry: { type: 'LineString', coordinates: segment.coordinates },
      properties: { [TOPOLOGY_ID_KEY]: segment.id },
    })),
  };
}

/**
 * Adapts a parsed graph's nodes for MapLibre.
 *
 * A node with no readable coordinate has nowhere to be drawn, so it is left
 * out of the map. It is still in the graph, and the inspector can still show
 * what is known about it.
 */
export function toNodeCollection(graph: TopologyGraph): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: graph.nodes.filter(isDrawableNode).map((node) => ({
      type: 'Feature',
      id: node.id,
      // `isDrawableNode` has already established the coordinate is there.
      geometry: { type: 'Point', coordinates: node.coordinate as [number, number] },
      properties: {
        [TOPOLOGY_ID_KEY]: node.id,
        [TOPOLOGY_CATEGORY_KEY]: node.category,
      },
    })),
  };
}

/**
 * The topology layers, bottom to top: a fat invisible hit target for the
 * segments, the segment lines themselves, then the nodes.
 *
 * The nodes go on top of the lines so that a junction is visible where several
 * segments converge on it, and the hit layer goes underneath both so that
 * clicking a node in a crowded junction selects the node rather than whichever
 * line happens to pass through the same pixel.
 */
export function topologyLayers(): LayerSpecification[] {
  return [
    {
      id: TOPOLOGY_SEGMENT_HIT_LAYER_ID,
      type: 'line',
      source: TOPOLOGY_SEGMENT_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 12 },
    },
    {
      id: TOPOLOGY_SEGMENT_LAYER_ID,
      type: 'line',
      source: TOPOLOGY_SEGMENT_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': TOPOLOGY_SEGMENT_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 1.6, 19, 2.6],
        'line-opacity': 0.9,
      },
    },
    {
      id: TOPOLOGY_NODE_LAYER_ID,
      type: 'circle',
      source: TOPOLOGY_NODE_SOURCE_ID,
      paint: {
        'circle-color': nodeColor(),
        'circle-radius': nodeRadius(),
        'circle-stroke-color': '#05080d',
        'circle-stroke-width': 1,
        'circle-opacity': 0.95,
      },
    },
  ];
}

/** Every topology layer id, in draw order. */
export const TOPOLOGY_LAYER_IDS: string[] = [
  TOPOLOGY_SEGMENT_HIT_LAYER_ID,
  TOPOLOGY_SEGMENT_LAYER_ID,
  TOPOLOGY_NODE_LAYER_ID,
];

/**
 * The slice of the map the topology overlay needs.
 *
 * Structural rather than the MapLibre type, so that installing and removing
 * the overlay can be tested without a WebGL context — and so that a test can
 * prove it touches nothing belonging to the road stack.
 */
export interface TopologyMapTarget {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: { type: 'geojson'; data: GeoJSON }): void;
  addLayer(layer: LayerSpecification): void;
  removeLayer(id: string): void;
  removeSource(id: string): void;
}

/**
 * Installs the overlay, if it is not already there.
 *
 * Returns whether anything was added, so a caller can tell "installed now"
 * from "was already installed".
 */
export function installTopologyLayers(target: TopologyMapTarget, graph: TopologyGraph): boolean {
  if (target.getSource(TOPOLOGY_SEGMENT_SOURCE_ID)) {
    return false;
  }
  target.addSource(TOPOLOGY_SEGMENT_SOURCE_ID, {
    type: 'geojson',
    data: toSegmentCollection(graph),
  });
  target.addSource(TOPOLOGY_NODE_SOURCE_ID, {
    type: 'geojson',
    data: toNodeCollection(graph),
  });
  for (const layer of topologyLayers()) {
    target.addLayer(layer);
  }
  return true;
}

/**
 * Removes the overlay entirely.
 *
 * Layers first, then sources, because MapLibre refuses to remove a source a
 * layer still points at. Returns whether anything was removed.
 *
 * Note what this does *not* do: it never touches a road source, a road layer
 * or the viewport, so disabling topology cannot disturb the road map and
 * cannot cause a road query.
 */
export function removeTopologyLayers(target: TopologyMapTarget): boolean {
  if (!target.getSource(TOPOLOGY_SEGMENT_SOURCE_ID)) {
    return false;
  }
  for (const id of [...TOPOLOGY_LAYER_IDS].reverse()) {
    if (target.getLayer(id)) {
      target.removeLayer(id);
    }
  }
  for (const id of [TOPOLOGY_NODE_SOURCE_ID, TOPOLOGY_SEGMENT_SOURCE_ID]) {
    if (target.getSource(id)) {
      target.removeSource(id);
    }
  }
  return true;
}
