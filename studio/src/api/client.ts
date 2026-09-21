/** Typed access to the Atlas HTTP API. */

import type {
  ApiErrorEnvelope,
  AtlasFeatureCollection,
  Bbox,
  CurrentDataset,
  HealthPayload,
  TopologyCollection,
} from './types.js';

/** What Studio asks the feature endpoint for. */
export interface FeatureQueryRequest {
  bbox: Bbox;
  kind?: string;
  limit?: number;
  include?: readonly ('source' | 'diagnostics')[];
  dataset?: string;
}

/**
 * What Studio asks the topology endpoint for.
 *
 * Deliberately not a `FeatureQueryRequest` with an extra flag. The topology
 * endpoint takes no `kind` and offers no `source` include, and a shared
 * request type would let Studio send parameters the server will reject.
 */
export interface TopologyQueryRequest {
  bbox: Bbox;
  limit?: number;
  include?: readonly 'diagnostics'[];
  dataset?: string;
}

/** An error the Atlas API reported in its structured envelope. */
export class AtlasApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;

  constructor(status: number, code: string, message: string, requestId: string) {
    super(message);
    this.name = 'AtlasApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Builds the feature query URL.
 *
 * Kept separate from `fetch` so that the query-building rules can be tested
 * without a server or a browser.
 */
export function buildFeaturesUrl(
  request: FeatureQueryRequest,
  base = '/api/v1/map/features',
): string {
  const params = new URLSearchParams();
  params.set('bbox', request.bbox.map((value) => formatDegrees(value)).join(','));
  if (request.kind !== undefined) {
    params.set('kind', request.kind);
  }
  if (request.limit !== undefined) {
    params.set('limit', String(request.limit));
  }
  if (request.include !== undefined && request.include.length > 0) {
    params.set('include', request.include.join(','));
  }
  if (request.dataset !== undefined) {
    params.set('dataset', request.dataset);
  }
  return `${base}?${params.toString()}`;
}

/**
 * Builds the topology query URL.
 *
 * Kept separate from `fetch` for the same reason `buildFeaturesUrl` is: the
 * query-building rules are testable without a server or a browser.
 */
export function buildTopologyUrl(
  request: TopologyQueryRequest,
  base = '/api/v1/map/topology',
): string {
  const params = new URLSearchParams();
  params.set('bbox', request.bbox.map((value) => formatDegrees(value)).join(','));
  if (request.limit !== undefined) {
    params.set('limit', String(request.limit));
  }
  if (request.include !== undefined && request.include.length > 0) {
    params.set('include', request.include.join(','));
  }
  if (request.dataset !== undefined) {
    params.set('dataset', request.dataset);
  }
  return `${base}?${params.toString()}`;
}

/** Six decimals is roughly 0.1 m, far finer than any viewport needs. */
function formatDegrees(value: number): string {
  return Number(value.toFixed(6)).toString();
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }

  let code = 'HTTP_ERROR';
  let message = `${response.status} ${response.statusText}`;
  let requestId = '';
  try {
    const body = (await response.json()) as Partial<ApiErrorEnvelope>;
    if (body.error) {
      code = body.error.code;
      message = body.error.message;
      requestId = body.error.requestId;
    }
  } catch {
    // A non-JSON error body is still an error; the status line has to do.
  }
  throw new AtlasApiError(response.status, code, message, requestId);
}

export async function fetchLiveness(signal?: AbortSignal): Promise<HealthPayload> {
  const init: RequestInit = signal ? { signal } : {};
  return readJson<HealthPayload>(await fetch('/health/live', init));
}

export async function fetchCurrentDataset(signal?: AbortSignal): Promise<CurrentDataset> {
  const init: RequestInit = signal ? { signal } : {};
  return readJson<CurrentDataset>(await fetch('/api/v1/datasets/current', init));
}

export async function fetchFeatures(
  request: FeatureQueryRequest,
  signal: AbortSignal,
): Promise<AtlasFeatureCollection> {
  return readJson<AtlasFeatureCollection>(await fetch(buildFeaturesUrl(request), { signal }));
}

export async function fetchTopology(
  request: TopologyQueryRequest,
  signal: AbortSignal,
): Promise<TopologyCollection> {
  return readJson<TopologyCollection>(await fetch(buildTopologyUrl(request), { signal }));
}
