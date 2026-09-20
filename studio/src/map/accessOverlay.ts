/**
 * The access overlay layers.
 *
 * Three thin dashed lines drawn *over* the road but *under* everything that
 * means "you are pointing at this": one amber for restricted access, one red
 * for prohibited, one purple for dynamic or unresolved. Which roads each one
 * covers is decided entirely by a filter on the flattened access property of
 * the selected profile, so changing profile is a filter swap and nothing else.
 *
 * Three rules shaped the drawing:
 *
 * * The road's own colour must survive. The overlay is narrower than the road
 *   and dashed, so the class colour shows on both sides of it and through the
 *   gaps. An overlay that painted over the road would trade one fact for
 *   another.
 * * Each category must be tellable apart without reading the legend, and
 *   without relying on colour alone. The three dash patterns differ in rhythm
 *   as well as in hue.
 * * Access must never be mistaken for direction. The overlay sits below the
 *   arrows, so a prohibited one-way still shows its arrow on top.
 */

import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

import {
  OVERLAY_CATEGORIES,
  accessPropertyKey,
  rulesInCategory,
  type OverlayCategory,
} from './access.js';
import { ROAD_SOURCE_ID, roadWidth } from './roadLayers.js';
import { type TravelProfile } from './traversal.js';

/** The layer id for one overlay category. */
export function accessLayerId(category: OverlayCategory): string {
  return `atlas-roads-access-${category}`;
}

/** Every access overlay layer id, in draw order. */
export const ACCESS_LAYER_IDS: string[] = OVERLAY_CATEGORIES.map(accessLayerId);

/**
 * How each category is drawn.
 *
 * The colours are picked for the dark panel background Studio already uses:
 * amber and red are far enough apart in hue to survive a thin line, and the
 * purple is light enough not to disappear against `#0c1017`.
 *
 * Dash arrays are in units of line width, so a narrower line also means a
 * shorter dash. The rhythms are deliberately unalike: long strokes for
 * restricted, tight beads for prohibited, a long-short morse for uncertain.
 */
export const ACCESS_OVERLAY_STYLE: Record<
  OverlayCategory,
  { color: string; dashArray: number[]; widthScale: number }
> = {
  restricted: { color: '#ffb02e', dashArray: [2.2, 1.6], widthScale: 0.5 },
  prohibited: { color: '#ff5d5d', dashArray: [0.9, 0.9], widthScale: 0.62 },
  uncertain: { color: '#c79bf2', dashArray: [3.2, 1, 0.8, 1], widthScale: 0.5 },
};

/**
 * Matches the roads whose selected profile falls in one category.
 *
 * The rules are listed out rather than computed on the fly so that the filter
 * is a plain data literal a test can compare against, and so that a rule added
 * to the vocabulary has to be placed in a category before it can be drawn.
 */
export function accessFilter(
  profile: TravelProfile,
  category: OverlayCategory,
): ExpressionSpecification {
  return ['in', ['get', accessPropertyKey(profile)], ['literal', rulesInCategory(category)]];
}

/** One overlay layer for one category and one profile. */
export function accessOverlayLayer(
  category: OverlayCategory,
  profile: TravelProfile,
): LayerSpecification {
  const style = ACCESS_OVERLAY_STYLE[category];
  return {
    id: accessLayerId(category),
    type: 'line',
    source: ROAD_SOURCE_ID,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    filter: accessFilter(profile, category),
    paint: {
      'line-color': style.color,
      'line-width': roadWidth(0, style.widthScale),
      'line-dasharray': style.dashArray,
      'line-opacity': 0.95,
    },
  };
}

/** Every overlay layer for one profile, in draw order. */
export function accessOverlayLayers(profile: TravelProfile): LayerSpecification[] {
  return OVERLAY_CATEGORIES.map((category) => accessOverlayLayer(category, profile));
}

/**
 * The slice of the map Studio needs to re-filter the overlays.
 *
 * Structural rather than the MapLibre type, so that the profile switch can be
 * tested without a WebGL context — and so that the test can prove the switch
 * touches nothing else.
 */
export interface AccessLayerTarget {
  getLayer(id: string): unknown;
  setFilter(id: string, filter: ExpressionSpecification): void;
}

/**
 * Re-points every overlay at the newly selected profile.
 *
 * Returns whether the layers were there to update, so a caller running before
 * the style has loaded can tell the difference between "done" and "not yet".
 * Note what this does *not* do: no fetch, no source update, no geometry
 * change, no viewport read, and no touch of the hover, selection or arrow
 * layers.
 */
export function applyAccessProfile(target: AccessLayerTarget, profile: TravelProfile): boolean {
  if (!OVERLAY_CATEGORIES.every((category) => target.getLayer(accessLayerId(category)))) {
    return false;
  }
  for (const category of OVERLAY_CATEGORIES) {
    target.setFilter(accessLayerId(category), accessFilter(profile, category));
  }
  return true;
}
