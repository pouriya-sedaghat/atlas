/**
 * Road rendering.
 *
 * Every presentation decision lives here. The server says what a road is; the
 * client decides what that looks like.
 */

import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

import { accessOverlayLayers } from './accessOverlay.js';
import { directionArrowLayer } from './directionArrows.js';
import { DEFAULT_PROFILE, type TravelProfile } from './traversal.js';

export const ROAD_SOURCE_ID = 'atlas-roads';
export const ROAD_LAYER_ID = 'atlas-roads-line';
export const ROAD_CASING_LAYER_ID = 'atlas-roads-casing';
export const ROAD_HOVER_LAYER_ID = 'atlas-roads-hover';
export const ROAD_SELECTED_LAYER_ID = 'atlas-roads-selected';
export const ROAD_HIT_LAYER_ID = 'atlas-roads-hit';

/** The property Studio copies a feature id into so filters can match on it. */
export const FEATURE_KEY = 'atlasId';

export const HOVER_COLOR = '#ffffff';
export const SELECTED_COLOR = '#ffd166';

const ROAD_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'roadClass'],
  'motorway',
  '#ff8f66',
  'trunk',
  '#ffa76b',
  'primary',
  '#ffc46b',
  'secondary',
  '#ffe08a',
  'tertiary',
  '#d8e48f',
  'residential',
  '#8fb6ff',
  'living_street',
  '#a3c3ff',
  'unclassified',
  '#9fb0c9',
  'service',
  '#74869f',
  'track',
  '#b08f6d',
  'path',
  '#7fd0a8',
  'footway',
  '#74c79c',
  'cycleway',
  '#71d2d2',
  'steps',
  '#c08ad6',
  /* anything Atlas kept as RoadClass::Other */ '#8b93a5',
];

const CLASS_WEIGHT: ExpressionSpecification = [
  'match',
  ['get', 'roadClass'],
  'motorway',
  1.9,
  'trunk',
  1.7,
  'primary',
  1.45,
  'secondary',
  1.3,
  'tertiary',
  1.15,
  'residential',
  1,
  'living_street',
  0.95,
  'unclassified',
  0.95,
  'service',
  0.8,
  'track',
  0.75,
  'path',
  0.65,
  'footway',
  0.65,
  'cycleway',
  0.7,
  'steps',
  0.6,
  0.9,
];

/**
 * Line width.
 *
 * MapLibre insists that a `zoom` expression be the top-level expression of a
 * paint property, so the per-class weighting happens inside each zoom stop
 * rather than wrapping the interpolation.
 *
 * `extra` adds a constant to every stop, which is how the casing and the
 * highlights sit proud of the road. `scale` multiplies the class-weighted base
 * instead, which is how the access overlay sits *inside* the road: a fraction
 * of its width at every zoom, so the class colour is still visible on both
 * sides of it however far you zoom in.
 */
export function roadWidth(extra = 0, scale = 1): ExpressionSpecification {
  const stop = (base: number): ExpressionSpecification => {
    const weighted: ExpressionSpecification = ['*', base * scale, CLASS_WEIGHT];
    return extra === 0 ? weighted : ['+', weighted, extra];
  };

  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    stop(0.6),
    12,
    stop(1.4),
    15,
    stop(3),
    18,
    stop(8),
  ];
}

/**
 * The layers, bottom to top: a dark casing, the road itself, the access
 * overlays, a fat invisible hit target, the hover and selection highlights,
 * and the one-way arrows on top of all of it.
 *
 * The order is the whole design. The overlays go above the road so they can be
 * seen, and below everything else so that pointing at a road, selecting one
 * and reading its direction all keep working exactly as they did before access
 * existed.
 */
export function roadLayers(profile: TravelProfile = DEFAULT_PROFILE): LayerSpecification[] {
  return [
    {
      id: ROAD_CASING_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#05080d',
        'line-width': roadWidth(2),
        'line-opacity': 0.85,
      },
    },
    {
      id: ROAD_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROAD_COLOR, 'line-width': roadWidth() },
    },
    ...accessOverlayLayers(profile),
    {
      id: ROAD_HIT_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': roadWidth(14) },
    },
    {
      id: ROAD_HOVER_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: ['==', ['get', FEATURE_KEY], ''],
      paint: { 'line-color': HOVER_COLOR, 'line-width': roadWidth(1.5), 'line-opacity': 0.55 },
    },
    {
      id: ROAD_SELECTED_LAYER_ID,
      type: 'line',
      source: ROAD_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: ['==', ['get', FEATURE_KEY], ''],
      paint: { 'line-color': SELECTED_COLOR, 'line-width': roadWidth(2.5) },
    },
    directionArrowLayer(profile),
  ];
}

/** A filter matching exactly one feature, or nothing when no id is given. */
export function featureFilter(featureId: string | null): ExpressionSpecification {
  return ['==', ['get', FEATURE_KEY], featureId ?? ''];
}
