/** The feature inspector. */

import type { AtlasFeature } from '../api/types.js';
import { boundsOfCoordinates, formatBbox } from '../viewport/bbox.js';
import { appendRow, clear, element, formatNumber } from './dom.js';

export interface InspectorSelection {
  feature: AtlasFeature;
  /**
   * False once a viewport refresh no longer returns the selected feature.
   * The panel keeps showing what it last knew rather than blanking out.
   */
  inCurrentViewport: boolean;
}

export class InspectorPanel {
  constructor(private readonly root: HTMLElement) {}

  render(selection: InspectorSelection | null): void {
    clear(this.root);

    if (!selection) {
      this.root.append(element('p', 'note', 'Click a road to inspect it.'));
      return;
    }

    const { feature, inCurrentViewport } = selection;
    const coordinates = feature.geometry.coordinates;
    const bounds = boundsOfCoordinates(coordinates);

    const list = element('dl', 'rows');
    // Every value below is written as text, never as markup.
    appendRow(list, 'Feature ID', feature.id, feature.id);
    appendRow(list, 'Kind', feature.properties.kind);
    appendRow(list, 'Road class', feature.properties.roadClass ?? '—');
    appendRow(list, 'Name', feature.properties.name ?? '(unnamed)');

    const source = feature.properties.source;
    appendRow(
      list,
      'Source',
      source ? `${source.system}:${source.entityType}/${source.entityId}` : 'not included',
    );

    appendRow(list, 'Coordinates', formatNumber(coordinates.length));
    appendRow(list, 'Bounds', bounds ? formatBbox(bounds) : '—');
    this.root.append(list);

    if (!inCurrentViewport) {
      this.root.append(
        element('p', 'note note-warn', 'This feature is outside the current viewport query.'),
      );
    }
  }
}
