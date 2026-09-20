/** Adapting Atlas GeoJSON for MapLibre. */

import type { FeatureCollection, LineString } from 'geojson';

import type { AtlasFeature, AtlasFeatureCollection } from '../api/types.js';
import { accessProperties } from './access.js';
import { FEATURE_KEY } from './roadLayers.js';
import { directionProperties } from './traversal.js';

/** An empty collection, used before the first query answers. */
export const EMPTY_COLLECTION: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * Adapts Atlas GeoJSON for MapLibre.
 *
 * Two things happen here and nowhere else:
 *
 * * Each Atlas feature id is copied into a property. MapLibre's
 *   `feature-state` needs numeric ids, and Atlas ids are opaque strings, so
 *   hover and selection are driven by a property filter instead.
 * * The nested `traversal` block is flattened to one string property per
 *   profile per fact — a direction and an access — because a MapLibre
 *   expression cannot read into a nested object.
 *
 * Both are client-side rendering concerns. The wire format keeps the id where
 * GeoJSON says it belongs and keeps the traversal block nested, and the
 * inspector reads the original feature rather than this adaptation.
 *
 * The coordinates are passed through by reference, untouched and in the order
 * the server sent them. A reverse one-way is expressed by rotating its arrow,
 * never by reversing its geometry.
 */
export function toMapCollection(collection: AtlasFeatureCollection): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const { traversal, ...rest } = feature.properties;
      return {
        type: 'Feature',
        id: feature.id,
        geometry: { type: 'LineString', coordinates: feature.geometry.coordinates },
        properties: {
          ...rest,
          [FEATURE_KEY]: feature.id,
          ...directionProperties(traversal),
          ...accessProperties(traversal),
        },
      };
    }),
  };
}

/** Indexes a collection by feature id, for the inspector. */
export function indexFeatures(
  collection: AtlasFeatureCollection,
): ReadonlyMap<string, AtlasFeature> {
  return new Map(collection.features.map((feature) => [feature.id, feature]));
}
