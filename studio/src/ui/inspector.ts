/** The feature inspector. */

import type { AtlasFeature } from '../api/types.js';
import {
  DEFAULT_PROFILE,
  PROFILE_LABELS,
  TRAVEL_PROFILES,
  directionLabel,
  readFeatureDirections,
} from '../map/traversal.js';
import type { TravelProfile } from '../map/traversal.js';
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

  render(selection: InspectorSelection | null, profile: TravelProfile = DEFAULT_PROFILE): void {
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

    // Every profile, every time. The map draws one profile at a time, but the
    // interesting roads are the ones where the profiles disagree, and you
    // cannot see a disagreement one profile at a time.
    const directions = readFeatureDirections(feature.properties);
    for (const candidate of TRAVEL_PROFILES) {
      const direction = directions[candidate];
      const active = candidate === profile;
      const term = element(
        'dt',
        active ? 'row-term row-active' : 'row-term',
        `${PROFILE_LABELS[candidate]} direction`,
      );
      if (active) {
        term.setAttribute('aria-current', 'true');
      }
      const value = element('dd', 'row-value', directionLabel(direction));
      value.dataset.direction = direction;
      list.append(term, value);
    }

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
