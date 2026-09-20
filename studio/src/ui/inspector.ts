/** The feature inspector. */

import type { AtlasFeature } from '../api/types.js';
import { accessLabel, readFeatureAccess } from '../map/access.js';
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

    // Every profile, every time, and both facts for each. The map draws one
    // profile at a time, but the interesting roads are the ones where the
    // profiles disagree, and you cannot see a disagreement one profile at a
    // time. Direction and access are listed side by side for the same reason:
    // a road can be one-way and prohibited, and reading only one of the two
    // would be reading half the road.
    const directions = readFeatureDirections(feature.properties);
    const access = readFeatureAccess(feature.properties);
    for (const candidate of TRAVEL_PROFILES) {
      const active = candidate === profile;
      const name = PROFILE_LABELS[candidate];

      const direction = directions[candidate];
      const directionValue = element('dd', 'row-value', directionLabel(direction));
      directionValue.dataset.direction = direction;
      list.append(this.term(`${name} direction`, active), directionValue);

      const rule = access[candidate];
      const accessValue = element('dd', 'row-value', accessLabel(rule));
      accessValue.dataset.access = rule;
      list.append(this.term(`${name} access`, active), accessValue);
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

  /** A row label, marked when it belongs to the profile the map is drawing. */
  private term(text: string, active: boolean): HTMLElement {
    const term = element('dt', active ? 'row-term row-active' : 'row-term', text);
    if (active) {
      term.setAttribute('aria-current', 'true');
    }
    return term;
  }
}
