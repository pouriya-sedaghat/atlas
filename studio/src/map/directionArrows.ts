/**
 * The one-way arrow layer.
 *
 * Arrows are a presentation decision, so all of it lives on the client. The
 * server says `forward`; Studio decides that means a triangle every so many
 * pixels, pointing along the line as the source drew it.
 *
 * Changing profile never reloads anything: the layer stays put and only its
 * filter and its rotation expression are swapped, both derived from the
 * flattened direction property for the newly selected profile.
 */

import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

import { ARROW_IMAGE_ID } from './arrowImage.js';
import { ROAD_SOURCE_ID } from './roadPrimitives.js';
import { directionPropertyKey, type TravelProfile } from './traversal.js';

export const ROAD_DIRECTION_LAYER_ID = 'atlas-roads-direction';

/** The paint/layout property the profile switch rewrites. */
export const ARROW_ROTATE_PROPERTY = 'icon-rotate';

/**
 * Matches only the roads that have a direction worth drawing.
 *
 * `both` has no one-way direction; `reversible`, `alternating` and
 * `indeterminate` have no direction Atlas will state. All four are filtered
 * out rather than given an arrow that would be fiction.
 */
export function directionFilter(profile: TravelProfile): ExpressionSpecification {
  return ['in', ['get', directionPropertyKey(profile)], ['literal', ['forward', 'reverse']]];
}

/**
 * Turns the arrow around for a reverse road.
 *
 * The geometry is never touched: a reverse one-way is the same line drawn the
 * same way round, with its arrow rotated half a turn.
 */
export function directionRotation(profile: TravelProfile): ExpressionSpecification {
  return ['case', ['==', ['get', directionPropertyKey(profile)], 'reverse'], 180, 0];
}

/** The arrow layer for one profile. */
export function directionArrowLayer(profile: TravelProfile): LayerSpecification {
  return {
    id: ROAD_DIRECTION_LAYER_ID,
    type: 'symbol',
    source: ROAD_SOURCE_ID,
    // Arrows are fiddly at low zoom and would just be noise.
    minzoom: 13,
    filter: directionFilter(profile),
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 92,
      'icon-image': ARROW_IMAGE_ID,
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      [ARROW_ROTATE_PROPERTY]: directionRotation(profile),
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.55, 17, 0.9],
      'icon-allow-overlap': false,
      'icon-ignore-placement': false,
      'icon-padding': 3,
    },
    paint: { 'icon-opacity': 0.92 },
  };
}

/**
 * The slice of the map Studio needs to re-point the arrows.
 *
 * Structural rather than the MapLibre type, so that the profile switch can be
 * tested without a WebGL context — and so that the test can prove the switch
 * touches nothing else.
 */
export interface DirectionLayerTarget {
  getLayer(id: string): unknown;
  setFilter(id: string, filter: ExpressionSpecification): void;
  setLayoutProperty(id: string, name: string, value: unknown): void;
}

/**
 * Re-points every arrow at the newly selected profile.
 *
 * Returns whether the layer was there to update, so a caller running before
 * the style has loaded can tell the difference between "done" and "not yet".
 * Note what this does *not* do: no fetch, no source update, no geometry
 * change, no viewport read.
 */
export function applyDirectionProfile(
  target: DirectionLayerTarget,
  profile: TravelProfile,
): boolean {
  if (!target.getLayer(ROAD_DIRECTION_LAYER_ID)) {
    return false;
  }
  target.setFilter(ROAD_DIRECTION_LAYER_ID, directionFilter(profile));
  target.setLayoutProperty(
    ROAD_DIRECTION_LAYER_ID,
    ARROW_ROTATE_PROPERTY,
    directionRotation(profile),
  );
  return true;
}
