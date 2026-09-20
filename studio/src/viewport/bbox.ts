/** Viewport bounding-box helpers, kept pure so they can be unit tested. */

import type { Bbox } from '../api/types.js';

const MIN_LONGITUDE = -180;
const MAX_LONGITUDE = 180;
const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Turns raw map bounds into a bounding box the Atlas API will accept.
 *
 * A web map happily reports a viewport that wraps past the antimeridian or
 * spans more than the whole globe. Atlas rejects both, so Studio widens such a
 * viewport to the full longitude range rather than sending something the server
 * has to refuse.
 */
export function normalizeViewportBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): Bbox {
  if (![west, south, east, north].every((value) => Number.isFinite(value))) {
    return [MIN_LONGITUDE, MIN_LATITUDE, MAX_LONGITUDE, MAX_LATITUDE];
  }

  const spansTheGlobe = east - west >= MAX_LONGITUDE - MIN_LONGITUDE;
  const clampedWest = clamp(west, MIN_LONGITUDE, MAX_LONGITUDE);
  const clampedEast = clamp(east, MIN_LONGITUDE, MAX_LONGITUDE);
  const wrapsAntimeridian = clampedWest > clampedEast;

  const longitudes: [number, number] =
    spansTheGlobe || wrapsAntimeridian
      ? [MIN_LONGITUDE, MAX_LONGITUDE]
      : [clampedWest, clampedEast];

  const clampedSouth = clamp(Math.min(south, north), MIN_LATITUDE, MAX_LATITUDE);
  const clampedNorth = clamp(Math.max(south, north), MIN_LATITUDE, MAX_LATITUDE);

  return [longitudes[0], clampedSouth, longitudes[1], clampedNorth];
}

/** Whether two boxes are the same to within a tenth of a metre. */
export function bboxesEqual(left: Bbox, right: Bbox, epsilon = 1e-6): boolean {
  return left.every((value, index) => Math.abs(value - right[index]!) <= epsilon);
}

/** Renders a box for a diagnostics panel. */
export function formatBbox(bbox: Bbox, precision = 5): string {
  return bbox.map((value) => value.toFixed(precision)).join(', ');
}

/** The smallest box covering every coordinate of a line. */
export function boundsOfCoordinates(coordinates: readonly [number, number][]): Bbox | null {
  const first = coordinates[0];
  if (!first) {
    return null;
  }
  let [west, south] = first;
  let [east, north] = first;
  for (const [longitude, latitude] of coordinates) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}
