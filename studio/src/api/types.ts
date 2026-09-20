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
 * One mode's entry in a road's traversal block.
 *
 * Both members are typed as plain strings on purpose: they are untrusted wire
 * data, and narrowing them to the known sets is the parser's job, not the type
 * declaration's.
 *
 * `access` is optional here for the same reason `traversal` is: a Studio build
 * has to render against a Milestone 2A server that never heard of access. A
 * missing value reads as `indeterminate`, never as `unspecified` — see
 * `map/access.ts` for why that distinction matters.
 */
export interface ModeTraversal {
  direction: string;
  access?: string;
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
   * carrying access as well from Milestone 2B on. Optional here so that a
   * Studio build still renders against an older server: a road with no
   * traversal simply gets no arrows and an unresolved access.
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
