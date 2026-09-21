/** The feature inspector. */

import type { AtlasFeature } from '../api/types.js';
import { accessLabel, readFeatureAccess } from '../map/access.js';
import { SPEED_DIRECTIONS, readFeatureSpeeds, speedLabel } from '../map/speed.js';
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

    // Every profile, every time, and all four facts for each. The map draws
    // one profile at a time, but the interesting roads are the ones where the
    // profiles disagree, and you cannot see a disagreement one profile at a
    // time. Direction, access and the two speed directions are listed side by
    // side for the same reason: a road can be one-way, prohibited and signed
    // at two different limits at once, and reading only one of the four would
    // be reading a quarter of the road.
    //
    // Both speed directions are always shown, on every road, including the
    // one-ways. `forward` and `backward` are relative to the coordinate order
    // of the geometry, not to the way the traffic runs, so a one-way road has
    // two of them just like everything else.
    const directions = readFeatureDirections(feature.properties);
    const access = readFeatureAccess(feature.properties);
    const speeds = readFeatureSpeeds(feature.properties);
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

      for (const along of SPEED_DIRECTIONS) {
        const fact = speeds[candidate][along];
        // `speedLabel` is assembled from validated values only, and every
        // value below is written as text. A hostile kind, unit, magnitude or
        // code never reaches the DOM: it degraded to `indeterminate` in the
        // parser before it got here.
        const speedValue = element('dd', 'row-value', speedLabel(fact));
        speedValue.dataset.speedDirection = along;
        speedValue.dataset.speedKind = fact.limit.kind;
        speedValue.dataset.speedConditional = fact.conditional;
        speedValue.dataset.speedVariable = fact.variable;
        list.append(this.term(`${name} ${along} speed`, active), speedValue);
      }
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

  /**
   * A row label, marked when it belongs to the profile the map is drawing.
   *
   * A profile now owns four rows — direction, access, forward speed and
   * backward speed — and all four are marked. Marking fewer would tell the
   * reader that some of what they are looking at belongs to another profile.
   * The other eight rows stay visible and unmarked.
   */
  private term(text: string, active: boolean): HTMLElement {
    const term = element('dt', active ? 'row-term row-active' : 'row-term', text);
    if (active) {
      term.setAttribute('aria-current', 'true');
    }
    return term;
  }
}
