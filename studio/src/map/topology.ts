/**
 * Road topology, as Studio understands it.
 *
 * Everything here is pure: given wire data it returns view models, and it
 * never touches the DOM, the map or the network.
 *
 * Three things are worth knowing before reading on.
 *
 * **Topology is not a route.** A segment says that two source points are
 * joined by one part of one road geometry. It does not say that anybody may
 * travel it, which way, on what terms or how fast. Nothing in this file looks
 * at a direction, an access rule or a speed limit, because a segment does not
 * carry one — `roadFeatureId` is the join to the road that does.
 *
 * **Degree is not importance.** A node's degree counts how many segment ends
 * meet there in the whole dataset. A junction of five residential alleys has a
 * higher degree than a motorway that simply runs through, and the styling is
 * chosen so that a reader cannot mistake one for the other.
 *
 * **Nothing is invented.** A wire member Studio cannot read becomes
 * `null` here and indeterminate text in the inspector. A coordinate that is
 * not two finite numbers is not guessed at, and a segment that cannot be drawn
 * is left out of the map rather than drawn somewhere plausible.
 */

import type { TopologyCollection, TopologyNodeWire, TopologySegmentWire } from '../api/types.js';

/** What the inspector shows where the server said nothing readable. */
export const INDETERMINATE = 'indeterminate · not stated';

/** A `[longitude, latitude]` pair Studio has checked. */
export type Position = [number, number];

/**
 * How a node is drawn, by degree.
 *
 * Four categories, and the names are deliberately structural rather than
 * evaluative: an `endpoint` is where a road path stops, a `junction` is where
 * three or more segment ends meet, and neither says anything about how
 * important, fast or usable the roads there are.
 *
 * - `endpoint`  — degree 1. A dead end, or the edge of the imported extract.
 * - `through`   — degree 2. Two segments meet; a self-loop's single node also
 *                 lands here, because both of its ends count.
 * - `junction`  — degree 3 or more.
 * - `unknown`   — the server sent no readable degree.
 */
export const DEGREE_CATEGORIES = ['endpoint', 'through', 'junction', 'unknown'] as const;

export type DegreeCategory = (typeof DEGREE_CATEGORIES)[number];

/** One node, narrowed to what Studio is willing to believe. */
export interface TopologyNodeView {
  id: string;
  /** `null` when the server sent no readable coordinate. */
  coordinate: Position | null;
  /** `null` when the server sent no readable degree. */
  degree: number | null;
  category: DegreeCategory;
}

/** One segment, narrowed to what Studio is willing to believe. */
export interface TopologySegmentView {
  id: string;
  /** `null` when the server sent no readable owning road. */
  roadFeatureId: string | null;
  /** `null` when the server sent no readable start node id. */
  startNodeId: string | null;
  /** `null` when the server sent no readable end node id. */
  endNodeId: string | null;
  /** Every readable coordinate, in the source's own order. Never reversed. */
  coordinates: Position[];
}

/** A parsed topology response. */
export interface TopologyGraph {
  datasetId: string | null;
  nodes: TopologyNodeView[];
  segments: TopologySegmentView[];
  segmentsReturned: number;
  nodesReturned: number;
  limit: number | null;
  truncated: boolean;
  diagnostics: TopologyDiagnosticsView | null;
}

export interface TopologyDiagnosticsView {
  segmentsExamined: number | null;
  candidatesFound: number | null;
  segmentsReturned: number | null;
  nodesReturned: number | null;
  elapsedMs: number | null;
}

/** An empty graph, used before the first query answers and after a reset. */
export const EMPTY_GRAPH: TopologyGraph = {
  datasetId: null,
  nodes: [],
  segments: [],
  segmentsReturned: 0,
  nodesReturned: 0,
  limit: null,
  truncated: false,
  diagnostics: null,
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrows an untrusted wire position.
 *
 * A position is two finite numbers within the WGS84 ranges, in
 * `[longitude, latitude]` order, and nothing else. A three-element array, a
 * pair of strings, a `NaN` or an out-of-range value is not repaired, clamped
 * or half-accepted: it is simply not a position.
 */
export function parsePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const longitude = readFiniteNumber(value[0]);
  const latitude = readFiniteNumber(value[1]);
  if (longitude === null || latitude === null) {
    return null;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return null;
  }
  return [longitude, latitude];
}

/** Narrows an untrusted degree: a non-negative whole number, or nothing. */
export function parseDegree(value: unknown): number | null {
  const degree = readFiniteNumber(value);
  if (degree === null || !Number.isInteger(degree) || degree < 0) {
    return null;
  }
  return degree;
}

/** Which drawing category a degree falls in. */
export function degreeCategory(degree: number | null): DegreeCategory {
  if (degree === null) {
    return 'unknown';
  }
  if (degree >= 3) {
    return 'junction';
  }
  if (degree === 2) {
    return 'through';
  }
  // Degree 0 is not something a returned node can have — every returned node
  // is an endpoint of a returned segment — but it is still a dead end rather
  // than an unknown, so it reads the same way.
  return 'endpoint';
}

function parseNode(value: unknown): TopologyNodeView | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const wire = value as TopologyNodeWire;
  // Without an identity there is nothing to inspect, match or talk about, so
  // the entry is dropped rather than shown as an anonymous dot.
  const id = readString(wire.id);
  if (id === null) {
    return null;
  }
  const degree = parseDegree(wire.degree);
  return {
    id,
    coordinate: parsePosition(wire.coordinate),
    degree,
    category: degreeCategory(degree),
  };
}

function parseSegment(value: unknown): TopologySegmentView | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const wire = value as TopologySegmentWire;
  const id = readString(wire.id);
  if (id === null) {
    return null;
  }
  const raw = wire.geometry?.coordinates;
  // A geometry that is not a `LineString` is not silently treated as one.
  const isLine = wire.geometry?.type === 'LineString' && Array.isArray(raw);
  const coordinates: Position[] = [];
  if (isLine) {
    for (const entry of raw) {
      const position = parsePosition(entry);
      // One unreadable coordinate does not close the gap around it: the
      // whole geometry is abandoned, exactly as the importer abandons a way
      // whose reference it cannot resolve.
      if (position === null) {
        coordinates.length = 0;
        break;
      }
      coordinates.push(position);
    }
  }
  return {
    id,
    roadFeatureId: readString(wire.roadFeatureId),
    startNodeId: readString(wire.startNodeId),
    endNodeId: readString(wire.endNodeId),
    coordinates,
  };
}

function parseDiagnostics(value: unknown): TopologyDiagnosticsView | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const wire = value as Record<string, unknown>;
  return {
    segmentsExamined: readFiniteNumber(wire.segmentsExamined),
    candidatesFound: readFiniteNumber(wire.candidatesFound),
    segmentsReturned: readFiniteNumber(wire.segmentsReturned),
    nodesReturned: readFiniteNumber(wire.nodesReturned),
    elapsedMs: readFiniteNumber(wire.elapsedMs),
  };
}

/**
 * Narrows a whole topology response.
 *
 * Anything that is not an object, or whose `nodes`/`segments` are not arrays,
 * produces an empty graph rather than an exception: a malformed response
 * leaves the overlay empty and the road map untouched.
 */
export function parseTopology(payload: unknown): TopologyGraph {
  if (typeof payload !== 'object' || payload === null) {
    return EMPTY_GRAPH;
  }
  const wire = payload as TopologyCollection;
  const nodes = Array.isArray(wire.nodes)
    ? wire.nodes.map(parseNode).filter((node): node is TopologyNodeView => node !== null)
    : [];
  const segments = Array.isArray(wire.segments)
    ? wire.segments
        .map(parseSegment)
        .filter((segment): segment is TopologySegmentView => segment !== null)
    : [];

  return {
    datasetId: readString(wire.datasetId),
    nodes,
    segments,
    // The counts Studio shows are what it actually holds, not what the server
    // claimed: a response whose `meta` disagrees with its arrays is reported
    // as the arrays, because those are what is on the screen.
    segmentsReturned: segments.length,
    nodesReturned: nodes.length,
    limit: readFiniteNumber(wire.meta?.limit),
    truncated: wire.meta?.truncated === true,
    diagnostics: parseDiagnostics(wire.meta?.diagnostics),
  };
}

/** Whether a segment has enough readable geometry to be drawn. */
export function isDrawableSegment(segment: TopologySegmentView): boolean {
  return segment.coordinates.length >= 2;
}

/** Whether a node has enough readable geometry to be drawn. */
export function isDrawableNode(node: TopologyNodeView): boolean {
  return node.coordinate !== null;
}

/** Indexes a graph's nodes by id, for the inspector. */
export function indexNodes(graph: TopologyGraph): ReadonlyMap<string, TopologyNodeView> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

/** Indexes a graph's segments by id, for the inspector. */
export function indexSegments(graph: TopologyGraph): ReadonlyMap<string, TopologySegmentView> {
  return new Map(graph.segments.map((segment) => [segment.id, segment]));
}
