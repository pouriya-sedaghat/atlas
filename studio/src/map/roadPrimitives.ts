/**
 * Shared road-rendering primitives.
 *
 * The things every road layer needs before it can draw anything: which source
 * the geometry comes from, which property carries the feature id, and how wide
 * a road of a given class is at a given zoom.
 *
 * This module is the bottom of the map dependency graph on purpose. It imports
 * nothing but MapLibre's types, so the leaf layer builders can depend on it
 * without depending on the composition root that assembles them.
 */

import type { ExpressionSpecification } from 'maplibre-gl';

export const ROAD_SOURCE_ID = 'atlas-roads';

/** The property Studio copies a feature id into so filters can match on it. */
export const FEATURE_KEY = 'atlasId';

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
