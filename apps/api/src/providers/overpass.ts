import { MapServiceError, isAllowlisted, type Bbox } from '@seyra/contracts';
import type { BoundedLimiter } from '../concurrency.js';
import { parseJson, providerFetch } from './http.js';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements?: OverpassElement[];
  remark?: string;
}

const SAFE_TOKEN = /^[a-z0-9_]+$/;

/**
 * Build bounded Overpass QL from allowlisted key/value pairs and a validated bbox. Nothing from
 * the client is interpolated except values that passed the finite allowlist and numeric checks.
 */
export function buildPoiQuery(
  filters: readonly { key: string; value: string }[],
  bbox: Bbox,
  limit: number,
  timeoutS: number,
  maxSizeBytes: number,
): string {
  if (filters.length === 0) throw new MapServiceError('INVALID_REQUEST', 'no POI filter');
  for (const f of filters) {
    if (!SAFE_TOKEN.test(f.key) || !SAFE_TOKEN.test(f.value) || !isAllowlisted(f.key, f.value)) {
      throw new MapServiceError('UNKNOWN_PRESET', 'POI selector is not in the catalog allowlist');
    }
  }
  const [minLon, minLat, maxLon, maxLat] = bbox;
  for (const n of bbox) if (!Number.isFinite(n)) throw new MapServiceError('INVALID_REQUEST', 'invalid bbox');
  const fmt = (n: number) => n.toFixed(7);
  const lines = filters.map((f) => `  nwr["${f.key}"="${f.value}"];`).join('\n');
  // Fetch one extra element so truncation can be reported explicitly.
  return [
    `[out:json][timeout:${Math.trunc(timeoutS)}][maxsize:${Math.trunc(maxSizeBytes)}][bbox:${fmt(minLat)},${fmt(minLon)},${fmt(maxLat)},${fmt(maxLon)}];`,
    '(',
    lines,
    ');',
    `out tags center ${Math.trunc(limit) + 1};`,
  ].join('\n');
}

export class OverpassClient {
  constructor(
    private readonly baseUrl: string,
    private readonly limiter: BoundedLimiter,
  ) {}

  async run(query: string, signal: AbortSignal): Promise<OverpassElement[]> {
    const res = await this.limiter.run(
      () =>
        providerFetch('overpass', new URL(`${this.baseUrl}/api/interpreter`), {
          method: 'POST',
          body: new URLSearchParams({ data: query }).toString(),
          contentType: 'application/x-www-form-urlencoded',
          signal,
          maxBytes: 16 * 1024 * 1024,
        }),
      signal,
    );
    if (res.status === 429) throw new MapServiceError('OVERLOADED', 'overpass rate limit reached; retry later', { provider: 'overpass' });
    if (res.status === 504) throw new MapServiceError('PROVIDER_TIMEOUT', 'overpass has no free query capacity or timed out', { provider: 'overpass' });
    if (res.status !== 200) throw new MapServiceError('PROVIDER_ERROR', `overpass returned HTTP ${res.status}`, { provider: 'overpass' });
    const rejected = dispatcherRejection(res.body);
    if (rejected) throw rejected;
    const body = parseJson<OverpassResponse>('overpass', res.body);
    if (body.remark && /runtime (error|remark)/i.test(body.remark)) {
      if (/timed out|timeout/i.test(body.remark)) throw new MapServiceError('PROVIDER_TIMEOUT', 'overpass query exceeded its time limit', { provider: 'overpass' });
      if (/out of memory|maxsize|memory/i.test(body.remark)) throw new MapServiceError('LIMIT_EXCEEDED', 'overpass query exceeded its memory limit', { provider: 'overpass' });
      throw new MapServiceError('PROVIDER_ERROR', 'overpass reported a runtime error', { provider: 'overpass' });
    }
    return body.elements ?? [];
  }

  /** Real probe through the interpreter; identity is the base-database version label. */
  async identity(signal: AbortSignal): Promise<{ identity: string | null }> {
    const probe = '[out:json][timeout:5][bbox:0,0,0.0000001,0.0000001];node;out ids 1;';
    const res = await providerFetch('overpass', new URL(`${this.baseUrl}/api/interpreter`), {
      method: 'POST',
      body: new URLSearchParams({ data: probe }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      signal,
      maxBytes: 64 * 1024,
    });
    if (res.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `overpass probe returned HTTP ${res.status}`, { provider: 'overpass' });
    const rejected = dispatcherRejection(res.body);
    if (rejected) throw new MapServiceError('PROVIDER_UNAVAILABLE', `overpass probe rejected: ${rejected.message}`, { provider: 'overpass' });
    const body = parseJson<OverpassResponse>('overpass', res.body);
    return { identity: body.osm3s?.timestamp_osm_base ?? null };
  }
}

/**
 * The dispatcher rejects queries before output formatting, so the interpreter answers with an
 * HTML error page (HTTP 200) even for [out:json]. Classify it without echoing provider text.
 */
export function dispatcherRejection(body: string): MapServiceError | null {
  const text = body.slice(0, 8192);
  if (/^\s*[{[]/.test(text)) return null;
  const m = /Dispatcher_Client::request_read_and_idx::([a-z_]+)/.exec(text);
  if (m) {
    const reason = m[1]!;
    if (reason === 'rate_limited' || reason === 'timeout' || reason === 'duplicate_query') {
      return new MapServiceError('OVERLOADED', `overpass has no free query capacity (${reason}); retry later`, { provider: 'overpass' });
    }
    return new MapServiceError('PROVIDER_ERROR', `overpass dispatcher error (${reason})`, { provider: 'overpass' });
  }
  if (/runtime error/i.test(text)) return new MapServiceError('PROVIDER_ERROR', 'overpass reported a runtime error', { provider: 'overpass' });
  return null;
}
