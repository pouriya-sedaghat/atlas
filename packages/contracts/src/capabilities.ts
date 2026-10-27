import { Type, type Static } from 'typebox';
import { DIRECTIONS, METRICS } from './schemas.js';
import { CATALOG_POI_KEYS } from './poi-catalog.js';
import { OBJECTIVES, ORDER_MODES, PROFILES } from './routing-support.js';

const lit = <T extends string>(values: readonly T[]) => Type.Enum<T[]>(values as T[]);
const strings = (description?: string) => Type.Array(Type.String(), description ? { description } : {});

/**
 * Response of GET /api/v1/map/capabilities. It documents the contract (OpenAPI, client codegen and
 * tests); responses are serialized as plain JSON, so this schema never strips or reorders fields.
 */
export const SupportCellSchema = Type.Object({
  order: lit(ORDER_MODES),
  min_points: Type.Integer(),
  max_points: Type.Integer(),
  objectives: Type.Array(lit(OBJECTIVES)),
  profiles: Type.Array(lit(PROFILES)),
  max_alternatives: Type.Integer(),
  note: Type.String(),
});

export const MapLimitsSchema = Type.Object(
  {
    orderedMaxPoints: Type.Integer(),
    optimizedMaxPoints: Type.Integer(),
    maxAlternatives: Type.Integer(),
    proximityMaxCandidates: Type.Integer(),
    searchMinResults: Type.Integer(),
    searchMaxResults: Type.Integer(),
    queryMaxCodePoints: Type.Integer(),
    poiMaxBboxKm2: Type.Number(),
    poiMaxResults: Type.Integer(),
    overpassTimeoutS: Type.Integer(),
    overpassMaxSizeBytes: Type.Integer(),
    providerConcurrency: Type.Integer(),
    providerQueueSize: Type.Integer(),
    routeDeadlineMs: Type.Integer(),
    optimizeDeadlineMs: Type.Integer(),
    searchDeadlineMs: Type.Integer(),
    poiDeadlineMs: Type.Integer(),
    reverseMaxRadiusM: Type.Integer(),
  },
  { description: 'Active, versioned limits (limits_version). Operators may only tighten them.' },
);

const assetPath = (what: string) => Type.String({ description: `${what}. A same-origin path; resolve it against the ingress origin.` });

export const CapabilitiesSchema = Type.Object(
  {
    api_version: Type.Literal('v1'),
    contracts_version: Type.String(),
    limits_version: Type.String(),
    catalog_version: Type.String(),
    search_normalization_version: Type.String(),
    dataset_id: Type.String({ description: 'Active map dataset release; also echoed in every API response' }),
    coordinate_reference: Type.String(),
    units: Type.Object({ distance: Type.Literal('m'), duration: Type.Literal('s'), area: Type.Literal('km2') }),
    languages: Type.Array(lit(['fa', 'en'] as const)),
    label_fallback: Type.Object({ fa: strings(), en: strings() }, { description: 'OSM name keys tried in order per display language' }),
    required_capabilities: Type.Array(lit(['tiles', 'routing', 'geocoder', 'overpass'] as const), { description: 'All four are mandatory; none can be disabled' }),
    providers: Type.Object({
      tiles: Type.Literal('tegola'),
      routing: Type.Literal('valhalla'),
      geocoder: Type.Literal('photon'),
      overpass: Type.Literal('overpass'),
      straight_line: Type.Literal('postgis'),
    }),
    map: Type.Object({
      tilejson: assetPath('TileJSON 3.0.0 document of the active release'),
      tiles: assetPath('Mapbox Vector Tile URL template, z 0-16'),
      tegola_map: Type.String(),
      styles: Type.Object({
        light_fa: assetPath('MapLibre style, light, Persian labels'),
        light_en: assetPath('MapLibre style, light, English labels'),
        dark_fa: assetPath('MapLibre style, dark, Persian labels'),
        dark_en: assetPath('MapLibre style, dark, English labels'),
      }),
      native_zoom: Type.Object({ min: Type.Integer(), max: Type.Integer() }),
      client_max_zoom: Type.Integer(),
      overzoom_note: Type.String(),
    }),
    routing: Type.Object({
      profiles: Type.Array(lit(PROFILES)),
      objectives: Type.Array(lit(OBJECTIVES)),
      order_modes: Type.Array(lit(ORDER_MODES)),
      support: Type.Array(SupportCellSchema, { description: 'Every supported (order, point count) cell; anything else is UNSUPPORTED_COMBINATION' }),
      unsupported: strings('Combinations that are always rejected in phase 1'),
      route_optimality: Type.Literal('not_guaranteed'),
      duration_semantics: Type.Literal('static_estimate'),
      optimization: Type.String(),
    }),
    proximity: Type.Object({
      metrics: Type.Array(lit(METRICS)),
      directions: Type.Array(lit(DIRECTIONS)),
      max_candidates: Type.Integer(),
      ranking_scope: Type.Literal('supplied_candidates_only'),
    }),
    geocoding: Type.Object({
      operations: Type.Array(lit(['search', 'autocomplete', 'reverse'] as const)),
      result_limit: Type.Object({ min: Type.Integer(), max: Type.Integer() }),
      query_max_code_points: Type.Integer(),
    }),
    pois: Type.Object({
      presets: Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.Object({ fa: Type.String(), en: Type.String() }),
          filters: Type.Array(Type.Object({ key: lit(CATALOG_POI_KEYS), value: Type.String() })),
        }),
      ),
      selector_allowlist: Type.Record(Type.String(), strings(), { description: 'Allowed key/value selectors for key=&value= queries' }),
      max_bbox_km2: Type.Number(),
      max_results: Type.Integer(),
      overpass_timeout_s: Type.Integer(),
    }),
    limits: MapLimitsSchema,
  },
  { description: 'Active dataset, asset paths, supported routing cells, limits and catalogs. Call at start and after any 409 or 503.' },
);
export type Capabilities = Static<typeof CapabilitiesSchema>;
