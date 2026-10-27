import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  API_PREFIX,
  CATALOG_VERSION,
  CapabilitiesSchema,
  type Capabilities,
  CONTRACTS_VERSION,
  DIRECTIONS,
  ErrorBodySchema,
  GeocodeResponseSchema,
  LIMITS_VERSION,
  MapServiceError,
  METRICS,
  OBJECTIVES,
  ORDER_MODES,
  POI_PRESETS,
  PROFILES,
  PoiQuerySchema,
  PoiResponseSchema,
  ProximityRequestSchema,
  ProximityResponseSchema,
  ReadinessSchema,
  ReverseQuerySchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SEARCH_NORMALIZATION_VERSION,
  SearchQuerySchema,
  UNSUPPORTED_COMBINATIONS,
  VALUE_ALLOWLIST,
  routingSupportTable,
  type ErrorBody,
  type MapLimits,
  type ProviderId,
} from '@seyra/contracts';
import { deadlineSignal } from './concurrency.js';
import type { HealthService } from './services/health.js';
import { GeocodeService, type GeocoderProvider } from './services/geocode.js';
import { PoiService, type PoiProvider } from './services/poi.js';
import { ProximityService, type GeographyDistance } from './services/proximity.js';
import { RoutingService, validateRouteRequest, type RoutingProvider } from './services/routing.js';
import { tegolaMapName } from './release.js';
import { API_DESCRIPTION, API_TAGS, DOCS_PREFIX, SWAGGER_UI_CONFIG, documentRoute } from './api-docs.js';

export interface AppDeps {
  limits: MapLimits;
  health: HealthService;
  routing: RoutingProvider;
  geocoder: GeocoderProvider;
  poi: PoiProvider;
  geography: GeographyDistance;
  logLevel?: string;
  /** Optional log destination (tests); defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  /** Aborted on shutdown so admitted work is cancelled after the drain grace period. */
  shutdownSignal?: AbortSignal;
  providerStats?: () => Record<string, unknown>;
}

const NATIVE_MAX_ZOOM = 16;
const CLIENT_MAX_ZOOM = 22;

/**
 * Redacted request logging: method, route pattern, status and timing only. Query strings,
 * bodies, coordinates, search text and credentials never reach the default logs.
 */
const logSerializers = {
  req(req: FastifyRequest) {
    return { id: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched' };
  },
  res(res: { statusCode: number }) {
    return { statusCode: res.statusCode };
  },
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logLevel === 'silent' ? false : { level: deps.logLevel ?? 'info', serializers: logSerializers, ...(deps.logStream ? { stream: deps.logStream } : {}) },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
    return503OnClosing: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Plain JSON serialization: response schemas document the contract (OpenAPI + tests) but
  // must never silently drop fields.
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // One documentation source: the runtime document at /api/docs/json and the exported
  // docs/openapi/map-services-v1.json both come from these registered routes (api-docs.ts).
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Seyra Map Services API', version: CONTRACTS_VERSION, description: API_DESCRIPTION },
      servers: [{ url: '/' }],
      tags: API_TAGS,
    },
    transform: documentRoute,
  });
  // Local Swagger UI assets only; the ingress owns the effective CSP (staticCSP stays off so the
  // plugin never adds a second, conflicting policy).
  await app.register(swaggerUi, { routePrefix: DOCS_PREFIX, staticCSP: false, uiConfig: { ...SWAGGER_UI_CONFIG, supportedSubmitMethods: [...SWAGGER_UI_CONFIG.supportedSubmitMethods] } });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    let mapped: MapServiceError;
    if (err instanceof MapServiceError) {
      mapped = err;
    } else if ((err as { validation?: unknown }).validation) {
      const v = err as unknown as { message: string; validationContext?: string };
      mapped = new MapServiceError('INVALID_REQUEST', v.message, { details: { part: v.validationContext ?? 'request' } });
    } else if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      mapped = new MapServiceError('PAYLOAD_TOO_LARGE', 'request body too large');
    } else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      mapped = new MapServiceError('INVALID_REQUEST', err instanceof Error ? err.message : 'invalid request');
    } else {
      req.log.error({ err: { type: (err as Error).name, message: (err as Error).message } }, 'unhandled error');
      mapped = new MapServiceError('INTERNAL', 'internal error');
    }
    if (mapped.status >= 500 && mapped.code !== 'INTERNAL') {
      req.log.warn({ code: mapped.code, provider: mapped.provider }, 'map operation failed');
    }
    const body: ErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        request_id: req.id,
        ...(mapped.provider ? { provider: mapped.provider } : {}),
        ...(mapped.details ? { details: mapped.details } : {}),
        dataset_id: deps.health.datasetId,
      },
    };
    if (mapped.code === 'OVERLOADED' || mapped.code === 'MAINTENANCE') reply.header('retry-after', '5');
    return reply.status(mapped.status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = { error: { code: 'NOT_FOUND', message: 'no such endpoint', request_id: req.id } };
    return reply.status(404).send(body);
  });

  const datasetId = deps.health.datasetId;
  const geocode = new GeocodeService(deps.geocoder, deps.limits);
  const routing = new RoutingService(deps.routing, deps.limits);
  const proximity = new ProximityService(deps.routing, deps.geography, deps.limits);
  const poi = new PoiService(deps.poi, deps.limits);

  /** Per-request signal: client disconnect, operation deadline and shutdown all cancel work. */
  const requestSignal = (reply: FastifyReply, deadlineMs: number): AbortSignal => {
    const ctrl = new AbortController();
    // 'close' before the response finished means the client went away: release admitted work.
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) ctrl.abort(new MapServiceError('CANCELLED', 'client disconnected'));
    });
    const signals = [ctrl.signal];
    if (deps.shutdownSignal) signals.push(deps.shutdownSignal);
    return deadlineSignal(AbortSignal.any(signals), deadlineMs);
  };

  const checkDataset = (requested: string | undefined) => {
    if (requested !== undefined && requested !== datasetId) {
      throw new MapServiceError('DATASET_MISMATCH', 'requested dataset_id is not the active release; reload map assets', {
        details: { requested, active: datasetId },
      });
    }
  };
  const gate = (provider: ProviderId) => deps.health.gate(provider);

  const errorResponses = { 400: ErrorBodySchema, 409: ErrorBodySchema, 422: ErrorBodySchema, 502: ErrorBodySchema, 503: ErrorBodySchema, 504: ErrorBodySchema };

  // -------------------------------------------------------------------------------------------
  app.get('/health/live', { schema: { tags: ['health'], response: { 200: Type.Object({ status: Type.Literal('ok') }) } } }, async () => ({ status: 'ok' as const }));

  app.get(
    '/health/ready',
    { schema: { tags: ['health'], response: { 200: ReadinessSchema, 503: ReadinessSchema } } },
    async (_req, reply) => {
      const r = await deps.health.readiness();
      return reply.status(r.status === 'ready' ? 200 : 503).send(r);
    },
  );

  app.get(`${API_PREFIX}/health`, { schema: { tags: ['health'], response: { 200: ReadinessSchema } } }, async () => deps.health.readiness());

  app.get(`${API_PREFIX}/capabilities`, { schema: { tags: ['map'], response: { 200: CapabilitiesSchema } } }, async (): Promise<Capabilities> => {
    const base = `/maps/${datasetId}`;
    // Mutable copies of the frozen catalogs (identical JSON); the return type ties this object to
    // the documented CapabilitiesSchema at compile time.
    return {
      api_version: 'v1',
      contracts_version: CONTRACTS_VERSION,
      limits_version: LIMITS_VERSION,
      catalog_version: CATALOG_VERSION,
      search_normalization_version: SEARCH_NORMALIZATION_VERSION,
      dataset_id: datasetId,
      coordinate_reference: 'WGS84 (EPSG:4326); GeoJSON positions are [lon, lat]',
      units: { distance: 'm', duration: 's', area: 'km2' },
      languages: ['fa', 'en'],
      label_fallback: { fa: ['name:fa', 'name', 'name:en'], en: ['name:en', 'name', 'name:fa'] },
      required_capabilities: ['tiles', 'routing', 'geocoder', 'overpass'],
      providers: { tiles: 'tegola', routing: 'valhalla', geocoder: 'photon', overpass: 'overpass', straight_line: 'postgis' },
      map: {
        tilejson: `${base}/tiles.json`,
        tiles: `${base}/tiles/{z}/{x}/{y}.pbf`,
        tegola_map: tegolaMapName(datasetId),
        styles: {
          light_fa: `${base}/styles/light-fa.json`,
          light_en: `${base}/styles/light-en.json`,
          dark_fa: `${base}/styles/dark-fa.json`,
          dark_en: `${base}/styles/dark-en.json`,
        },
        native_zoom: { min: 0, max: NATIVE_MAX_ZOOM },
        client_max_zoom: CLIENT_MAX_ZOOM,
        overzoom_note: 'Above the native range clients overzoom; no extra geometry is invented.',
      },
      routing: {
        profiles: [...PROFILES],
        objectives: [...OBJECTIVES],
        order_modes: [...ORDER_MODES],
        support: routingSupportTable(deps.limits).map((c) => ({ ...c, objectives: [...c.objectives], profiles: [...c.profiles] })),
        unsupported: [...UNSUPPORTED_COMBINATIONS],
        route_optimality: 'not_guaranteed',
        duration_semantics: 'static_estimate',
        optimization: 'held_karp_directed_pair_costs (exact for the modeled pair-cost table only)',
      },
      proximity: { metrics: [...METRICS], directions: [...DIRECTIONS], max_candidates: deps.limits.proximityMaxCandidates, ranking_scope: 'supplied_candidates_only' },
      geocoding: {
        operations: ['search', 'autocomplete', 'reverse'],
        result_limit: { min: deps.limits.searchMinResults, max: deps.limits.searchMaxResults },
        query_max_code_points: deps.limits.queryMaxCodePoints,
      },
      pois: {
        presets: structuredClone(POI_PRESETS) as Capabilities['pois']['presets'],
        selector_allowlist: Object.fromEntries(Object.entries(VALUE_ALLOWLIST).map(([k, v]) => [k, [...v]])),
        max_bbox_km2: deps.limits.poiMaxBboxKm2,
        max_results: deps.limits.poiMaxResults,
        overpass_timeout_s: deps.limits.overpassTimeoutS,
      },
      limits: { ...deps.limits },
    };
  });

  app.get(
    `${API_PREFIX}/search`,
    { schema: { tags: ['geocoding'], querystring: SearchQuerySchema, response: { 200: GeocodeResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.query.dataset_id);
      await gate('geocoder');
      return geocode.search(req.query, 'search', datasetId, requestSignal(reply, deps.limits.searchDeadlineMs));
    },
  );

  app.get(
    `${API_PREFIX}/autocomplete`,
    { schema: { tags: ['geocoding'], querystring: SearchQuerySchema, response: { 200: GeocodeResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.query.dataset_id);
      await gate('geocoder');
      return geocode.search(req.query, 'autocomplete', datasetId, requestSignal(reply, deps.limits.searchDeadlineMs));
    },
  );

  app.get(
    `${API_PREFIX}/reverse`,
    { schema: { tags: ['geocoding'], querystring: ReverseQuerySchema, response: { 200: GeocodeResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.query.dataset_id);
      await gate('geocoder');
      return geocode.reverse(req.query, datasetId, requestSignal(reply, deps.limits.searchDeadlineMs));
    },
  );

  app.post(
    `${API_PREFIX}/route`,
    { schema: { tags: ['routing'], body: RouteRequestSchema, response: { 200: RouteResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.body.dataset_id);
      const v = validateRouteRequest(req.body, deps.limits);
      await gate('routing');
      const deadline = v.order === 'optimized' ? deps.limits.optimizeDeadlineMs : deps.limits.routeDeadlineMs;
      return routing.route(v, datasetId, requestSignal(reply, deadline));
    },
  );

  app.post(
    `${API_PREFIX}/proximity`,
    { schema: { tags: ['proximity'], body: ProximityRequestSchema, response: { 200: ProximityResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.body.dataset_id);
      proximity.validate(req.body);
      if (req.body.metric !== 'straight_line') await gate('routing');
      else if (deps.health.inMaintenance()) throw new MapServiceError('MAINTENANCE', 'map services are in a maintenance window; retry later');
      return proximity.rank(req.body, datasetId, requestSignal(reply, deps.limits.optimizeDeadlineMs));
    },
  );

  app.get(
    `${API_PREFIX}/pois`,
    { schema: { tags: ['pois'], querystring: PoiQuerySchema, response: { 200: PoiResponseSchema, ...errorResponses } } },
    async (req, reply) => {
      checkDataset(req.query.dataset_id);
      await gate('overpass');
      return poi.query(req.query, datasetId, requestSignal(reply, deps.limits.poiDeadlineMs));
    },
  );

  app.get(`${API_PREFIX}/diagnostics`, { schema: { tags: ['health'], hide: true } }, async () => ({
    dataset_id: datasetId,
    provider_queues: deps.providerStats?.() ?? {},
    node: process.version,
    uptime_s: Math.round(process.uptime()),
  }));

  return app;
}
