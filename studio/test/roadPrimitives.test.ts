import { describe, expect, it } from 'vitest';

import type { ExpressionSpecification } from 'maplibre-gl';

import { FEATURE_KEY, ROAD_SOURCE_ID, roadWidth } from '../src/map/roadPrimitives.js';

/**
 * The class weighting every zoom stop is multiplied by.
 *
 * Written out here rather than imported: the table is private to the module,
 * and a test that shares the constant with the code proves nothing about it.
 */
const CLASS_WEIGHT = [
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

/** The zoom stops of a width expression, as `[zoom, value]` pairs. */
function stops(width: ExpressionSpecification): [number, unknown][] {
  const tail = (width as unknown[]).slice(3);
  const pairs: [number, unknown][] = [];
  for (let i = 0; i < tail.length; i += 2) {
    pairs.push([tail[i] as number, tail[i + 1]]);
  }
  return pairs;
}

describe('road primitives', () => {
  it('names the source Atlas geometry is loaded into', () => {
    expect(ROAD_SOURCE_ID).toBe('atlas-roads');
  });

  it('names the property a feature id is copied into', () => {
    // Hover, selection and the inspector all match on this one property, so
    // renaming it silently would break every one of them at once.
    expect(FEATURE_KEY).toBe('atlasId');
  });
});

describe('roadWidth', () => {
  it('keeps zoom as the top-level expression', () => {
    // MapLibre rejects a paint property whose `zoom` reference is nested, so
    // the interpolation has to wrap the class weighting and never the reverse.
    const width = roadWidth();
    expect((width as unknown[])[0]).toBe('interpolate');
    expect((width as unknown[])[1]).toEqual(['linear']);
    expect((width as unknown[])[2]).toEqual(['zoom']);
    for (const [, value] of stops(width)) {
      expect(JSON.stringify(value)).not.toContain('zoom');
    }
  });

  it('weights an unadorned road by class at four zoom stops', () => {
    expect(stops(roadWidth())).toEqual([
      [8, ['*', 0.6, CLASS_WEIGHT]],
      [12, ['*', 1.4, CLASS_WEIGHT]],
      [15, ['*', 3, CLASS_WEIGHT]],
      [18, ['*', 8, CLASS_WEIGHT]],
    ]);
  });

  it('adds extra width as a constant on top of the weighted base', () => {
    // The casing and the highlights sit proud of the road by a fixed amount at
    // every zoom, which is an addition and not a multiplication.
    expect(stops(roadWidth(2))).toEqual([
      [8, ['+', ['*', 0.6, CLASS_WEIGHT], 2]],
      [12, ['+', ['*', 1.4, CLASS_WEIGHT], 2]],
      [15, ['+', ['*', 3, CLASS_WEIGHT], 2]],
      [18, ['+', ['*', 8, CLASS_WEIGHT], 2]],
    ]);
  });

  it('scales the weighted base for an overlay drawn inside the road', () => {
    // A scaled width stays a fraction of the road at every zoom, so the class
    // colour is still visible on both sides of the overlay.
    expect(stops(roadWidth(0, 0.5))).toEqual([
      [8, ['*', 0.3, CLASS_WEIGHT]],
      [12, ['*', 0.7, CLASS_WEIGHT]],
      [15, ['*', 1.5, CLASS_WEIGHT]],
      [18, ['*', 4, CLASS_WEIGHT]],
    ]);
  });

  it('keeps extra width and scaling independent', () => {
    // Scaling touches the base only; extra is still added afterwards, and
    // neither one quietly becomes the other.
    expect(stops(roadWidth(1.5, 0.5))).toEqual([
      [8, ['+', ['*', 0.3, CLASS_WEIGHT], 1.5]],
      [12, ['+', ['*', 0.7, CLASS_WEIGHT], 1.5]],
      [15, ['+', ['*', 1.5, CLASS_WEIGHT], 1.5]],
      [18, ['+', ['*', 4, CLASS_WEIGHT], 1.5]],
    ]);
    expect(stops(roadWidth(0, 1))).toEqual(stops(roadWidth()));
  });
});
