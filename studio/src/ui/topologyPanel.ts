/**
 * The topology status panel and its legend.
 *
 * The status panel says what the last topology query returned and what it
 * cost; the legend says what the node colours mean. Both are text written
 * through `textContent`, and neither invents a number the server did not send.
 */

import { DEGREE_CATEGORIES, INDETERMINATE, type TopologyGraph } from '../map/topology.js';
import { NODE_STYLE } from '../map/topologyLayers.js';
import { appendRow, clear, element, formatMillis, formatNumber } from './dom.js';

/** What the topology query is currently doing. */
export type TopologyState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; graph: TopologyGraph }
  | { kind: 'failed'; message: string };

/** What each degree category means, in words that describe shape, not rank. */
export const CATEGORY_LABELS: Record<(typeof DEGREE_CATEGORIES)[number], string> = {
  endpoint: 'Endpoint · one segment end',
  through: 'Through · two segment ends',
  junction: 'Junction · three or more',
  unknown: 'Degree not stated',
};

/** The last topology query's result and cost. */
export class TopologyStatusPanel {
  constructor(private readonly root: HTMLElement) {}

  render(state: TopologyState): void {
    clear(this.root);

    switch (state.kind) {
      case 'off':
        this.root.append(
          element('p', 'note', 'Topology is off. Studio is making no topology requests.'),
        );
        return;
      case 'idle':
        this.root.append(element('p', 'note', 'Waiting for a dataset.'));
        return;
      case 'loading':
        this.root.append(element('p', 'note', 'Querying topology…'));
        return;
      case 'failed':
        // A failed topology query never removes or corrupts the road map, and
        // the panel says so rather than leaving the reader to wonder.
        this.root.append(
          element('p', 'note note-bad', state.message),
          element('p', 'note', 'The road map is unaffected.'),
        );
        return;
      case 'ready': {
        const { graph } = state;
        const list = element('dl', 'rows');
        appendRow(list, 'Dataset ID', graph.datasetId ?? INDETERMINATE);
        appendRow(list, 'Segments', formatNumber(graph.segmentsReturned));
        appendRow(list, 'Nodes', formatNumber(graph.nodesReturned));
        appendRow(list, 'Limit', graph.limit === null ? INDETERMINATE : formatNumber(graph.limit));
        appendRow(list, 'Truncated', graph.truncated ? 'yes' : 'no');
        const { diagnostics } = graph;
        if (diagnostics) {
          appendRow(
            list,
            'Examined',
            diagnostics.segmentsExamined === null
              ? INDETERMINATE
              : formatNumber(diagnostics.segmentsExamined),
          );
          appendRow(
            list,
            'Candidates',
            diagnostics.candidatesFound === null
              ? INDETERMINATE
              : formatNumber(diagnostics.candidatesFound),
          );
          appendRow(
            list,
            'Query time',
            diagnostics.elapsedMs === null ? INDETERMINATE : formatMillis(diagnostics.elapsedMs),
          );
        } else {
          appendRow(list, 'Diagnostics', 'not requested');
        }
        this.root.append(list);
        return;
      }
    }
  }
}

/** What the node colours mean. */
export class TopologyLegend {
  constructor(private readonly root: HTMLElement) {}

  render(enabled: boolean): void {
    clear(this.root);
    if (!enabled) {
      return;
    }
    const list = element('ul', 'legend');
    for (const category of DEGREE_CATEGORIES) {
      const item = element('li', 'legend-item');
      const swatch = element('span', 'legend-swatch');
      swatch.style.backgroundColor = NODE_STYLE[category].color;
      swatch.dataset.degreeCategory = category;
      item.append(swatch, element('span', 'legend-label', CATEGORY_LABELS[category]));
      list.append(item);
    }
    this.root.append(list);
    this.root.append(
      element(
        'p',
        'note',
        'Degree describes the shape of a junction, not how important, fast or usable ' +
          'the roads meeting there are.',
      ),
    );
  }
}
