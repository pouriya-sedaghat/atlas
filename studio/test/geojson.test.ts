import { describe, expect, it } from 'vitest';

import type { AtlasFeature, AtlasFeatureCollection } from '../src/api/types.js';
import { EMPTY_COLLECTION, indexFeatures, toMapCollection } from '../src/map/geojson.js';
import { FEATURE_KEY } from '../src/map/roadLayers.js';

function feature(overrides: Partial<AtlasFeature> = {}): AtlasFeature {
  return {
    type: 'Feature',
    id: 'osm:way:303',
    geometry: {
      type: 'LineString',
      coordinates: [
        [51.39, 35.697],
        [51.3915, 35.697],
        [51.393, 35.697],
      ],
    },
    properties: {
      kind: 'road',
      roadClass: 'residential',
      name: 'Reverse One-Way',
      traversal: {
        motorcar: { direction: 'reverse', access: 'private' },
        bicycle: { direction: 'reverse', access: 'permissive' },
        foot: { direction: 'both', access: 'allowed' },
      },
    },
    ...overrides,
  };
}

function collection(features: AtlasFeature[]): AtlasFeatureCollection {
  return {
    type: 'FeatureCollection',
    bbox: [51.389, 35.69, 51.397, 35.699],
    features,
    atlas: {
      apiVersion: '1',
      datasetId: 'ds-directionality',
      returned: features.length,
      limit: 2000,
      truncated: false,
    },
  };
}

describe('toMapCollection', () => {
  it('flattens the traversal block onto one property per profile', () => {
    const [mapped] = toMapCollection(collection([feature()])).features;
    expect(mapped?.properties).toMatchObject({
      'direction:motorcar': 'reverse',
      'direction:bicycle': 'reverse',
      'direction:foot': 'both',
    });
  });

  it('keeps the nested block out of the MapLibre properties', () => {
    // MapLibre expressions cannot read a nested object, and leaving one in the
    // properties would just invite someone to try.
    const [mapped] = toMapCollection(collection([feature()])).features;
    expect(mapped?.properties).not.toHaveProperty('traversal');
    expect(mapped?.properties).toMatchObject({ kind: 'road', roadClass: 'residential' });
    expect(mapped?.properties?.[FEATURE_KEY]).toBe('osm:way:303');
  });

  it('flattens the access block onto one property per profile', () => {
    const [mapped] = toMapCollection(collection([feature()])).features;
    expect(mapped?.properties).toMatchObject({
      'access:motorcar': 'private',
      'access:bicycle': 'permissive',
      'access:foot': 'allowed',
    });
  });

  it('marks a road with no traversal as indeterminate rather than guessing', () => {
    const bare = feature({ properties: { kind: 'road', roadClass: 'service' } });
    const [mapped] = toMapCollection(collection([bare])).features;
    expect(mapped?.properties).toMatchObject({
      'direction:motorcar': 'indeterminate',
      'direction:bicycle': 'indeterminate',
      'direction:foot': 'indeterminate',
      'access:motorcar': 'indeterminate',
      'access:bicycle': 'indeterminate',
      'access:foot': 'indeterminate',
    });
    // Never `unspecified`: an absent member is the client not being told, not
    // the source being silent.
    expect(mapped?.properties?.['access:motorcar']).not.toBe('unspecified');
  });

  it('flattens a Milestone 2A block that has directions but no access', () => {
    const older = feature({
      properties: {
        kind: 'road',
        roadClass: 'residential',
        traversal: {
          motorcar: { direction: 'forward' },
          bicycle: { direction: 'forward' },
          foot: { direction: 'both' },
        },
      },
    });
    const [mapped] = toMapCollection(collection([older])).features;
    expect(mapped?.properties).toMatchObject({
      'direction:motorcar': 'forward',
      'direction:foot': 'both',
      'access:motorcar': 'indeterminate',
      'access:foot': 'indeterminate',
    });
  });

  it('keeps direction and access as independent properties', () => {
    // A prohibited reverse one-way carries both facts; neither overwrites or
    // qualifies the other.
    const [mapped] = toMapCollection(
      collection([
        feature({
          properties: {
            kind: 'road',
            roadClass: 'residential',
            traversal: {
              motorcar: { direction: 'forward', access: 'prohibited' },
              bicycle: { direction: 'forward', access: 'designated' },
              foot: { direction: 'both', access: 'unspecified' },
            },
          },
        }),
      ]),
    ).features;
    expect(mapped?.properties).toMatchObject({
      'direction:motorcar': 'forward',
      'access:motorcar': 'prohibited',
      'direction:bicycle': 'forward',
      'access:bicycle': 'designated',
    });
  });

  it('never reverses or otherwise alters the geometry', () => {
    // A reverse one-way is a rotated arrow, never a reversed line.
    const source = feature();
    const [mapped] = toMapCollection(collection([source])).features;
    expect(mapped?.geometry.coordinates).toEqual([
      [51.39, 35.697],
      [51.3915, 35.697],
      [51.393, 35.697],
    ]);
    expect(source.geometry.coordinates).toEqual(mapped?.geometry.coordinates);
  });

  it('leaves an empty collection empty', () => {
    expect(toMapCollection(collection([])).features).toEqual([]);
    expect(EMPTY_COLLECTION.features).toEqual([]);
  });
});

describe('indexFeatures', () => {
  it('keeps the full wire feature, traversal block and all', () => {
    const index = indexFeatures(collection([feature()]));
    expect(index.get('osm:way:303')?.properties.traversal).toEqual({
      motorcar: { direction: 'reverse', access: 'private' },
      bicycle: { direction: 'reverse', access: 'permissive' },
      foot: { direction: 'both', access: 'allowed' },
    });
  });
});
