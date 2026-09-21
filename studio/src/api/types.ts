/**
 * The Atlas HTTP API, version 1, as Studio sees it.
 *
 * These are wire types. Everything in them is untrusted text that came from an
 * OSM file, so the UI renders them with `textContent` and never with `innerHTML`.
 */

/** `[west, south, east, north]`, the GeoJSON bbox order. */
export type Bbox = [number, number, number, number];

export type DatasetStatus = 'loading' | 'ready' | 'failed';

export interface SourceReference {
  system: string;
  entityType: string;
  entityId: string;
}

/**
 * One direction's ordinary speed limit, as it arrives on the wire.
 *
 * Every member is typed loosely on purpose: this is untrusted wire data, and
 * narrowing it to the known kinds, units and code shapes is the parser's job,
 * not the type declaration's. `kind` is the discriminator, and `value`,
 * `unit` and `code` are only meaningful for the kinds that carry them.
 *
 * `value` is a string, not a number. It is exact decimal text — `50`, `50.5`,
 * `0` — so that a magnitude never becomes a float on the way through.
 */
export interface SpeedLimitWire {
  kind?: string;
  value?: string;
  unit?: string;
  code?: string;
}

/**
 * Everything one direction of one mode says about its speed limit.
 *
 * Three independent members. The two modifiers describe what else the source
 * attached to the ordinary limit; neither replaces it, and a client that reads
 * only one of the three is reading part of the road.
 */
export interface SpeedLimitFactWire {
  limit?: SpeedLimitWire;
  conditional?: boolean;
  variable?: string;
}

/**
 * One mode's speed facts, one per geometry direction.
 *
 * `forward` and `backward` are relative to the coordinate order of the line,
 * never to the compass and never to a permitted direction of travel.
 */
export interface DirectionalSpeedLimits {
  forward?: SpeedLimitFactWire;
  backward?: SpeedLimitFactWire;
}

/**
 * One mode's entry in a road's traversal block.
 *
 * Every member is typed as plain untrusted wire data on purpose: narrowing to
 * the known sets is the parser's job, not the type declaration's.
 *
 * `access` and `speedLimits` are optional here for the same reason `traversal`
 * is: a Studio build has to render against a Milestone 2A server that never
 * heard of access, and against a 2B server that never heard of speed. A
 * missing value reads as `indeterminate`, never as `unspecified` — see
 * `map/access.ts` and `map/speed.ts` for why that distinction matters.
 */
export interface ModeTraversal {
  direction: string;
  access?: string;
  speedLimits?: DirectionalSpeedLimits;
}

/** The travel semantics the API publishes for a road, one entry per mode. */
export interface RoadTraversal {
  motorcar?: ModeTraversal;
  bicycle?: ModeTraversal;
  foot?: ModeTraversal;
}

export interface RoadProperties {
  kind: string;
  roadClass?: string;
  name?: string;
  source?: SourceReference;
  /**
   * Present on every road served by an Atlas v1 server from Milestone 2A on,
   * carrying access as well from Milestone 2B on and speed limits from 2C on.
   * Optional here so that a Studio build still renders against an older
   * server: a road with no traversal simply gets no arrows, an unresolved
   * access and unresolved speed limits.
   */
  traversal?: RoadTraversal;
}

export interface AtlasFeature {
  type: 'Feature';
  id: string;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
  properties: RoadProperties;
}

export interface QueryDiagnostics {
  featuresExamined: number;
  candidatesFound: number;
  featuresReturned: number;
  elapsedMs: number;
}

export interface AtlasMeta {
  apiVersion: string;
  datasetId: string;
  returned: number;
  limit: number;
  truncated: boolean;
  diagnostics?: QueryDiagnostics;
}

export interface AtlasFeatureCollection {
  type: 'FeatureCollection';
  bbox: Bbox;
  features: AtlasFeature[];
  atlas: AtlasMeta;
}

export interface DatasetWarning {
  code: string;
  count: number;
  samples: string[];
}

export interface ImportStatistics {
  elapsedMs: number;
  nodesSeen: number;
  nodesIndexed: number;
  waysSeen: number;
  roadWaysSelected: number;
  featuresEmitted: number;
  featuresSkipped: number;
  relationsSeen: number;
  bytesRead?: number;
  featureCount: number;
  /**
   * How many nodes the finished dataset topology holds, from Milestone 2D on.
   *
   * A **final dataset count**, not a source-element counter: it is not
   * `nodesIndexed`, because most indexed nodes are shape coordinates and never
   * become topology nodes.
   *
   * Optional so that a Studio build still describes an older server's response
   * accurately. Absent means the server never heard of topology, which is not
   * the same as a topology with no nodes.
   */
  topologyNodes?: number;
  /**
   * How many segments the finished dataset topology holds, from Milestone 2D
   * on.
   *
   * Also a final count, and also not `featuresEmitted`: a road splits into as
   * many segments as it has split points minus one. Optional for the same
   * reason as `topologyNodes`.
   */
  topologySegments?: number;
}

export interface CurrentDataset {
  apiVersion: string;
  status: DatasetStatus;
  datasetId?: string;
  bounds?: Bbox;
  source?: { name: string; format: string };
  attribution?: { text: string; licenseUrl: string };
  statistics?: ImportStatistics;
  warnings: DatasetWarning[];
  failure?: { category: string; message: string };
}

/**
 * One node of the road topology, as it arrives on the wire.
 *
 * Every member is optional and loosely typed on purpose: this is untrusted
 * wire data, and narrowing it is the parser's job, not the type
 * declaration's. A member Studio cannot read becomes indeterminate UI text,
 * never an invented number.
 */
export interface TopologyNodeWire {
  id?: string;
  coordinate?: [number, number];
  /** Degree in the **whole dataset**, not in the returned viewport. */
  degree?: number;
}

/**
 * One structural segment of the road topology, as it arrives on the wire.
 *
 * There is no direction, access, speed or class here, and there never will
 * be: a segment says that two points are joined, not that anyone may travel
 * between them. `roadFeatureId` is the join to the road that owns those
 * facts.
 *
 * `startNodeId` and `endNodeId` name the first and last point of the
 * geometry in the source's own coordinate order — not an origin and a
 * destination.
 */
export interface TopologySegmentWire {
  id?: string;
  roadFeatureId?: string;
  startNodeId?: string;
  endNodeId?: string;
  geometry?: {
    type?: string;
    coordinates?: [number, number][];
  };
}

export interface TopologyDiagnostics {
  segmentsExamined: number;
  candidatesFound: number;
  segmentsReturned: number;
  nodesReturned: number;
  elapsedMs: number;
}

export interface TopologyMeta {
  segmentsReturned?: number;
  nodesReturned?: number;
  limit?: number;
  truncated?: boolean;
  diagnostics?: TopologyDiagnostics;
}

/**
 * The `GET /api/v1/map/topology` payload.
 *
 * A graph, not a `FeatureCollection`: it has `nodes` and `segments` rather
 * than `features`, and it is served as `application/json`.
 */
export interface TopologyCollection {
  apiVersion?: string;
  datasetId?: string;
  bbox?: Bbox;
  nodes?: TopologyNodeWire[];
  segments?: TopologySegmentWire[];
  meta?: TopologyMeta;
}

export interface HealthPayload {
  status: string;
  datasetId?: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  };
}
