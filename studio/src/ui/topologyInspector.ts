/**
 * The topology inspector.
 *
 * Shows what Studio knows about one topology node or one topology segment,
 * and nothing it does not know. Every value is written through `textContent`,
 * because node ids, segment ids and road feature ids all originate in an OSM
 * file and are untrusted text.
 *
 * What is deliberately absent is as much the point as what is here. A segment
 * panel shows no direction, no access, no speed and no road class, because a
 * segment carries none of them. It shows the owning `roadFeatureId` instead,
 * and the road inspector is one click away on the road itself.
 */

import { INDETERMINATE, type TopologyNodeView, type TopologySegmentView } from '../map/topology.js';
import { appendRow, clear, element, formatNumber } from './dom.js';

/** What the topology inspector is currently showing. */
export type TopologySelection =
  { kind: 'node'; node: TopologyNodeView } | { kind: 'segment'; segment: TopologySegmentView };

/** Formats a position for display, or says it is not stated. */
export function formatPosition(coordinate: readonly [number, number] | null): string {
  if (coordinate === null) {
    return INDETERMINATE;
  }
  return `${coordinate[0].toFixed(5)}, ${coordinate[1].toFixed(5)}`;
}

/**
 * How a degree is described in words.
 *
 * The words name the shape of the junction, never its importance: a reader
 * must not come away thinking a degree-5 node is a more significant road than
 * a degree-2 one.
 */
export function degreeLabel(node: TopologyNodeView): string {
  if (node.degree === null) {
    return INDETERMINATE;
  }
  const suffix =
    node.category === 'junction'
      ? ' · junction'
      : node.category === 'through'
        ? ' · through'
        : ' · endpoint';
  return `${formatNumber(node.degree)}${suffix}`;
}

export class TopologyInspectorPanel {
  constructor(private readonly root: HTMLElement) {}

  render(selection: TopologySelection | null, enabled: boolean): void {
    clear(this.root);

    if (!enabled) {
      this.root.append(
        element('p', 'note', 'Enable the road topology overlay to inspect nodes and segments.'),
      );
      return;
    }
    if (!selection) {
      this.root.append(element('p', 'note', 'Click a topology node or segment to inspect it.'));
      return;
    }

    const list = element('dl', 'rows');
    if (selection.kind === 'node') {
      const { node } = selection;
      appendRow(list, 'Node ID', node.id, node.id);
      appendRow(list, 'Coordinate', formatPosition(node.coordinate));
      const degree = element('dd', 'row-value', degreeLabel(node));
      degree.dataset.degreeCategory = node.category;
      list.append(element('dt', 'row-term', 'Degree'), degree);
      this.root.append(list);
      this.root.append(
        element(
          'p',
          'note',
          'Degree counts segment ends across the whole dataset, not this viewport. ' +
            'A self-loop contributes two. It is a shape, not a measure of importance.',
        ),
      );
      return;
    }

    const { segment } = selection;
    appendRow(list, 'Segment ID', segment.id, segment.id);
    appendRow(list, 'Road feature ID', segment.roadFeatureId ?? INDETERMINATE);
    appendRow(list, 'Start node ID', segment.startNodeId ?? INDETERMINATE);
    appendRow(list, 'End node ID', segment.endNodeId ?? INDETERMINATE);
    appendRow(list, 'Geometry points', formatNumber(segment.coordinates.length));
    this.root.append(list);
    this.root.append(
      element(
        'p',
        'note',
        'Start and end are the first and last point of the geometry in source order, ' +
          'not a direction of travel. A segment is a structural connection: it is not ' +
          'evidence that any mode may traverse it. Direction, access and speed are facts ' +
          'on the road feature above.',
      ),
    );
  }
}
