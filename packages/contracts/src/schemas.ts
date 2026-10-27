import { Type, type Static } from 'typebox';
import { CATALOG_POI_KEYS, POI_PRESETS } from './poi-catalog.js';
import { OBJECTIVES, ORDER_MODES, PROFILES } from './routing-support.js';

const lit = <T extends string>(values: readonly T[]) => Type.Enum<T[]>(values as T[]);

// ---------------------------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------------------------

export const DATASET_ID_PATTERN = '^[a-z0-9][a-z0-9-]{2,79}$';
export const DatasetIdSchema = Type.String({ pattern: DATASET_ID_PATTERN, description: 'Active map dataset release id' });

export const LanguageSchema = lit(['fa', 'en'] as const);
export type Language = Static<typeof LanguageSchema>;

export const LonSchema = Type.Number({ minimum: -180, maximum: 180, description: 'WGS84 longitude (degrees)' });
export const LatSchema = Type.Number({ minimum: -90, maximum: 90, description: 'WGS84 latitude (degrees)' });

export const LonLatSchema = Type.Object({ lon: LonSchema, lat: LatSchema }, { additionalProperties: false });
export type LonLat = Static<typeof LonLatSchema>;

/** Client-chosen stop/candidate identifier: unique within a request. */
export const PointIdSchema = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.:-]+$' });

export const IdentifiedPointSchema = Type.Object(
  { id: PointIdSchema, lon: LonSchema, lat: LatSchema },
  { additionalProperties: false },
);
export type IdentifiedPoint = Static<typeof IdentifiedPointSchema>;

export const LineStringSchema = Type.Object({
  type: Type.Literal('LineString'),
  coordinates: Type.Array(Type.Tuple([Type.Number(), Type.Number()]), { description: '[lon, lat] pairs' }),
});

export const OsmTypeSchema = lit(['node', 'way', 'relation'] as const);

export const NamesSchema = Type.Object(
  {
    default: Type.Optional(Type.String()),
    fa: Type.Optional(Type.String()),
    en: Type.Optional(Type.String()),
  },
  { description: 'Original OSM name strings, never rewritten by normalization' },
);

export const UnitsSchema = Type.Object({ distance: Type.Literal('m'), duration: Type.Literal('s') });
export const UNITS = { distance: 'm', duration: 's' } as const;

/** "minLon,minLat,maxLon,maxLat" */
export const BboxStringSchema = Type.String({
  pattern: '^-?[0-9]{1,3}(\\.[0-9]{1,9})?(,-?[0-9]{1,3}(\\.[0-9]{1,9})?){3}$',
  description: 'minLon,minLat,maxLon,maxLat (WGS84)',
});

// ---------------------------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------------------------

export const SearchQuerySchema = Type.Object(
  {
    q: Type.String({ minLength: 1, maxLength: 1024, description: 'Free text; at most 256 Unicode code points' }),
    lang: Type.Optional(LanguageSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    bias_lon: Type.Optional(LonSchema),
    bias_lat: Type.Optional(LatSchema),
    bbox: Type.Optional(BboxStringSchema),
    dataset_id: Type.Optional(DatasetIdSchema),
  },
  { additionalProperties: false },
);
export type SearchQuery = Static<typeof SearchQuerySchema>;

export const ReverseQuerySchema = Type.Object(
  {
    lon: LonSchema,
    lat: LatSchema,
    lang: Type.Optional(LanguageSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    radius_m: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    dataset_id: Type.Optional(DatasetIdSchema),
  },
  { additionalProperties: false },
);
export type ReverseQuery = Static<typeof ReverseQuerySchema>;

export const GeocodeResultSchema = Type.Object({
  id: Type.String({ description: 'osm:<n|w|r><id>' }),
  osm_type: OsmTypeSchema,
  osm_id: Type.Integer(),
  name: Type.Union([Type.String(), Type.Null()], { description: 'Display name per language fallback (original text)' }),
  names: NamesSchema,
  category: Type.Object({ key: Type.String(), value: Type.String() }),
  address: Type.Record(Type.String(), Type.String(), { description: 'Original address components from the index' }),
  coordinate: LonLatSchema,
  extent: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),
});
export type GeocodeResult = Static<typeof GeocodeResultSchema>;

export const GeocodeResponseSchema = Type.Object({
  dataset_id: DatasetIdSchema,
  provider: Type.Literal('photon'),
  operation: lit(['search', 'autocomplete', 'reverse'] as const),
  language: LanguageSchema,
  normalized_query: Type.Optional(Type.String()),
  result_status: lit(['ok', 'no_results'] as const),
  results: Type.Array(GeocodeResultSchema),
});
export type GeocodeResponse = Static<typeof GeocodeResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

export const ProfileSchema = lit(PROFILES);
export const ObjectiveSchema = lit(OBJECTIVES);
export const OrderModeSchema = lit(ORDER_MODES);

export const RouteRequestSchema = Type.Object(
  {
    profile: ProfileSchema,
    objective: ObjectiveSchema,
    order: Type.Optional(OrderModeSchema),
    points: Type.Array(IdentifiedPointSchema, { minItems: 2, maxItems: 100 }),
    alternatives: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    language: Type.Optional(LanguageSchema),
    dataset_id: Type.Optional(DatasetIdSchema),
    // Accepted only to return a typed UNSUPPORTED_COMBINATION instead of a generic schema error.
    date_time: Type.Optional(Type.Unknown({ description: 'Unsupported in phase 1; always rejected' })),
    live_traffic: Type.Optional(Type.Unknown({ description: 'Unsupported in phase 1; always rejected' })),
  },
  { additionalProperties: false },
);
export type RouteRequest = Static<typeof RouteRequestSchema>;

export const RouteLegSchema = Type.Object({
  from_id: Type.String(),
  to_id: Type.String(),
  distance_m: Type.Number(),
  duration_s: Type.Number(),
});

export const RouteSchema = Type.Object({
  rank: Type.Integer({ description: '0 = primary route, 1..n = additional routes' }),
  distance_m: Type.Number(),
  duration_s: Type.Number({ description: 'Static estimate; not live traffic' }),
  geometry: LineStringSchema,
  legs: Type.Array(RouteLegSchema),
});

export const OptimizationSchema = Type.Object({
  method: Type.Literal('held_karp_directed_pair_costs'),
  visit_order_optimal_for_pair_costs: Type.Boolean(),
  modeled_cost: Type.Number({ description: 'Sum of modeled pair costs for the chosen order' }),
  modeled_cost_unit: lit(['s', 'm'] as const),
  pair_routes_computed: Type.Integer(),
  unreachable_pairs: Type.Integer(),
  final_route_cost: Type.Number({ description: 'Same objective measured on the returned multi-stop route' }),
  note: Type.String(),
});

export const RouteResponseSchema = Type.Object({
  dataset_id: DatasetIdSchema,
  provider: Type.Literal('valhalla'),
  profile: ProfileSchema,
  objective: ObjectiveSchema,
  order: OrderModeSchema,
  route_optimality: Type.Literal('not_guaranteed'),
  duration_semantics: Type.Literal('static_estimate'),
  units: UnitsSchema,
  coordinate_order: Type.Literal('lon,lat'),
  visit_order: Type.Array(Type.Object({ id: Type.String(), input_index: Type.Integer() })),
  alternatives_requested: Type.Integer(),
  alternatives_returned: Type.Integer(),
  optimization: Type.Optional(OptimizationSchema),
  routes: Type.Array(RouteSchema),
});
export type RouteResponse = Static<typeof RouteResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Proximity
// ---------------------------------------------------------------------------------------------

export const METRICS = ['straight_line', 'road_distance', 'travel_time'] as const;
export const DIRECTIONS = ['origin_to_candidate', 'candidate_to_origin'] as const;
export type Metric = (typeof METRICS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export const ProximityRequestSchema = Type.Object(
  {
    metric: lit(METRICS),
    direction: lit(DIRECTIONS),
    profile: Type.Optional(ProfileSchema),
    origin: LonLatSchema,
    candidates: Type.Array(IdentifiedPointSchema, { minItems: 1, maxItems: 500 }),
    dataset_id: Type.Optional(DatasetIdSchema),
  },
  { additionalProperties: false },
);
export type ProximityRequest = Static<typeof ProximityRequestSchema>;

export const ProximityResultSchema = Type.Object({
  id: Type.String(),
  input_index: Type.Integer(),
  rank: Type.Union([Type.Integer(), Type.Null()]),
  status: lit(['reachable', 'unreachable'] as const),
  distance_m: Type.Union([Type.Number(), Type.Null()]),
  duration_s: Type.Union([Type.Number(), Type.Null()]),
});

export const ProximityResponseSchema = Type.Object({
  dataset_id: DatasetIdSchema,
  metric: lit(METRICS),
  direction: lit(DIRECTIONS),
  profile: Type.Union([ProfileSchema, Type.Null()]),
  provider: lit(['postgis', 'valhalla'] as const),
  ranking_scope: Type.Literal('supplied_candidates_only'),
  ranked_by: lit(['distance_m', 'duration_s'] as const),
  units: UnitsSchema,
  results: Type.Array(ProximityResultSchema),
});
export type ProximityResponse = Static<typeof ProximityResponseSchema>;

// ---------------------------------------------------------------------------------------------
// POIs (bounded Overpass presets)
// ---------------------------------------------------------------------------------------------

export const PoiQuerySchema = Type.Object(
  {
    bbox: BboxStringSchema,
    preset: Type.Optional(lit(POI_PRESETS.map((p) => p.id))),
    key: Type.Optional(lit(CATALOG_POI_KEYS)),
    value: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    lang: Type.Optional(LanguageSchema),
    dataset_id: Type.Optional(DatasetIdSchema),
  },
  { additionalProperties: false },
);
export type PoiQuery = Static<typeof PoiQuerySchema>;

export const PoiFeatureSchema = Type.Object({
  id: Type.String(),
  osm_type: OsmTypeSchema,
  osm_id: Type.Integer(),
  coordinate: LonLatSchema,
  key: Type.String(),
  value: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  names: NamesSchema,
});

export const PoiResponseSchema = Type.Object({
  dataset_id: DatasetIdSchema,
  provider: Type.Literal('overpass'),
  selector: Type.Object({ preset: Type.Union([Type.String(), Type.Null()]), filters: Type.Array(Type.Object({ key: Type.String(), value: Type.String() })) }),
  bbox: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
  bbox_area_km2: Type.Number(),
  limit: Type.Integer(),
  truncated: Type.Boolean(),
  features: Type.Array(PoiFeatureSchema),
});
export type PoiResponse = Static<typeof PoiResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Health / capabilities
// ---------------------------------------------------------------------------------------------

export const PROVIDER_IDS = ['tiles', 'routing', 'geocoder', 'overpass'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ProviderHealthSchema = Type.Object({
  provider: lit(PROVIDER_IDS),
  implementation: Type.String(),
  status: lit(['ok', 'unavailable', 'revision_mismatch', 'unknown'] as const),
  expected_identity: Type.Union([Type.String(), Type.Null()]),
  observed_identity: Type.Union([Type.String(), Type.Null()]),
  latency_ms: Type.Union([Type.Number(), Type.Null()]),
  checked_at: Type.Union([Type.String(), Type.Null()]),
  error: Type.Optional(Type.String()),
});
export type ProviderHealth = Static<typeof ProviderHealthSchema>;

export const DependencyHealthSchema = Type.Object({
  name: Type.Literal('control_db'),
  status: lit(['ok', 'unavailable'] as const),
  error: Type.Optional(Type.String()),
});

export const ReadinessSchema = Type.Object({
  status: lit(['ready', 'not_ready', 'maintenance'] as const),
  dataset_id: Type.Union([DatasetIdSchema, Type.Null()]),
  providers: Type.Array(ProviderHealthSchema),
  dependencies: Type.Array(DependencyHealthSchema),
  checked_at: Type.String(),
});
export type Readiness = Static<typeof ReadinessSchema>;
