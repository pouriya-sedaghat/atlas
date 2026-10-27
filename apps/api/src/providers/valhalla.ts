import { MapServiceError, VALHALLA_COSTING, type LonLat, type Objective, type Profile } from '@seyra/contracts';
import type { BoundedLimiter } from '../concurrency.js';
import { parseJson, providerFetch } from './http.js';

export interface ValhallaTrip {
  distance_m: number;
  duration_s: number;
  legs: { distance_m: number; duration_s: number }[];
  coordinates: [number, number][];
}

export interface ValhallaRouteResult {
  primary: ValhallaTrip;
  alternates: ValhallaTrip[];
}

/** Outcome of a single two-point cost probe: a finite route or a genuine no-path condition. */
export type PairOutcome =
  | { kind: 'route'; distance_m: number; duration_s: number }
  | { kind: 'no_route'; code: 'NO_ROUTE' | 'POINT_NOT_ROUTABLE' };

interface RawLeg {
  summary: { length: number; time: number };
  shape: string;
}
interface RawTrip {
  legs: RawLeg[];
  summary: { length: number; time: number };
  status?: number;
  units?: string;
}
interface RawRouteResponse {
  trip?: RawTrip;
  alternates?: { trip: RawTrip }[];
  error_code?: number;
  error?: string;
}

const NO_ROUTE_CODES = new Set([170, 442]);
const NOT_ROUTABLE_CODES = new Set([171]);
const PROVIDER_LIMIT_CODES = new Set([150, 154, 166]);

export class ValhallaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly limiter: BoundedLimiter,
  ) {}

  /**
   * Ordered route through all points (each a stopping/break location). Valhalla's `shortest`
   * costing option is the distance-oriented preference; it is not a global-optimality guarantee.
   */
  async route(points: LonLat[], profile: Profile, objective: Objective, alternates: number, signal: AbortSignal): Promise<ValhallaRouteResult> {
    const costing = VALHALLA_COSTING[profile];
    const request: Record<string, unknown> = {
      locations: points.map((p) => ({ lon: p.lon, lat: p.lat, type: 'break' })),
      costing,
      costing_options: { [costing]: objective === 'distance' ? { shortest: true } : {} },
      units: 'kilometers',
      directions_type: 'none',
    };
    if (alternates > 0) request.alternates = alternates;
    const res = await this.limiter.run(
      () =>
        providerFetch('valhalla', new URL(`${this.baseUrl}/route`), {
          method: 'POST',
          body: JSON.stringify(request),
          contentType: 'application/json',
          signal,
        }),
      signal,
    );
    const parsed = parseJson<RawRouteResponse>('valhalla', res.body);
    if (res.status !== 200 || !parsed.trip) throw mapValhallaError(res.status, parsed);
    return {
      primary: convertTrip(parsed.trip),
      alternates: (parsed.alternates ?? []).map((a) => convertTrip(a.trip)),
    };
  }

  /** Two-point probe that distinguishes genuine no-path conditions from provider failures. */
  async pair(from: LonLat, to: LonLat, profile: Profile, objective: Objective, signal: AbortSignal): Promise<PairOutcome> {
    try {
      const result = await this.route([from, to], profile, objective, 0, signal);
      return { kind: 'route', distance_m: result.primary.distance_m, duration_s: result.primary.duration_s };
    } catch (err) {
      if (err instanceof MapServiceError && (err.code === 'NO_ROUTE' || err.code === 'POINT_NOT_ROUTABLE')) {
        return { kind: 'no_route', code: err.code };
      }
      throw err;
    }
  }

  async status(signal: AbortSignal): Promise<{ identity: string; version: string | null }> {
    const res = await providerFetch('valhalla', new URL(`${this.baseUrl}/status`), { signal, maxBytes: 1024 * 1024 });
    if (res.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `valhalla status returned HTTP ${res.status}`, { provider: 'valhalla' });
    const body = parseJson<{ version?: string; tileset_last_modified?: number }>('valhalla', res.body);
    if (typeof body.tileset_last_modified !== 'number') {
      throw new MapServiceError('PROVIDER_UNAVAILABLE', 'valhalla status has no tileset identity (no graph loaded)', { provider: 'valhalla' });
    }
    return { identity: String(body.tileset_last_modified), version: body.version ?? null };
  }
}

export function mapValhallaError(status: number, body: RawRouteResponse): MapServiceError {
  const code = body.error_code;
  const details = code === undefined ? undefined : { provider_error_code: code };
  if (code !== undefined && NO_ROUTE_CODES.has(code)) {
    return new MapServiceError('NO_ROUTE', 'no route exists between the requested points for this profile', { provider: 'valhalla', ...(details ? { details } : {}) });
  }
  if (code !== undefined && NOT_ROUTABLE_CODES.has(code)) {
    return new MapServiceError('POINT_NOT_ROUTABLE', 'a point has no suitable road/path near it for this profile', { provider: 'valhalla', ...(details ? { details } : {}) });
  }
  if (code !== undefined && PROVIDER_LIMIT_CODES.has(code)) {
    return new MapServiceError('LIMIT_EXCEEDED', 'request exceeds a configured routing-engine limit (distance or locations)', { provider: 'valhalla', ...(details ? { details } : {}) });
  }
  if (status >= 500 || status === 0) {
    return new MapServiceError('PROVIDER_ERROR', `valhalla failed with HTTP ${status}`, { provider: 'valhalla', ...(details ? { details } : {}) });
  }
  return new MapServiceError('PROVIDER_ERROR', `valhalla rejected the generated request (HTTP ${status})`, { provider: 'valhalla', ...(details ? { details } : {}) });
}

function convertTrip(trip: RawTrip): ValhallaTrip {
  if (trip.units !== undefined && trip.units !== 'kilometers') {
    throw new MapServiceError('PROVIDER_ERROR', `unexpected valhalla units ${trip.units}`, { provider: 'valhalla' });
  }
  const coordinates: [number, number][] = [];
  for (const leg of trip.legs) {
    const decoded = decodePolyline6(leg.shape);
    // Consecutive legs share their joining point.
    const start = coordinates.length > 0 ? 1 : 0;
    for (let i = start; i < decoded.length; i++) coordinates.push(decoded[i]!);
  }
  return {
    distance_m: kmToM(trip.summary.length),
    duration_s: roundTo(trip.summary.time, 3),
    legs: trip.legs.map((l) => ({ distance_m: kmToM(l.summary.length), duration_s: roundTo(l.summary.time, 3) })),
    coordinates,
  };
}

const kmToM = (km: number): number => Math.round(km * 1000);
const roundTo = (n: number, digits: number): number => Number(n.toFixed(digits));

/** Decode a Google-style polyline with 6-digit precision into [lon, lat] pairs. */
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) throw new MapServiceError('PROVIDER_ERROR', 'truncated route geometry', { provider: 'valhalla' });
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}
