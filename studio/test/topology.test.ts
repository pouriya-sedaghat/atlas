import { describe, expect, it } from 'vitest';

import { buildTopologyUrl } from '../src/api/client.js';
import type { TopologyQueryRequest } from '../src/api/client.js';
import type { Bbox } from '../src/api/types.js';
import {
  DEGREE_CATEGORIES,
  EMPTY_GRAPH,
  INDETERMINATE,
  degreeCategory,
  indexNodes,
  indexSegments,
  isDrawableNode,
  isDrawableSegment,
  parseDegree,
  parsePosition,
  parseTopology,
} from '../src/map/topology.js';

const BBOX: Bbox = [51.38, 35.68, 51.4, 35.7];

function request(overrides: Partial<TopologyQueryRequest> = {}): TopologyQueryRequest {
  return { bbox: BBOX, ...overrides };
}

/** A well-formed wire response, for the tests that then break one member. */
function wire(): Record<string, unknown> {
  return {
    apiVersion: '1',
    datasetId: 'ds-1',
    bbox: BBOX,
    nodes: [
      { id: 'osm:node:41', coordinate: [51.38, 35.68], degree: 1 },
      { id: 'osm:node:42', coordinate: [51.39, 35.69], degree: 3 },
    ],
    segments: [
      {
        id: 'osm:way:10:segment:0',
        roadFeatureId: 'osm:way:10',
        startNodeId: 'osm:node:41',
        endNodeId: 'osm:node:42',
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.38, 35.68],
            [51.39, 35.69],
          ],
        },
      },
    ],
    meta: {
      segmentsReturned: 1,
      nodesReturned: 2,
      limit: 1000,
      truncated: false,
    },
  };
}

describe('buildTopologyUrl', () => {
  it('sends only the bbox when nothing else is asked for', () => {
    expect(buildTopologyUrl(request())).toBe(
      '/api/v1/map/topology?bbox=51.38%2C35.68%2C51.4%2C35.7',
    );
  });

  it('carries the limit, include and dataset pin', () => {
    const url = buildTopologyUrl(
      request({ limit: 2000, include: ['diagnostics'], dataset: 'ds-1' }),
    );
    const params = new URL(url, 'http://localhost').searchParams;
    expect(params.get('bbox')).toBe('51.38,35.68,51.4,35.7');
    expect(params.get('limit')).toBe('2000');
    expect(params.get('include')).toBe('diagnostics');
    expect(params.get('dataset')).toBe('ds-1');
  });

  it('omits an empty include rather than sending a blank parameter', () => {
    const url = buildTopologyUrl(request({ include: [] }));
    expect(new URL(url, 'http://localhost').searchParams.has('include')).toBe(false);
  });

  it('never sends a kind or a source include, which this endpoint rejects', () => {
    const url = buildTopologyUrl(request({ limit: 10, include: ['diagnostics'] }));
    const params = new URL(url, 'http://localhost').searchParams;
    expect(params.has('kind')).toBe(false);
    expect(params.get('include')).not.toContain('source');
  });

  it('rounds coordinates the same way the feature URL does', () => {
    const url = buildTopologyUrl({ bbox: [51.3812345678, 35.68, 51.4, 35.7] });
    expect(new URL(url, 'http://localhost').searchParams.get('bbox')).toBe(
      '51.381235,35.68,51.4,35.7',
    );
  });

  it('targets the topology endpoint, not the feature endpoint', () => {
    expect(buildTopologyUrl(request())).toContain('/api/v1/map/topology?');
    expect(buildTopologyUrl(request())).not.toContain('/api/v1/map/features');
  });
});

describe('parsePosition', () => {
  it('accepts a pair of finite in-range numbers', () => {
    expect(parsePosition([51.39, 35.69])).toEqual([51.39, 35.69]);
    expect(parsePosition([-180, -90])).toEqual([-180, -90]);
    expect(parsePosition([180, 90])).toEqual([180, 90]);
  });

  it('refuses anything that is not a pair of finite in-range numbers', () => {
    for (const value of [
      null,
      undefined,
      'nowhere',
      [],
      [1],
      [1, 2, 3],
      ['51.39', '35.69'],
      [Number.NaN, 35.69],
      [51.39, Number.POSITIVE_INFINITY],
      [181, 35.69],
      [51.39, 91],
      [-181, 0],
      [0, -91],
      { longitude: 51.39, latitude: 35.69 },
    ]) {
      expect(parsePosition(value)).toBeNull();
    }
  });
});

describe('parseDegree', () => {
  it('accepts a non-negative whole number', () => {
    expect(parseDegree(0)).toBe(0);
    expect(parseDegree(1)).toBe(1);
    expect(parseDegree(4)).toBe(4);
  });

  it('refuses anything else rather than guessing a degree', () => {
    for (const value of [null, undefined, '3', -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(parseDegree(value)).toBeNull();
    }
  });
});

describe('degreeCategory', () => {
  it('separates endpoints, through nodes and junctions', () => {
    expect(degreeCategory(0)).toBe('endpoint');
    expect(degreeCategory(1)).toBe('endpoint');
    expect(degreeCategory(2)).toBe('through');
    expect(degreeCategory(3)).toBe('junction');
    expect(degreeCategory(4)).toBe('junction');
    expect(degreeCategory(17)).toBe('junction');
  });

  it('reports an unreadable degree as unknown, never as an endpoint', () => {
    expect(degreeCategory(null)).toBe('unknown');
  });

  it('only ever answers with a declared category', () => {
    for (const degree of [null, 0, 1, 2, 3, 9]) {
      expect(DEGREE_CATEGORIES).toContain(degreeCategory(degree));
    }
  });
});

describe('parseTopology', () => {
  it('reads a well-formed response exactly', () => {
    const graph = parseTopology(wire());
    expect(graph.datasetId).toBe('ds-1');
    expect(graph.segmentsReturned).toBe(1);
    expect(graph.nodesReturned).toBe(2);
    expect(graph.limit).toBe(1000);
    expect(graph.truncated).toBe(false);
    expect(graph.diagnostics).toBeNull();

    expect(graph.nodes).toEqual([
      { id: 'osm:node:41', coordinate: [51.38, 35.68], degree: 1, category: 'endpoint' },
      { id: 'osm:node:42', coordinate: [51.39, 35.69], degree: 3, category: 'junction' },
    ]);
    expect(graph.segments).toEqual([
      {
        id: 'osm:way:10:segment:0',
        roadFeatureId: 'osm:way:10',
        startNodeId: 'osm:node:41',
        endNodeId: 'osm:node:42',
        coordinates: [
          [51.38, 35.68],
          [51.39, 35.69],
        ],
      },
    ]);
  });

  it('reads the diagnostics block when it is there', () => {
    const payload = wire();
    (payload.meta as Record<string, unknown>).diagnostics = {
      segmentsExamined: 22,
      candidatesFound: 22,
      segmentsReturned: 1,
      nodesReturned: 2,
      elapsedMs: 0.01,
    };
    expect(parseTopology(payload).diagnostics).toEqual({
      segmentsExamined: 22,
      candidatesFound: 22,
      segmentsReturned: 1,
      nodesReturned: 2,
      elapsedMs: 0.01,
    });
  });

  it('returns an empty graph for anything that is not a response', () => {
    for (const payload of [null, undefined, 'topology', 42, [], true]) {
      expect(parseTopology(payload)).toEqual(EMPTY_GRAPH);
    }
  });

  it('returns an empty graph when nodes and segments are not arrays', () => {
    const graph = parseTopology({ datasetId: 'ds-1', nodes: 'lots', segments: { a: 1 } });
    expect(graph.nodes).toEqual([]);
    expect(graph.segments).toEqual([]);
    expect(graph.segmentsReturned).toBe(0);
    expect(graph.nodesReturned).toBe(0);
  });

  it('drops an entry with no identity rather than showing an anonymous one', () => {
    const payload = wire();
    payload.nodes = [{ coordinate: [51.38, 35.68], degree: 1 }, ...(payload.nodes as unknown[])];
    payload.segments = [{ roadFeatureId: 'osm:way:10' }, ...(payload.segments as unknown[])];
    const graph = parseTopology(payload);
    expect(graph.nodes.map((node) => node.id)).toEqual(['osm:node:41', 'osm:node:42']);
    expect(graph.segments.map((segment) => segment.id)).toEqual(['osm:way:10:segment:0']);
  });

  it('keeps an entry whose other members are missing, with nulls and no invention', () => {
    const graph = parseTopology({
      nodes: [{ id: 'osm:node:41' }],
      segments: [{ id: 'osm:way:10:segment:0' }],
    });
    expect(graph.nodes[0]).toEqual({
      id: 'osm:node:41',
      coordinate: null,
      degree: null,
      category: 'unknown',
    });
    expect(graph.segments[0]).toEqual({
      id: 'osm:way:10:segment:0',
      roadFeatureId: null,
      startNodeId: null,
      endNodeId: null,
      coordinates: [],
    });
  });

  it('refuses a geometry that is not a LineString', () => {
    const payload = wire();
    payload.segments = [
      {
        id: 'osm:way:10:segment:0',
        geometry: { type: 'Polygon', coordinates: [[51.38, 35.68]] },
      },
    ];
    expect(parseTopology(payload).segments[0]?.coordinates).toEqual([]);
  });

  it('abandons a whole geometry rather than closing a gap around a bad coordinate', () => {
    // Keeping the readable points either side would join them into a straight
    // line the source never described, which is exactly what the importer
    // refuses to do with an unresolvable node reference.
    const payload = wire();
    payload.segments = [
      {
        id: 'osm:way:10:segment:0',
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.38, 35.68],
            ['nowhere', 35.69],
            [51.4, 35.7],
          ],
        },
      },
    ];
    expect(parseTopology(payload).segments[0]?.coordinates).toEqual([]);
  });

  it('reports the counts it actually holds, not the ones meta claimed', () => {
    const payload = wire();
    (payload.meta as Record<string, unknown>).segmentsReturned = 999;
    (payload.meta as Record<string, unknown>).nodesReturned = 999;
    const graph = parseTopology(payload);
    expect(graph.segmentsReturned).toBe(1);
    expect(graph.nodesReturned).toBe(2);
  });

  it('treats a non-boolean truncated flag as not truncated', () => {
    const payload = wire();
    (payload.meta as Record<string, unknown>).truncated = 'yes';
    expect(parseTopology(payload).truncated).toBe(false);
    (payload.meta as Record<string, unknown>).truncated = true;
    expect(parseTopology(payload).truncated).toBe(true);
  });

  it('reports an unreadable limit as null rather than as a default', () => {
    const payload = wire();
    (payload.meta as Record<string, unknown>).limit = 'lots';
    expect(parseTopology(payload).limit).toBeNull();
  });

  it('never throws, whatever the payload looks like', () => {
    for (const payload of [
      { nodes: [null, 1, 'x', []], segments: [null, 1, 'x', []] },
      { nodes: [{ id: 'n', coordinate: 'here', degree: 'many' }] },
      { segments: [{ id: 's', geometry: null }] },
      { segments: [{ id: 's', geometry: { type: 'LineString', coordinates: 'nope' } }] },
      { meta: 'none' },
      { meta: { diagnostics: 'none' } },
    ]) {
      expect(() => parseTopology(payload)).not.toThrow();
    }
  });

  it('keeps the coordinate order the server sent, never reversing a segment', () => {
    // A reverse one-way is drawn in source order and rotated by its arrow, not
    // by turning the geometry around. The same holds for its segment.
    const payload = wire();
    payload.segments = [
      {
        id: 'osm:way:615:segment:0',
        startNodeId: 'osm:node:31',
        endNodeId: 'osm:node:33',
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.38, 35.6],
            [51.382, 35.601],
            [51.384, 35.602],
          ],
        },
      },
    ];
    expect(parseTopology(payload).segments[0]?.coordinates).toEqual([
      [51.38, 35.6],
      [51.382, 35.601],
      [51.384, 35.602],
    ]);
  });
});

describe('drawability and indexing', () => {
  it('a segment needs two readable coordinates to be drawable', () => {
    const graph = parseTopology({
      segments: [
        { id: 'a', geometry: { type: 'LineString', coordinates: [[0, 0]] } },
        {
          id: 'b',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
        { id: 'c' },
      ],
    });
    expect(graph.segments.filter(isDrawableSegment).map((segment) => segment.id)).toEqual(['b']);
  });

  it('a node needs a readable coordinate to be drawable, and stays inspectable', () => {
    const graph = parseTopology({
      nodes: [
        { id: 'a', coordinate: [0, 0], degree: 1 },
        { id: 'b', degree: 2 },
      ],
    });
    expect(graph.nodes.filter(isDrawableNode).map((node) => node.id)).toEqual(['a']);
    // The undrawable node is still in the graph and still inspectable.
    expect(indexNodes(graph).get('b')?.degree).toBe(2);
  });

  it('indexes nodes and segments by id', () => {
    const graph = parseTopology(wire());
    expect(indexNodes(graph).get('osm:node:42')?.degree).toBe(3);
    expect(indexSegments(graph).get('osm:way:10:segment:0')?.roadFeatureId).toBe('osm:way:10');
    expect(indexNodes(graph).get('osm:node:404')).toBeUndefined();
    expect(indexSegments(graph).get('nope')).toBeUndefined();
  });
});

describe('what a topology view model refuses to carry', () => {
  it('ignores road semantics even when a server sends them', () => {
    // A segment is a structural connection, not a permitted traversal. If a
    // future server started attaching road facts to a segment, Studio would
    // still not read them: there is nowhere for them to land.
    const graph = parseTopology({
      segments: [
        {
          id: 'osm:way:10:segment:0',
          roadFeatureId: 'osm:way:10',
          startNodeId: 'a',
          endNodeId: 'b',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          direction: 'forward',
          access: 'prohibited',
          roadClass: 'motorway',
          speedLimits: { forward: { limit: { kind: 'numeric', value: '120' } } },
          name: 'Somewhere',
          tags: { highway: 'motorway' },
        },
      ],
    });
    expect(Object.keys(graph.segments[0] ?? {}).sort()).toEqual([
      'coordinates',
      'endNodeId',
      'id',
      'roadFeatureId',
      'startNodeId',
    ]);
  });

  it('has one indeterminate text and uses it for everything unreadable', () => {
    expect(INDETERMINATE).toBe('indeterminate · not stated');
  });
});
