import { describe, expect, it } from 'vitest';

import type { GeoJSON } from 'geojson';
import type { LayerSpecification } from 'maplibre-gl';

import { ROAD_SOURCE_ID } from '../src/map/roadPrimitives.js';
import { ROAD_DIRECTION_LAYER_ID } from '../src/map/directionArrows.js';
import {
  ROAD_CASING_LAYER_ID,
  ROAD_HIT_LAYER_ID,
  ROAD_HOVER_LAYER_ID,
  ROAD_LAYER_ID,
  ROAD_SELECTED_LAYER_ID,
  roadLayers,
} from '../src/map/roadLayers.js';
import { DEGREE_CATEGORIES, parseTopology, type TopologyGraph } from '../src/map/topology.js';
import {
  EMPTY_NODES,
  EMPTY_SEGMENTS,
  NODE_STYLE,
  TOPOLOGY_CATEGORY_KEY,
  TOPOLOGY_ID_KEY,
  TOPOLOGY_LAYER_IDS,
  TOPOLOGY_NODE_LAYER_ID,
  TOPOLOGY_NODE_SOURCE_ID,
  TOPOLOGY_SEGMENT_COLOR,
  TOPOLOGY_SEGMENT_HIT_LAYER_ID,
  TOPOLOGY_SEGMENT_LAYER_ID,
  TOPOLOGY_SEGMENT_SOURCE_ID,
  installTopologyLayers,
  nodeBaseRadius,
  nodeColor,
  removeTopologyLayers,
  toNodeCollection,
  toSegmentCollection,
  topologyLayers,
  type TopologyMapTarget,
} from '../src/map/topologyLayers.js';

/** Records everything done to it, so a test can prove what was and was not touched. */
class FakeMap implements TopologyMapTarget {
  readonly sources = new Map<string, GeoJSON>();
  readonly layers: LayerSpecification[] = [];
  readonly calls: string[] = [];

  getSource(id: string): unknown {
    return this.sources.has(id) ? { id } : undefined;
  }

  getLayer(id: string): unknown {
    return this.layers.find((layer) => layer.id === id);
  }

  addSource(id: string, source: { type: 'geojson'; data: GeoJSON }): void {
    this.calls.push(`addSource:${id}`);
    this.sources.set(id, source.data);
  }

  addLayer(layer: LayerSpecification): void {
    this.calls.push(`addLayer:${layer.id}`);
    this.layers.push(layer);
  }

  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index >= 0) {
      this.layers.splice(index, 1);
    }
  }

  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }
}

/**
 * The three topology layers as a fixed-length tuple.
 *
 * `topologyLayers()` returns a plain array, and destructuring one leaves every
 * element possibly undefined. The length is asserted once here so the tests
 * below can read each layer by name.
 */
function layers(): [LayerSpecification, LayerSpecification, LayerSpecification] {
  const all = topologyLayers();
  expect(all).toHaveLength(3);
  return all as [LayerSpecification, LayerSpecification, LayerSpecification];
}

function graph(): TopologyGraph {
  return parseTopology({
    datasetId: 'ds-1',
    nodes: [
      { id: 'osm:node:1', coordinate: [51.3, 35.6], degree: 1 },
      { id: 'osm:node:5', coordinate: [51.312, 35.6], degree: 3 },
      { id: 'osm:node:17', coordinate: [51.34, 35.6], degree: 2 },
      { id: 'osm:node:99', coordinate: [51.35, 35.6] },
      // No coordinate: inspectable, not drawable.
      { id: 'osm:node:404', degree: 1 },
    ],
    segments: [
      {
        id: 'osm:way:601:segment:0',
        roadFeatureId: 'osm:way:601',
        startNodeId: 'osm:node:1',
        endNodeId: 'osm:node:5',
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.3, 35.6],
            [51.301, 35.601],
            [51.312, 35.6],
          ],
        },
      },
      // No readable geometry: inspectable, not drawable.
      { id: 'osm:way:602:segment:0', roadFeatureId: 'osm:way:602' },
    ],
  });
}

describe('topology sources', () => {
  it('uses its own sources, never the road source', () => {
    expect(TOPOLOGY_SEGMENT_SOURCE_ID).not.toBe(ROAD_SOURCE_ID);
    expect(TOPOLOGY_NODE_SOURCE_ID).not.toBe(ROAD_SOURCE_ID);
    expect(TOPOLOGY_SEGMENT_SOURCE_ID).not.toBe(TOPOLOGY_NODE_SOURCE_ID);
    for (const layer of topologyLayers()) {
      expect([TOPOLOGY_SEGMENT_SOURCE_ID, TOPOLOGY_NODE_SOURCE_ID]).toContain(
        (layer as { source: string }).source,
      );
    }
  });

  it('no road layer reads a topology source, and no topology layer reads the road source', () => {
    for (const layer of roadLayers()) {
      expect((layer as { source: string }).source).toBe(ROAD_SOURCE_ID);
    }
    const topologyIds = new Set(topologyLayers().map((layer) => layer.id));
    for (const layer of roadLayers()) {
      expect(topologyIds.has(layer.id)).toBe(false);
    }
  });

  it('shares no layer id with the road stack', () => {
    const roadIds = [
      ROAD_CASING_LAYER_ID,
      ROAD_LAYER_ID,
      ROAD_HIT_LAYER_ID,
      ROAD_HOVER_LAYER_ID,
      ROAD_SELECTED_LAYER_ID,
      ROAD_DIRECTION_LAYER_ID,
    ];
    for (const id of TOPOLOGY_LAYER_IDS) {
      expect(roadIds).not.toContain(id);
    }
  });
});

describe('topology layer stack', () => {
  it('is ordered hit target, then segments, then nodes', () => {
    expect(topologyLayers().map((layer) => layer.id)).toEqual([
      TOPOLOGY_SEGMENT_HIT_LAYER_ID,
      TOPOLOGY_SEGMENT_LAYER_ID,
      TOPOLOGY_NODE_LAYER_ID,
    ]);
    expect(TOPOLOGY_LAYER_IDS).toEqual(topologyLayers().map((layer) => layer.id));
  });

  it('draws segments as thin cyan lines and nodes as circles', () => {
    const [hit, segments, nodes] = layers();
    expect(hit.type).toBe('line');
    expect((hit.paint as Record<string, unknown>)['line-opacity']).toBe(0);
    expect(segments.type).toBe('line');
    expect((segments.paint as Record<string, unknown>)['line-color']).toBe(TOPOLOGY_SEGMENT_COLOR);
    expect(nodes.type).toBe('circle');
  });

  it('gives the hit target a wider stroke than the visible line', () => {
    const [hit, segments] = layers();
    const hitWidth = (hit.paint as Record<string, unknown>)['line-width'] as number;
    const lineWidth = (segments.paint as Record<string, unknown>)['line-width'];
    expect(hitWidth).toBeGreaterThan(3);
    expect(Array.isArray(lineWidth)).toBe(true);
  });
});

describe('degree styling', () => {
  it('has a style for every declared category', () => {
    for (const category of DEGREE_CATEGORIES) {
      expect(NODE_STYLE[category]).toBeDefined();
      expect(NODE_STYLE[category].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(NODE_STYLE[category].radius).toBeGreaterThan(0);
    }
  });

  it('separates a degree-1 endpoint from a degree-3+ junction by size and colour', () => {
    expect(NODE_STYLE.junction.radius).toBeGreaterThan(NODE_STYLE.endpoint.radius);
    expect(NODE_STYLE.junction.color).not.toBe(NODE_STYLE.endpoint.color);
    // Colour alone is not the distinction, so a greyscale or colour-blind
    // reader still tells them apart.
    expect(NODE_STYLE.junction.radius).not.toBe(NODE_STYLE.endpoint.radius);
  });

  it('gives an unknown degree its own hue and size, unlike an endpoint', () => {
    // A node whose degree the server did not state must not be mistaken for a
    // node whose degree is one.
    expect(NODE_STYLE.unknown.color).not.toBe(NODE_STYLE.endpoint.color);
    expect(NODE_STYLE.unknown.radius).not.toBe(NODE_STYLE.endpoint.radius);
  });

  it('gives every category a distinct colour', () => {
    const colors = DEGREE_CATEGORIES.map((category) => NODE_STYLE[category].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('matches the flattened category property, falling back to unknown', () => {
    expect(nodeColor()).toEqual([
      'match',
      ['get', TOPOLOGY_CATEGORY_KEY],
      'endpoint',
      NODE_STYLE.endpoint.color,
      'through',
      NODE_STYLE.through.color,
      'junction',
      NODE_STYLE.junction.color,
      NODE_STYLE.unknown.color,
    ]);
    expect(nodeBaseRadius()).toEqual([
      'match',
      ['get', TOPOLOGY_CATEGORY_KEY],
      'endpoint',
      NODE_STYLE.endpoint.radius,
      'through',
      NODE_STYLE.through.radius,
      'junction',
      NODE_STYLE.junction.radius,
      NODE_STYLE.unknown.radius,
    ]);
  });

  it('reads the category from a property, never from a road fact', () => {
    const expression = JSON.stringify([nodeColor(), nodeBaseRadius(), topologyLayers()]);
    for (const roadFact of ['roadClass', 'direction', 'access', 'speedLimits', 'oneway']) {
      expect(expression).not.toContain(roadFact);
    }
    expect(expression).toContain(TOPOLOGY_CATEGORY_KEY);
  });
});

describe('adapting a graph for MapLibre', () => {
  it('turns drawable segments into line features carrying their id', () => {
    const collection = toSegmentCollection(graph());
    expect(collection.features).toHaveLength(1);
    expect(collection.features.map((entry) => entry.id)).toEqual(['osm:way:601:segment:0']);
    expect(
      collection.features.map((entry) => entry.properties?.[TOPOLOGY_ID_KEY] as unknown),
    ).toEqual(['osm:way:601:segment:0']);
    expect(collection.features.map((entry) => entry.geometry.coordinates)).toEqual([
      [
        [51.3, 35.6],
        [51.301, 35.601],
        [51.312, 35.6],
      ],
    ]);
  });

  it('turns drawable nodes into point features carrying their id and category', () => {
    const collection = toNodeCollection(graph());
    expect(collection.features.map((feature) => feature.id)).toEqual([
      'osm:node:1',
      'osm:node:5',
      'osm:node:17',
      'osm:node:99',
    ]);
    const categories = collection.features.map(
      (feature) => feature.properties?.[TOPOLOGY_CATEGORY_KEY] as unknown,
    );
    expect(categories).toEqual(['endpoint', 'junction', 'through', 'unknown']);
  });

  it('leaves out what it cannot draw rather than drawing it somewhere plausible', () => {
    const nodes = toNodeCollection(graph());
    expect(nodes.features.map((feature) => feature.id)).not.toContain('osm:node:404');
    const segments = toSegmentCollection(graph());
    expect(segments.features.map((feature) => feature.id)).not.toContain('osm:way:602:segment:0');
  });

  it('flattens no road semantics onto a topology feature', () => {
    const serialised = JSON.stringify([toSegmentCollection(graph()), toNodeCollection(graph())]);
    for (const roadFact of [
      'roadClass',
      'direction:',
      'access:',
      'speedLimits',
      'traversal',
      'atlasId',
    ]) {
      expect(serialised).not.toContain(roadFact);
    }
  });

  it('has empty collections to start from', () => {
    expect(EMPTY_SEGMENTS.features).toEqual([]);
    expect(EMPTY_NODES.features).toEqual([]);
  });
});

describe('installing and removing the overlay', () => {
  it('adds both sources and every layer, once', () => {
    const map = new FakeMap();
    expect(installTopologyLayers(map, graph())).toBe(true);
    expect(map.calls).toEqual([
      `addSource:${TOPOLOGY_SEGMENT_SOURCE_ID}`,
      `addSource:${TOPOLOGY_NODE_SOURCE_ID}`,
      `addLayer:${TOPOLOGY_SEGMENT_HIT_LAYER_ID}`,
      `addLayer:${TOPOLOGY_SEGMENT_LAYER_ID}`,
      `addLayer:${TOPOLOGY_NODE_LAYER_ID}`,
    ]);

    map.calls.length = 0;
    expect(installTopologyLayers(map, graph())).toBe(false);
    expect(map.calls).toEqual([]);
  });

  it('installs the graph it was given, not an empty one', () => {
    const map = new FakeMap();
    installTopologyLayers(map, graph());
    const segments = map.sources.get(TOPOLOGY_SEGMENT_SOURCE_ID);
    expect(JSON.stringify(segments)).toContain('osm:way:601:segment:0');
  });

  it('removes layers before sources, and only its own', () => {
    const map = new FakeMap();
    installTopologyLayers(map, graph());
    map.calls.length = 0;

    expect(removeTopologyLayers(map)).toBe(true);
    expect(map.calls).toEqual([
      `removeLayer:${TOPOLOGY_NODE_LAYER_ID}`,
      `removeLayer:${TOPOLOGY_SEGMENT_LAYER_ID}`,
      `removeLayer:${TOPOLOGY_SEGMENT_HIT_LAYER_ID}`,
      `removeSource:${TOPOLOGY_NODE_SOURCE_ID}`,
      `removeSource:${TOPOLOGY_SEGMENT_SOURCE_ID}`,
    ]);
    expect(map.sources.size).toBe(0);
    expect(map.layers).toEqual([]);
  });

  it('never touches the road source or a road layer', () => {
    const map = new FakeMap();
    map.sources.set(ROAD_SOURCE_ID, { type: 'FeatureCollection', features: [] });
    for (const layer of roadLayers()) {
      map.layers.push(layer);
    }
    const roadLayerCount = map.layers.length;
    map.calls.length = 0;

    installTopologyLayers(map, graph());
    removeTopologyLayers(map);

    expect(map.sources.has(ROAD_SOURCE_ID)).toBe(true);
    expect(map.layers).toHaveLength(roadLayerCount);
    for (const call of map.calls) {
      expect(call).not.toContain(ROAD_SOURCE_ID);
      for (const id of [ROAD_LAYER_ID, ROAD_HIT_LAYER_ID, ROAD_DIRECTION_LAYER_ID]) {
        expect(call).not.toContain(id);
      }
    }
  });

  it('removing an overlay that is not installed does nothing', () => {
    const map = new FakeMap();
    expect(removeTopologyLayers(map)).toBe(false);
    expect(map.calls).toEqual([]);
  });

  it('can be installed, removed and installed again', () => {
    const map = new FakeMap();
    installTopologyLayers(map, graph());
    removeTopologyLayers(map);
    expect(installTopologyLayers(map, graph())).toBe(true);
    expect(map.layers.map((layer) => layer.id)).toEqual(TOPOLOGY_LAYER_IDS);
  });
});
