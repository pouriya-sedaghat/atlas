/** Adapting Atlas GeoJSON for MapLibre. */

import type { FeatureCollection, LineString } from 'geojson';

import type { AtlasFeature, AtlasFeatureCollection } from '../api/types.js';
import { FEATURE_KEY } from './roadLayers.js';

/** An empty collection, used before the first query answers. */
export const EMPTY_COLLECTION: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * Copies each Atlas feature id into a property.
 *
 * MapLibre's `feature-state` needs numeric ids, and Atlas ids are opaque
 * strings, so hover and selection are driven by a property filter instead.
 * The duplication stays on the client: the wire format keeps the id where
 * GeoJSON says it belongs.
 */
export function toMapCollection(collection: AtlasFeatureCollection): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => ({
      type: 'Feature',
      id: feature.id,
      geometry: { type: 'LineString', coordinates: feature.geometry.coordinates },
      properties: { ...feature.properties, [FEATURE_KEY]: feature.id },
    })),
  };
}

/** Indexes a collection by feature id, for the inspector. */
export function indexFeatures(
  collection: AtlasFeatureCollection,
): ReadonlyMap<string, AtlasFeature> {
  return new Map(collection.features.map((feature) => [feature.id, feature]));
}
