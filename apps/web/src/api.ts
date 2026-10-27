import type {
  ErrorBody,
  GeocodeResponse,
  PoiResponse,
  ProximityRequest,
  ProximityResponse,
  Readiness,
  RouteRequest,
  RouteResponse,
} from '@seyra/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

/** Network-level failure (server unreachable), distinct from a typed API error. */
export class ConnectionError extends Error {}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 130_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  } catch (err) {
    throw new ConnectionError(err instanceof Error ? err.message : 'connection failed');
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'MALFORMED_RESPONSE', `HTTP ${res.status}`, null, undefined);
  }
  if (!res.ok) {
    const e = (body as ErrorBody | null)?.error;
    if (e) throw new ApiError(res.status, e.code, e.message, e.request_id, e.details);
    if (path.startsWith('/health/')) return body as T;
    throw new ApiError(res.status, 'HTTP_ERROR', `HTTP ${res.status}`, null, undefined);
  }
  return body as T;
}

export interface Capabilities {
  dataset_id: string;
  map: { styles: Record<string, string>; native_zoom: { min: number; max: number }; client_max_zoom: number; tilejson: string };
  routing: { profiles: string[]; objectives: string[]; order_modes: string[]; support: unknown[]; unsupported: string[] };
  proximity: { metrics: string[]; directions: string[]; max_candidates: number };
  pois: { presets: { id: string; label: { fa: string; en: string } }[]; selector_allowlist: Record<string, string[]>; max_bbox_km2: number; max_results: number };
  limits: Record<string, number>;
  [k: string]: unknown;
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export const api = {
  capabilities: () => call<Capabilities>('/api/v1/map/capabilities'),
  ready: () => call<Readiness>('/health/ready', undefined, 10_000),
  search: (p: { q: string; lang: string; limit?: number; bias_lon?: number; bias_lat?: number; dataset_id: string }, auto = false) =>
    call<GeocodeResponse>(`/api/v1/map/${auto ? 'autocomplete' : 'search'}?${q(p)}`),
  reverse: (p: { lon: number; lat: number; lang: string; limit?: number; dataset_id: string }) => call<GeocodeResponse>(`/api/v1/map/reverse?${q(p)}`),
  route: (body: RouteRequest) => call<RouteResponse>('/api/v1/map/route', { method: 'POST', body: JSON.stringify(body) }),
  proximity: (body: ProximityRequest) => call<ProximityResponse>('/api/v1/map/proximity', { method: 'POST', body: JSON.stringify(body) }),
  pois: (p: { bbox: string; preset?: string; key?: string; value?: string; limit?: number; lang: string; dataset_id: string }) => call<PoiResponse>(`/api/v1/map/pois?${q(p)}`),
};
