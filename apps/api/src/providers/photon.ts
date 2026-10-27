import { MapServiceError, type GeocodeResult, type Language } from '@seyra/contracts';
import type { BoundedLimiter } from '../concurrency.js';
import { parseJson, providerFetch } from './http.js';

/** Category carried only by the per-release marker document; excluded from every user query. */
export const MARKER_CATEGORY = 'seyra.release_marker';

/** Keys written into each document's `extra` by the index build to preserve original names. */
export const EXTRA_NAME_KEYS = { default: 'seyra_name', fa: 'seyra_name_fa', en: 'seyra_name_en' } as const;
/** Original (display) house number; the indexed value is search-normalized. */
export const EXTRA_HOUSENUMBER_KEY = 'seyra_housenumber';

interface PhotonFeature {
  geometry?: { type: string; coordinates: [number, number] };
  properties?: Record<string, unknown> & { extra?: Record<string, string> };
}
interface PhotonCollection {
  features?: PhotonFeature[];
}

const ADDRESS_KEYS = ['housenumber', 'street', 'locality', 'district', 'city', 'county', 'state', 'postcode', 'country'] as const;
const OSM_TYPES = { N: 'node', W: 'way', R: 'relation' } as const;

export class PhotonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly limiter: BoundedLimiter,
  ) {}

  async search(params: { q: string; lang: Language; limit: number; bias?: { lon: number; lat: number }; bbox?: [number, number, number, number] }, signal: AbortSignal): Promise<GeocodeResult[]> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set('q', params.q);
    url.searchParams.set('lang', params.lang);
    url.searchParams.set('limit', String(params.limit));
    url.searchParams.set('exclude', MARKER_CATEGORY);
    if (params.bias) {
      url.searchParams.set('lon', String(params.bias.lon));
      url.searchParams.set('lat', String(params.bias.lat));
    }
    if (params.bbox) url.searchParams.set('bbox', params.bbox.join(','));
    return this.query(url, params.lang, signal);
  }

  async reverse(params: { lon: number; lat: number; lang: Language; limit: number; radiusM?: number }, signal: AbortSignal): Promise<GeocodeResult[]> {
    const url = new URL(`${this.baseUrl}/reverse`);
    url.searchParams.set('lon', String(params.lon));
    url.searchParams.set('lat', String(params.lat));
    url.searchParams.set('lang', params.lang);
    url.searchParams.set('limit', String(params.limit));
    url.searchParams.set('exclude', MARKER_CATEGORY);
    if (params.radiusM !== undefined) url.searchParams.set('radius', String(params.radiusM / 1000));
    return this.query(url, params.lang, signal);
  }

  /** Real probe: service status plus lookup of the release marker document in the served index. */
  async identity(markerName: string, signal: AbortSignal): Promise<{ identity: string | null; version: string | null }> {
    const status = await providerFetch('photon', new URL(`${this.baseUrl}/status`), { signal, maxBytes: 64 * 1024 });
    if (status.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `photon status returned HTTP ${status.status}`, { provider: 'photon' });
    const body = parseJson<{ status?: string; version?: string }>('photon', status.body);
    if (body.status !== 'Ok') throw new MapServiceError('PROVIDER_UNAVAILABLE', 'photon reports a non-Ok status', { provider: 'photon' });
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set('q', markerName);
    url.searchParams.set('include', MARKER_CATEGORY);
    url.searchParams.set('limit', '1');
    const res = await providerFetch('photon', url, { signal, maxBytes: 64 * 1024 });
    if (res.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `photon marker probe returned HTTP ${res.status}`, { provider: 'photon' });
    const found = parseJson<PhotonCollection>('photon', res.body).features?.[0]?.properties?.name;
    return { identity: typeof found === 'string' ? found : null, version: body.version ?? null };
  }

  private async query(url: URL, lang: Language, signal: AbortSignal): Promise<GeocodeResult[]> {
    const res = await this.limiter.run(() => providerFetch('photon', url, { signal, maxBytes: 4 * 1024 * 1024 }), signal);
    if (res.status === 400) {
      throw new MapServiceError('INVALID_REQUEST', 'geocoder rejected the query', { provider: 'photon' });
    }
    if (res.status !== 200) {
      throw new MapServiceError(res.status >= 500 ? 'PROVIDER_ERROR' : 'PROVIDER_UNAVAILABLE', `photon returned HTTP ${res.status}`, { provider: 'photon' });
    }
    const collection = parseJson<PhotonCollection>('photon', res.body);
    return (collection.features ?? []).flatMap((f) => {
      const converted = convertFeature(f, lang);
      return converted ? [converted] : [];
    });
  }
}

export function displayName(names: { default?: string; fa?: string; en?: string }, lang: Language): string | null {
  const order = lang === 'fa' ? [names.fa, names.default, names.en] : [names.en, names.default, names.fa];
  return order.find((n): n is string => typeof n === 'string' && n.length > 0) ?? null;
}

function convertFeature(f: PhotonFeature, lang: Language): GeocodeResult | null {
  const p = f.properties;
  const coords = f.geometry?.coordinates;
  if (!p || !coords) return null;
  const osmType = OSM_TYPES[p.osm_type as keyof typeof OSM_TYPES];
  const osmId = p.osm_id;
  if (!osmType || typeof osmId !== 'number') return null;
  const extra = p.extra ?? {};
  const names: { default?: string; fa?: string; en?: string } = {};
  const dflt = extra[EXTRA_NAME_KEYS.default] ?? (typeof p.name === 'string' ? p.name : undefined);
  if (dflt) names.default = dflt;
  if (extra[EXTRA_NAME_KEYS.fa]) names.fa = extra[EXTRA_NAME_KEYS.fa];
  if (extra[EXTRA_NAME_KEYS.en]) names.en = extra[EXTRA_NAME_KEYS.en];
  const address: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const v = key === 'housenumber' ? (extra[EXTRA_HOUSENUMBER_KEY] ?? p[key]) : p[key];
    if (typeof v === 'string' && v.length > 0) address[key] = v;
  }
  const result: GeocodeResult = {
    id: `osm:${osmType[0]}${osmId}`,
    osm_type: osmType,
    osm_id: osmId,
    name: displayName(names, lang),
    names,
    category: { key: String(p.osm_key ?? ''), value: String(p.osm_value ?? '') },
    address,
    coordinate: { lon: coords[0], lat: coords[1] },
  };
  const ext = p.extent;
  if (Array.isArray(ext) && ext.length === 4 && ext.every((n) => typeof n === 'number')) {
    // GeocodeJSON extent is [west, north, east, south]; expose [minLon, minLat, maxLon, maxLat].
    const [w, n, e, s] = ext as [number, number, number, number];
    result.extent = [Math.min(w, e), Math.min(n, s), Math.max(w, e), Math.max(n, s)];
  }
  return result;
}
