import type { FastifySchema } from 'fastify';
import { API_PREFIX, CONTRACTS_VERSION, DEFAULT_LIMITS, ErrorBodySchema, LIMITS_VERSION, POI_PRESETS } from '@seyra/contracts';

/**
 * OpenAPI documentation for the public Map Services operations. Applied by @fastify/swagger's
 * `transform` (documentation only): route validation schemas are never modified, and the same
 * buildApp() produces both the runtime document (/api/docs/json) and the exported file
 * (docs/openapi/map-services-v1.json). Every public route must have an entry here; an undocumented
 * route makes document generation fail.
 */

export const DOCS_PREFIX = '/api/docs';

const L = DEFAULT_LIMITS;

/** Illustrative inputs. "fixture" values are recorded requests of the synthetic test release
 * (docs/mobile-fixtures); "Iran" values name public landmarks and were not executed for this
 * document. Neither is a promise that a given dataset returns a particular result. */
const FIXTURE = 'Synthetic fixture release (fictional objects near 0°E 0°N), recorded in docs/mobile-fixtures';
const IRAN = 'Iran snapshot: illustrative public landmark coordinates, not executed for this document';

interface BodyExample {
  summary: string;
  description?: string;
  value: Record<string, unknown>;
}

interface OperationDoc {
  operationId: string;
  summary: string;
  description: string;
  ok: string;
  /** HTTP status -> description of the typed errors that status can carry on this operation. */
  errors: Record<number, string>;
  query?: Record<string, { description?: string; examples?: unknown[] }>;
  bodyExamples?: Record<string, BodyExample>;
}

const E = {
  invalid: '`INVALID_REQUEST`: the request does not match the schema or a documented rule (`details` names the field).',
  dataset: '`DATASET_MISMATCH`: `dataset_id` was sent and is not the active release. Reload `/capabilities` and the map style, then retry.',
  provider502: '`PROVIDER_ERROR`: the provider answered with an unexpected error.',
  unavailable:
    '`PROVIDER_UNAVAILABLE`, `PROVIDER_REVISION_MISMATCH` (provider not serving the active release), `MAINTENANCE` or `OVERLOADED` (admission queue full). `MAINTENANCE`/`OVERLOADED` carry `Retry-After: 5`. Retry with bounded backoff; check `/health/ready`.',
  timeout: (ms: number) => `\`PROVIDER_TIMEOUT\` or \`DEADLINE_EXCEEDED\` (operation deadline ${ms / 1000} s). Do not retry immediately in a loop.`,
  tooLargeProvider: '`PAYLOAD_TOO_LARGE` with `error.provider`: a provider response exceeded its size bound.',
  tooLargeBody:
    '`PAYLOAD_TOO_LARGE`: the request body exceeds 64 KiB (returned by the ingress before the API, in the same envelope; its `request_id` is the ingress request id), or a provider response exceeded its size bound (`error.provider` set).',
};

const geocodeErrors = {
  400: `${E.invalid} \`QUERY_TOO_LONG\`: more than ${L.queryMaxCodePoints} Unicode code points after normalization. \`LIMIT_EXCEEDED\`: a requested bound is above its limit.`,
  409: E.dataset,
  413: E.tooLargeProvider,
  502: E.provider502,
  503: E.unavailable,
  504: E.timeout(L.searchDeadlineMs),
};

const searchQuery = {
  q: { description: `Free text, 1-${L.queryMaxCodePoints} Unicode code points after search normalization (\`fa-search-norm-1\`: Arabic yeh/kaf and heh/alef variants, harakat, tatweel and Persian/Arabic digits are normalized, ZWNJ counts as a space). Returned names are the original OSM text.`, examples: ['برج آزادی', 'داروخانه کوثر', 'Synthetic Main Street'] },
  lang: { description: 'Display language for `name` (fallback per `/capabilities` `label_fallback`). Default `fa`.' },
  limit: { description: `Maximum results, ${L.searchMinResults}-${L.searchMaxResults}.` },
  bias_lon: { description: 'Optional location bias, WGS84 longitude; send together with `bias_lat`.' },
  bias_lat: { description: 'Optional location bias, WGS84 latitude; send together with `bias_lon`.' },
  bbox: { description: 'Optional bounding box `minLon,minLat,maxLon,maxLat`.' },
  dataset_id: { description: 'Optional: require this exact active release; another active release returns 409 `DATASET_MISMATCH`.' },
};

export const OPERATION_DOCS: Record<string, OperationDoc> = {
  'GET /health/live': {
    operationId: 'getLiveness',
    summary: 'Process liveness',
    description: 'Answers 200 while the API process runs. It says nothing about providers or the dataset; use `/health/ready` for that.',
    ok: 'The API process is running.',
    errors: {},
  },
  'GET /health/ready': {
    operationId: 'getReadiness',
    summary: 'Readiness of all four map capabilities',
    description:
      'Returns 200 only when tiles, routing, geocoder and Overpass all answer with the identities of the active release and the control database is reachable; otherwise 503 with the same body. Readiness is a point-in-time check: an operation can still fail afterwards, so handle its typed errors. Loading this documentation does not imply readiness.',
    ok: 'All providers serve the active release.',
    errors: { 503: 'Not ready or in maintenance. The body is the readiness document (not the error envelope); `providers[].status` shows which capability is unavailable.' },
  },
  'GET /api/v1/map/health': {
    operationId: 'getMapHealth',
    summary: 'Per-provider readiness detail (always 200)',
    description: 'The same readiness document as `/health/ready`, always with HTTP 200, for diagnostics screens that must not treat 503 as a transport error.',
    ok: 'Readiness document; inspect `status` and `providers`.',
    errors: {},
  },
  'GET /api/v1/map/capabilities': {
    operationId: 'getCapabilities',
    summary: 'Active dataset, map asset paths, routing support and limits',
    description:
      'Call at client start and after any 409 or 503. Gives the active `dataset_id`, the same-origin paths of the TileJSON, vector tiles and the four MapLibre styles, the supported routing cells, proximity metrics, POI presets and the active limits. It does not contact providers, so it can answer while a provider is down.',
    ok: 'Capabilities of the active release.',
    errors: {},
  },
  'GET /api/v1/map/search': {
    operationId: 'searchPlaces',
    summary: 'Forward geocoding (submitted search)',
    description: 'Place and address search over the active release (Photon). `result_status: "no_results"` is a normal 200. Ranks are provider relevance, not a completeness guarantee.',
    ok: 'Search results; `results` may be empty with `result_status: "no_results"`.',
    errors: geocodeErrors,
    query: searchQuery,
  },
  'GET /api/v1/map/autocomplete': {
    operationId: 'autocompletePlaces',
    summary: 'Type-ahead geocoding',
    description: 'Same parameters and response as search, tuned for partial input. Cancel the previous request when the user types again (AbortController), and debounce input.',
    ok: 'Suggestions; may be empty.',
    errors: geocodeErrors,
    query: searchQuery,
  },
  'GET /api/v1/map/reverse': {
    operationId: 'reversePlaces',
    summary: 'Reverse geocoding',
    description: `Nearest named features around a WGS84 position within \`radius_m\` (1-${L.reverseMaxRadiusM} m). \`result_status: "no_results"\` is a normal 200.`,
    ok: 'Features near the position; may be empty.',
    errors: geocodeErrors,
    query: {
      lon: { description: 'WGS84 longitude (degrees).', examples: [0.0325, 51.3380605] },
      lat: { description: 'WGS84 latitude (degrees).', examples: [0.0275, 35.6997384] },
      lang: { description: 'Display language; default `fa`.' },
      limit: { description: `Maximum results, ${L.searchMinResults}-${L.searchMaxResults}.` },
      radius_m: { description: `Search radius in metres, 1-${L.reverseMaxRadiusM}.` },
      dataset_id: searchQuery.dataset_id,
    },
  },
  'POST /api/v1/map/route': {
    operationId: 'computeRoute',
    summary: 'Route through ordered or optimized stops',
    description: [
      'Profiles `car`, `pedestrian`, `motorcycle`; objectives `time`, `distance`; order `ordered` (default) or `optimized`.',
      `Supported cells: ordered 2 points with up to ${L.maxAlternatives} alternatives; ordered 3-${L.orderedMaxPoints} points without alternatives; optimized 2 points (input order returned); optimized 3-${L.optimizedMaxPoints} points with fixed first and last stop.`,
      'Optimized order is exact only for the modeled directed pair-cost table (Held–Karp), not a global road-route optimum. Durations are static estimates: no live traffic and no departure time; `date_time` and `live_traffic` are always rejected with 422 `UNSUPPORTED_COMBINATION`.',
      'Point ids must be unique within the request. Geometry is GeoJSON with `[lon, lat]` positions; distances in metres, durations in seconds.',
    ].join('\n\n'),
    ok: 'Routes (rank 0 is the primary route); `optimization` is present for optimized order.',
    errors: {
      400: `${E.invalid} \`LIMIT_EXCEEDED\`: more points than the cell allows, or a routing-engine distance/location limit.`,
      409: E.dataset,
      413: E.tooLargeBody,
      422: '`UNSUPPORTED_COMBINATION` (see `/capabilities` `routing.unsupported`), `NO_ROUTE` (no finite route/visit order; no stop is ever omitted) or `POINT_NOT_ROUTABLE` (a point is too far from the road network for the profile).',
      502: E.provider502,
      503: E.unavailable,
      504: `${E.timeout(L.routeDeadlineMs)} Optimized routes use a ${L.optimizeDeadlineMs / 1000} s deadline.`,
    },
    bodyExamples: {
      fixture_two_point_alternatives: {
        summary: 'Two points, car, up to 2 alternatives (synthetic fixture)',
        description: FIXTURE,
        value: { profile: 'car', objective: 'time', points: [{ id: 'a', lon: 0.01, lat: 0.02 }, { id: 'b', lon: 0.05, lat: 0.03 }], alternatives: 2, language: 'fa' },
      },
      fixture_optimized: {
        summary: 'Optimized pedestrian visit order, fixed first/last (synthetic fixture)',
        description: FIXTURE,
        value: {
          profile: 'pedestrian',
          objective: 'distance',
          order: 'optimized',
          points: [{ id: 'start', lon: 0.01, lat: 0.02 }, { id: 'x', lon: 0.04, lat: 0.035 }, { id: 'y', lon: 0.02, lat: 0.035 }, { id: 'end', lon: 0.05, lat: 0.02 }],
        },
      },
      iran_two_point: {
        summary: 'Tehran: Azadi Tower to Milad Tower, car (Iran, illustrative)',
        description: IRAN,
        value: { profile: 'car', objective: 'time', points: [{ id: 'azadi', lon: 51.3380605, lat: 35.6997384 }, { id: 'milad', lon: 51.3753, lat: 35.7448 }] },
      },
      unsupported_live_traffic: {
        summary: 'Rejected: live traffic is unsupported (expect 422)',
        description: 'Shows the typed UNSUPPORTED_COMBINATION error; any dataset.',
        value: { profile: 'car', objective: 'time', points: [{ id: 'a', lon: 0.01, lat: 0.02 }, { id: 'b', lon: 0.05, lat: 0.03 }], live_traffic: true },
      },
    },
  },
  'POST /api/v1/map/proximity': {
    operationId: 'rankProximity',
    summary: 'Rank supplied candidates by distance or travel time',
    description: [
      `Ranks only the supplied candidates (at most ${L.proximityMaxCandidates}); it never searches for other places.`,
      '`metric` is explicit: `straight_line` (PostGIS geodesic, no profile), `road_distance` or `travel_time` (one Valhalla route per origin/candidate pair, costed for the requested metric; `profile` required). `direction` is explicit: `origin_to_candidate` or `candidate_to_origin` (one-way streets make them differ).',
      'Unreachable candidates stay in the result with `status: "unreachable"` and `rank: null`.',
    ].join('\n\n'),
    ok: 'Ranked candidates with `distance_m` / `duration_s`.',
    errors: {
      400: `${E.invalid} \`LIMIT_EXCEEDED\`: more than ${L.proximityMaxCandidates} candidates.`,
      409: E.dataset,
      413: E.tooLargeBody,
      422: '`POINT_NOT_ROUTABLE` / `NO_ROUTE` from the routing engine for road metrics.',
      502: E.provider502,
      503: E.unavailable,
      504: E.timeout(L.optimizeDeadlineMs),
    },
    bodyExamples: {
      fixture_road_distance: {
        summary: 'Road distance from an origin to two candidates, car (synthetic fixture)',
        description: FIXTURE,
        value: { metric: 'road_distance', direction: 'origin_to_candidate', profile: 'car', origin: { lon: 0.03, lat: 0.04 }, candidates: [{ id: 'south', lon: 0.03, lat: 0.02 }, { id: 'side', lon: 0.02, lat: 0.02 }] },
      },
      straight_line: {
        summary: 'Straight-line ranking, no profile (synthetic fixture)',
        description: FIXTURE,
        value: { metric: 'straight_line', direction: 'origin_to_candidate', origin: { lon: 0.03, lat: 0.04 }, candidates: [{ id: 'south', lon: 0.03, lat: 0.02 }, { id: 'side', lon: 0.02, lat: 0.02 }] },
      },
    },
  },
  'GET /api/v1/map/pois': {
    operationId: 'queryPois',
    summary: 'Bounded points of interest in a box',
    description: `Overpass query restricted to a preset (\`${POI_PRESETS.map((p) => p.id).join('`, `')}\`) or one allowlisted \`key\`/\`value\` pair (see \`/capabilities\` \`pois.selector_allowlist\`). The box is at most ${L.poiMaxBboxKm2} km²; at most ${L.poiMaxResults} results with a \`truncated\` flag.`,
    ok: 'Features in the box; `truncated` tells whether the limit cut the list.',
    errors: {
      400: `${E.invalid} \`BBOX_TOO_LARGE\` (over ${L.poiMaxBboxKm2} km²), \`UNKNOWN_PRESET\`, \`LIMIT_EXCEEDED\` (Overpass memory or result bounds).`,
      409: E.dataset,
      413: E.tooLargeProvider,
      502: E.provider502,
      503: E.unavailable,
      504: E.timeout(L.poiDeadlineMs),
    },
    query: {
      bbox: { description: 'Box `minLon,minLat,maxLon,maxLat` (WGS84).', examples: ['0.005,0.005,0.06,0.06'] },
      preset: { description: 'Preset id; alternatively send `key` and `value`.' },
      key: { description: 'Allowlisted OSM key (with `value`).' },
      value: { description: 'Allowlisted OSM value for `key`.' },
      limit: { description: `Maximum results, 1-${L.poiMaxResults}.` },
      lang: { description: 'Display language; default `fa`.' },
      dataset_id: searchQuery.dataset_id,
    },
  },
};

const STATUS_TEXT: Record<number, string> = { 400: 'Bad request', 409: 'Dataset mismatch', 413: 'Payload too large', 422: 'Unsupported or unroutable', 502: 'Provider error', 503: 'Unavailable', 504: 'Timeout' };

/** Error envelope without its $id, so each status can carry its own description. */
function errorDoc(text: string): Record<string, unknown> {
  const { $id: _id, ...rest } = JSON.parse(JSON.stringify(ErrorBodySchema)) as Record<string, unknown>;
  return { ...rest, description: text };
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** @fastify/swagger `transform`: documentation only; the route's validation schema is untouched. */
export function documentRoute({ schema, url, route }: { schema: FastifySchema; url: string; route: { method: string | string[] } }): { schema: FastifySchema; url: string } {
  const s = schema as Record<string, unknown> | undefined;
  if (!s || s.hide) return { schema, url };
  const method = (Array.isArray(route.method) ? route.method[0]! : route.method).toUpperCase();
  const doc = OPERATION_DOCS[`${method} ${url}`];
  if (!doc) throw new Error(`public route ${method} ${url} has no OpenAPI documentation entry (apps/api/src/api-docs.ts)`);
  const out: Record<string, unknown> = { ...clone(s), operationId: doc.operationId, summary: doc.summary, description: doc.description };
  const qs = out.querystring as { properties?: Record<string, Record<string, unknown>> } | undefined;
  if (qs?.properties && doc.query) {
    for (const [name, d] of Object.entries(doc.query)) {
      const p = qs.properties[name];
      if (!p) throw new Error(`documented query parameter ${name} is not in the ${method} ${url} schema`);
      if (d.description) p.description = d.description;
      if (d.examples) p.examples = d.examples;
    }
  }
  if (doc.bodyExamples) {
    const body = out.body as Record<string, unknown> | undefined;
    if (!body) throw new Error(`body examples documented for ${method} ${url}, which has no body schema`);
    body['x-examples'] = doc.bodyExamples;
  }
  const responses = (out.response as Record<string, Record<string, unknown>> | undefined) ?? {};
  const documented: Record<string, unknown> = {};
  for (const [status, sch] of Object.entries(responses)) {
    const code = Number(status);
    if (code === 200) documented[status] = { ...sch, description: doc.ok };
    else if (doc.errors[code]) documented[status] = sch.$id === 'ErrorBody' || (sch.properties as Record<string, unknown> | undefined)?.error ? errorDoc(`${STATUS_TEXT[code] ?? 'Error'}. ${doc.errors[code]}`) : { ...sch, description: doc.errors[code] };
    // A status in the route schema without a documented meaning is dropped rather than shown vaguely.
  }
  for (const [status, text] of Object.entries(doc.errors)) {
    if (!documented[status]) documented[status] = errorDoc(`${STATUS_TEXT[Number(status)] ?? 'Error'}. ${text}`);
  }
  if (!documented['200']) documented['200'] = { description: doc.ok };
  out.response = documented;
  return { schema: out as FastifySchema, url };
}

const assetRows = [
  ['TileJSON', '`/maps/{dataset_id}/tiles.json`', '`application/json` TileJSON 3.0.0; absolute tile URL for the requesting origin', '`no-cache`'],
  ['Vector tiles', '`/maps/{dataset_id}/tiles/{z}/{x}/{y}.pbf`, z 0-16', '`application/vnd.mapbox-vector-tile` (gzip when accepted). **204** = empty tile outside coverage (not an error)', '1 day; keyed by dataset'],
  ['Styles', '`/maps/{dataset_id}/styles/{light|dark}-{fa|en}.json`', 'MapLibre style v8 with absolute source, glyph and sprite URLs for the requesting origin', '`no-cache`'],
  ['Glyphs', '`/maps/{dataset_id}/fonts/{fontstack}/{start}-{end}.pbf`', 'SDF glyph ranges (Vazirmatn Regular / Bold); referenced by the style', '7 days, immutable'],
  ['Font files', '`/maps/{dataset_id}/fonts/files/Vazirmatn-{Regular|Bold}.woff2`', 'For UI text outside the map', '7 days, immutable'],
  ['Sprites', '`/maps/{dataset_id}/sprites/{light|dark}[@2x].{json|png}`', 'Icon sprite sheets referenced by the style', '7 days'],
];

export const API_DESCRIPTION = [
  'Internal-network map API (phase 1). Network-level access control only; Seyra Authentication is a separate future module, so do not build a client-side substitute.',
  '',
  `Contracts ${CONTRACTS_VERSION}, limits ${LIMITS_VERSION}. All paths are same-origin: \`servers\` is \`/\`, so "Try it out" calls the ingress this page was loaded from. Requests run only when you press **Execute**.`,
  '',
  '**Conventions.** WGS84 (EPSG:4326); JSON positions are `{ "lon", "lat" }`, GeoJSON positions are `[lon, lat]`. Distances in metres, durations in seconds, areas in km². Operation results, capabilities and the health documents carry `dataset_id` (liveness and ingress-generated errors do not). Durations are static estimates (no live traffic); optimized visit order is exact only for the modeled pair-cost table.',
  '',
  '**Errors.** API errors use the typed envelope `{ "error": { "code", "message", "request_id", "provider"?, "details"?, "dataset_id"? } }`; the HTTP status follows the code. Responses generated by the ingress itself (unknown map resource 404, `DATASET_MISMATCH` for map assets, tile provider 503, 413 for an oversized body) use the same envelope; their `request_id` is the ingress request id (recorded in the proxy access log) and they carry no `dataset_id`. Requests outside the network allowlist get 403 and an unknown `Host` gets 421; those two responses are not JSON.',
  '',
  '**Map assets (served by the ingress, not by this API, so they are not operations here).** Discover the current paths from `GET /api/v1/map/capabilities` (`map.*`) and never hard-code a dataset id. A path whose `{dataset_id}` is not the active release returns 404 `DATASET_MISMATCH`: reload capabilities and the style. Style and TileJSON documents contain absolute URLs built from the origin that requested them.',
  '',
  '| Asset | Path | Content | Caching |',
  '| --- | --- | --- | --- |',
  ...assetRows.map((r) => `| ${r.join(' | ')} |`),
  '',
  'Attribution: map data © OpenStreetMap contributors (ODbL); the styles carry the attribution string, keep it visible. Vazirmatn is licensed under the SIL Open Font License (`/licenses/vazirmatn-ofl.txt`).',
].join('\n');

export const API_TAGS = [
  { name: 'health', description: 'Liveness and readiness. Readiness is a point-in-time check of all four capabilities.' },
  { name: 'map', description: 'Capabilities and the discovery of map assets (styles, TileJSON, tiles, glyphs, sprites).' },
  { name: 'geocoding', description: 'Search, autocomplete and reverse geocoding (Photon over the active release).' },
  { name: 'routing', description: 'Ordered and optimized routes (Valhalla). Static durations; no live traffic.' },
  { name: 'proximity', description: 'Ranking of supplied candidates by straight-line or road metrics.' },
  { name: 'pois', description: 'Bounded Overpass presets and allowlisted selectors.' },
];

/** Swagger UI configuration: same-origin, user-triggered requests only, nothing remote. */
export const SWAGGER_UI_CONFIG = {
  layout: 'BaseLayout', // no top bar, so no field to load another specification URL
  validatorUrl: null, // never contact an online validator
  queryConfigEnabled: false, // ignore ?url= / ?configUrl= overrides
  tryItOutEnabled: false, // each operation needs "Try it out", then "Execute"
  supportedSubmitMethods: ['get', 'post'],
  withCredentials: false,
  persistAuthorization: false,
  displayOperationId: true,
  displayRequestDuration: true,
  defaultModelsExpandDepth: 0,
  docExpansion: 'list',
} as const;

export const PUBLIC_API_PREFIX = API_PREFIX;
