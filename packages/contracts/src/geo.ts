/** Small WGS84 helpers shared by the API and the web client. */

export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

/** Parse "minLon,minLat,maxLon,maxLat"; returns null when malformed or inverted. */
export function parseBbox(value: string): Bbox | null {
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts as Bbox;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return null;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/** Area of a lon/lat rectangle on a sphere, in km² (exact for the spherical model). */
export function bboxAreaKm2([minLon, minLat, maxLon, maxLat]: Bbox): number {
  const rad = Math.PI / 180;
  const area = EARTH_RADIUS_M ** 2 * Math.abs(Math.sin(maxLat * rad) - Math.sin(minLat * rad)) * Math.abs(maxLon - minLon) * rad;
  return area / 1e6;
}

/** Great-circle distance in metres (spherical; the API uses PostGIS geography for ranking). */
export function haversineM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
