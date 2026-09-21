// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  INDETERMINATE,
  parseTopology,
  type TopologyGraph,
  type TopologyNodeView,
  type TopologySegmentView,
} from '../src/map/topology.js';
import { NODE_STYLE } from '../src/map/topologyLayers.js';
import {
  TopologyInspectorPanel,
  degreeLabel,
  formatPosition,
  type TopologySelection,
} from '../src/ui/topologyInspector.js';
import { CATEGORY_LABELS, TopologyLegend, TopologyStatusPanel } from '../src/ui/topologyPanel.js';
import type { CurrentDataset, ImportStatistics } from '../src/api/types.js';
import { DatasetPanel } from '../src/ui/panels.js';

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

function rows(container: HTMLElement): Record<string, string> {
  const terms = [...container.querySelectorAll('dt')];
  const values = [...container.querySelectorAll('dd')];
  const entries: Record<string, string> = {};
  terms.forEach((term, index) => {
    entries[term.textContent ?? ''] = values[index]?.textContent ?? '';
  });
  return entries;
}

function graph(): TopologyGraph {
  return parseTopology({
    datasetId: 'ds-1',
    nodes: [
      { id: 'osm:node:5', coordinate: [51.312, 35.6], degree: 3 },
      { id: 'osm:node:17', coordinate: [51.34, 35.6], degree: 2 },
      { id: 'osm:node:1', coordinate: [51.3, 35.6], degree: 1 },
      { id: 'osm:node:404' },
    ],
    segments: [
      {
        id: 'osm:way:601:segment:0',
        roadFeatureId: 'osm:way:601',
        startNodeId: 'osm:node:1',
        endNodeId: 'osm:node:3',
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.3, 35.6],
            [51.301, 35.601],
            [51.302, 35.602],
          ],
        },
      },
      { id: 'osm:way:602:segment:0' },
    ],
    meta: {
      limit: 2000,
      truncated: true,
      diagnostics: {
        segmentsExamined: 22,
        candidatesFound: 30,
        segmentsReturned: 2,
        nodesReturned: 4,
        elapsedMs: 0.012,
      },
    },
  });
}

function node(id: string): TopologyNodeView {
  const found = graph().nodes.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no node ${id}`);
  }
  return found;
}

function segment(id: string): TopologySegmentView {
  const found = graph().segments.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no segment ${id}`);
  }
  return found;
}

function nodeSelection(id: string): TopologySelection {
  return { kind: 'node', node: node(id) };
}

function segmentSelection(id: string): TopologySelection {
  return { kind: 'segment', segment: segment(id) };
}

describe('formatPosition', () => {
  it('shows a coordinate to five decimals', () => {
    expect(formatPosition([51.3123456, 35.6])).toBe('51.31235, 35.60000');
  });

  it('says a missing coordinate is not stated rather than showing a zero', () => {
    expect(formatPosition(null)).toBe(INDETERMINATE);
    expect(formatPosition(null)).not.toContain('0');
  });
});

describe('degreeLabel', () => {
  it('names the shape of the junction, not its importance', () => {
    expect(degreeLabel(node('osm:node:1'))).toBe('1 · endpoint');
    expect(degreeLabel(node('osm:node:17'))).toBe('2 · through');
    expect(degreeLabel(node('osm:node:5'))).toBe('3 · junction');
  });

  it('never suggests a rank, a size or a speed', () => {
    for (const id of ['osm:node:1', 'osm:node:17', 'osm:node:5', 'osm:node:404']) {
      const label = degreeLabel(node(id));
      for (const forbidden of ['major', 'minor', 'important', 'primary', 'fast', 'main']) {
        expect(label.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('reports an unstated degree as indeterminate, never as zero', () => {
    expect(degreeLabel(node('osm:node:404'))).toBe(INDETERMINATE);
  });
});

describe('TopologyInspectorPanel', () => {
  it('says the overlay is off when it is off', () => {
    new TopologyInspectorPanel(root).render(null, false);
    expect(root.textContent).toContain('Enable the road topology overlay');
    expect(root.querySelector('dl')).toBeNull();
  });

  it('prompts for a selection when the overlay is on and nothing is selected', () => {
    new TopologyInspectorPanel(root).render(null, true);
    expect(root.textContent).toContain('Click a topology node or segment');
  });

  it('renders a node exactly', () => {
    new TopologyInspectorPanel(root).render(nodeSelection('osm:node:5'), true);
    expect(rows(root)).toEqual({
      'Node ID': 'osm:node:5',
      Coordinate: '51.31200, 35.60000',
      Degree: '3 · junction',
    });
    const degree = root.querySelector<HTMLElement>('dd[data-degree-category]');
    expect(degree?.dataset.degreeCategory).toBe('junction');
    // The panel says what degree is, and what it is not.
    expect(root.textContent).toContain('whole dataset, not this viewport');
    expect(root.textContent).toContain('not a measure of importance');
  });

  it('renders a segment exactly, with no road semantics', () => {
    new TopologyInspectorPanel(root).render(segmentSelection('osm:way:601:segment:0'), true);
    expect(rows(root)).toEqual({
      'Segment ID': 'osm:way:601:segment:0',
      'Road feature ID': 'osm:way:601',
      'Start node ID': 'osm:node:1',
      'End node ID': 'osm:node:3',
      'Geometry points': '3',
    });
    for (const absent of ['Direction', 'Access', 'Speed', 'Road class', 'Name']) {
      expect(Object.keys(rows(root))).not.toContain(absent);
    }
    expect(root.textContent).toContain('not a direction of travel');
    expect(root.textContent).toContain('not evidence that any mode may traverse it');
  });

  it('shows indeterminate text for every member the server left out', () => {
    new TopologyInspectorPanel(root).render(segmentSelection('osm:way:602:segment:0'), true);
    expect(rows(root)).toEqual({
      'Segment ID': 'osm:way:602:segment:0',
      'Road feature ID': INDETERMINATE,
      'Start node ID': INDETERMINATE,
      'End node ID': INDETERMINATE,
      'Geometry points': '0',
    });

    new TopologyInspectorPanel(root).render(nodeSelection('osm:node:404'), true);
    expect(rows(root)).toEqual({
      'Node ID': 'osm:node:404',
      Coordinate: INDETERMINATE,
      Degree: INDETERMINATE,
    });
  });

  it('writes every wire string as a text node, never as markup', () => {
    const hostile = parseTopology({
      segments: [
        {
          id: '<img src=x onerror="alert(1)">',
          roadFeatureId: '<script>alert(2)</script>',
          startNodeId: '<b>bold</b>',
          endNodeId: '"><svg onload=alert(3)>',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    });
    const [hostileSegment] = hostile.segments;
    expect(hostileSegment).toBeDefined();
    new TopologyInspectorPanel(root).render(
      { kind: 'segment', segment: hostileSegment as TopologySegmentView },
      true,
    );

    // Nothing was parsed as markup.
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('svg')).toBeNull();
    // And the text is all there, verbatim.
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain('<script>alert(2)</script>');
    expect(root.textContent).toContain('<b>bold</b>');
    // Every value lives in a text node.
    for (const value of root.querySelectorAll('dd')) {
      for (const child of value.childNodes) {
        expect(child.nodeType).toBe(Node.TEXT_NODE);
      }
    }
  });

  it('replaces its contents rather than appending on every render', () => {
    const panel = new TopologyInspectorPanel(root);
    panel.render(nodeSelection('osm:node:5'), true);
    panel.render(nodeSelection('osm:node:1'), true);
    expect(root.querySelectorAll('dl')).toHaveLength(1);
    expect(rows(root)['Node ID']).toBe('osm:node:1');

    panel.render(null, false);
    expect(root.querySelector('dl')).toBeNull();
  });
});

describe('TopologyStatusPanel', () => {
  it('says nothing is being requested when topology is off', () => {
    new TopologyStatusPanel(root).render({ kind: 'off' });
    expect(root.textContent).toContain('making no topology requests');
  });

  it('reports a ready graph with its counts and diagnostics', () => {
    new TopologyStatusPanel(root).render({ kind: 'ready', graph: graph() });
    expect(rows(root)).toEqual({
      'Dataset ID': 'ds-1',
      Segments: '2',
      Nodes: '4',
      Limit: '2,000',
      Truncated: 'yes',
      Examined: '22',
      Candidates: '30',
      'Query time': '0.012 ms',
    });
  });

  it('says diagnostics were not requested rather than showing zeroes', () => {
    const withoutDiagnostics = parseTopology({ nodes: [], segments: [], meta: { limit: 1000 } });
    new TopologyStatusPanel(root).render({ kind: 'ready', graph: withoutDiagnostics });
    expect(rows(root).Diagnostics).toBe('not requested');
    expect(Object.keys(rows(root))).not.toContain('Examined');
  });

  it('shows indeterminate text where the server said nothing readable', () => {
    const vague = parseTopology({ nodes: [], segments: [], meta: { limit: 'lots' } });
    new TopologyStatusPanel(root).render({ kind: 'ready', graph: vague });
    expect(rows(root)['Dataset ID']).toBe(INDETERMINATE);
    expect(rows(root).Limit).toBe(INDETERMINATE);
  });

  it('reports a failure and says the road map is unaffected', () => {
    new TopologyStatusPanel(root).render({ kind: 'failed', message: 'INVALID_QUERY: nope' });
    expect(root.textContent).toContain('INVALID_QUERY: nope');
    expect(root.textContent).toContain('The road map is unaffected.');
    expect(root.querySelector('.note-bad')).not.toBeNull();
  });

  it('writes a failure message as text, never as markup', () => {
    new TopologyStatusPanel(root).render({
      kind: 'failed',
      message: '<img src=x onerror="alert(1)">',
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('TopologyLegend', () => {
  it('renders nothing while the overlay is off', () => {
    new TopologyLegend(root).render(false);
    expect(root.childNodes).toHaveLength(0);
  });

  it('names every degree category with its own swatch colour', () => {
    new TopologyLegend(root).render(true);
    const items = [...root.querySelectorAll('.legend-item')];
    expect(items.map((item) => item.querySelector('.legend-label')?.textContent)).toEqual([
      CATEGORY_LABELS.endpoint,
      CATEGORY_LABELS.through,
      CATEGORY_LABELS.junction,
      CATEGORY_LABELS.unknown,
    ]);
    const swatches = [...root.querySelectorAll<HTMLElement>('.legend-swatch')];
    expect(swatches.map((swatch) => swatch.dataset.degreeCategory)).toEqual([
      'endpoint',
      'through',
      'junction',
      'unknown',
    ]);
    expect(swatches[2]?.style.backgroundColor).toBe(hexToRgb(NODE_STYLE.junction.color));
  });

  it('says plainly that degree is not importance', () => {
    new TopologyLegend(root).render(true);
    expect(root.textContent).toContain('not how important, fast or usable');
  });

  it('clears itself when the overlay is switched off', () => {
    const legend = new TopologyLegend(root);
    legend.render(true);
    expect(root.querySelectorAll('.legend-item').length).toBeGreaterThan(0);
    legend.render(false);
    expect(root.childNodes).toHaveLength(0);
  });
});

/** jsdom normalises an inline colour to `rgb(...)`. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

describe('the additive topology statistics', () => {
  /** The counters an Atlas v1 server sent before Milestone 2D. */
  function olderStatistics(): ImportStatistics {
    return {
      elapsedMs: 0.5,
      nodesSeen: 38,
      nodesIndexed: 38,
      waysSeen: 18,
      roadWaysSelected: 17,
      featuresEmitted: 16,
      featuresSkipped: 1,
      relationsSeen: 1,
      bytesRead: 10033,
      featureCount: 16,
    };
  }

  function dataset(statistics: ImportStatistics): CurrentDataset {
    return {
      apiVersion: '1',
      status: 'ready',
      datasetId: 'ds-1',
      source: { name: 'roads-topology.osm', format: 'osm-xml' },
      statistics,
      warnings: [],
    };
  }

  it('describes a Milestone 2D server without widening any existing counter', () => {
    // The two new members sit beside the old ones; none of the old ones
    // changed meaning, and the type still requires every one of them.
    const current: ImportStatistics = {
      ...olderStatistics(),
      topologyNodes: 31,
      topologySegments: 22,
    };
    expect(current.topologyNodes).toBe(31);
    expect(current.topologySegments).toBe(22);
    // Final dataset counts, deliberately not equal to the source counters
    // they are most likely to be confused with.
    expect(current.topologyNodes).not.toBe(current.nodesIndexed);
    expect(current.topologySegments).not.toBe(current.featureCount);
  });

  it('stays compatible with a server that never heard of topology', () => {
    // Absent is not zero. A Studio build has to be able to describe an older
    // server's response without claiming it reported an empty topology.
    const older = olderStatistics();
    expect(older.topologyNodes).toBeUndefined();
    expect(older.topologySegments).toBeUndefined();
    expect(older.topologyNodes ?? null).not.toBe(0);
  });

  it('renders the dataset panel identically with and without them', () => {
    // The members are additive on the wire and the existing panel is
    // untouched: a 2D server and a 2B server produce the same rows.
    const withTopology = document.createElement('div');
    const withoutTopology = document.createElement('div');
    new DatasetPanel(withTopology).render(
      dataset({ ...olderStatistics(), topologyNodes: 31, topologySegments: 22 }),
      null,
    );
    new DatasetPanel(withoutTopology).render(dataset(olderStatistics()), null);
    expect(withTopology.innerHTML).toBe(withoutTopology.innerHTML);
    expect(rows(withTopology).Features).toBe('16');
  });
});
