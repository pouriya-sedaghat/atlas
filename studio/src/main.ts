/**
 * Atlas Studio.
 *
 * Startup: check the server is up, ask which dataset is current, fit the map to
 * its bounds, then query the viewport and render whatever comes back. Every
 * later pan or zoom repeats the last step, debounced and cancellable.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import type { FeatureCollection, LineString } from 'geojson';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type Point,
} from 'maplibre-gl';
// MapLibre resolves its worker relative to its own module URL. A bundler
// rewrites that URL, so the worker has to be handed over explicitly or the
// GeoJSON source silently never finishes loading.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import {
  AtlasApiError,
  fetchCurrentDataset,
  fetchFeatures,
  fetchLiveness,
  fetchTopology,
} from './api/client.js';
import type { FeatureQueryRequest, TopologyQueryRequest } from './api/client.js';
import type {
  AtlasFeature,
  AtlasFeatureCollection,
  Bbox,
  CurrentDataset,
  TopologyCollection,
} from './api/types.js';
import { ARROW_IMAGE_ID, ARROW_PIXEL_RATIO, createArrowImage } from './map/arrowImage.js';
import { applyAccessProfile } from './map/accessOverlay.js';
import { applyDirectionProfile } from './map/directionArrows.js';
import { EMPTY_COLLECTION, indexFeatures, toMapCollection } from './map/geojson.js';
import {
  ROAD_HIT_LAYER_ID,
  ROAD_HOVER_LAYER_ID,
  ROAD_SELECTED_LAYER_ID,
  featureFilter,
  roadLayers,
} from './map/roadLayers.js';
import { FEATURE_KEY, ROAD_SOURCE_ID } from './map/roadPrimitives.js';
import { BLANK_STYLE } from './map/style.js';
import {
  EMPTY_GRAPH,
  indexNodes,
  indexSegments,
  parseTopology,
  type TopologyGraph,
} from './map/topology.js';
import {
  TOPOLOGY_ID_KEY,
  TOPOLOGY_NODE_LAYER_ID,
  TOPOLOGY_NODE_SOURCE_ID,
  TOPOLOGY_SEGMENT_HIT_LAYER_ID,
  TOPOLOGY_SEGMENT_SOURCE_ID,
  installTopologyLayers,
  removeTopologyLayers,
  toNodeCollection,
  toSegmentCollection,
} from './map/topologyLayers.js';
import { DEFAULT_PROFILE, type TravelProfile } from './map/traversal.js';
import { InspectorPanel, type InspectorSelection } from './ui/inspector.js';
import { TopologyInspectorPanel, type TopologySelection } from './ui/topologyInspector.js';
import { TopologyLegend, TopologyStatusPanel, type TopologyState } from './ui/topologyPanel.js';
import { AccessLegend } from './ui/legend.js';
import { ProfileSelector } from './ui/profile.js';
import {
  DatasetPanel,
  DiagnosticsPanel,
  StatusBar,
  WarningsPanel,
  type ConnectionState,
  type QueryState,
} from './ui/panels.js';
import { formatNumber, requireElement } from './ui/dom.js';
import { bboxesEqual, normalizeViewportBbox } from './viewport/bbox.js';
import { ViewportQueryController } from './viewport/queryController.js';

const DATASET_POLL_MS = 1_000;
const DATASET_RETRY_MS = 5_000;
const CONNECT_RETRY_MS = 2_000;
const FEATURE_LIMIT = 2_000;

/// Well under the server's maximum of 5,000: a viewport with more topology
/// than this is not something a reader can take in anyway.
const TOPOLOGY_LIMIT = 2_000;

const statusBar = new StatusBar(requireElement('status-bar'));
const datasetPanel = new DatasetPanel(requireElement('dataset-panel'));
const warningsPanel = new WarningsPanel(requireElement('warnings-panel'));
const diagnosticsPanel = new DiagnosticsPanel(requireElement('diagnostics-panel'));
const inspectorPanel = new InspectorPanel(requireElement('inspector-panel'));
const profileSelector = new ProfileSelector(requireElement('profile-panel'), (profile) =>
  selectProfile(profile),
);
const accessLegend = new AccessLegend(requireElement('legend-panel'));
const banner = requireElement('banner');
const attribution = requireElement('attribution');
const debugToggle = requireElement<HTMLInputElement>('toggle-debug');
// A separate toggle from the diagnostics one on purpose. Topology is a
// different question, with its own request, its own cost and its own overlay,
// and overloading the diagnostics checkbox would mean a reader could not ask
// for one without paying for the other.
const topologyToggle = requireElement<HTMLInputElement>('toggle-topology');
const topologyStatusPanel = new TopologyStatusPanel(requireElement('topology-panel'));
const topologyLegend = new TopologyLegend(requireElement('topology-legend'));
const topologyInspectorPanel = new TopologyInspectorPanel(
  requireElement('topology-inspector-panel'),
);

interface AppState {
  profile: TravelProfile;
  connection: ConnectionState;
  connectionError: string | null;
  dataset: CurrentDataset | null;
  query: QueryState;
  viewport: Bbox | null;
  selectedId: string | null;
  selection: InspectorSelection | null;
  features: ReadonlyMap<string, AtlasFeature>;
  mapData: FeatureCollection<LineString>;
  mapReady: boolean;
  lastRequestedBbox: Bbox | null;
  lastTopologyBbox: Bbox | null;
  topologyEnabled: boolean;
  topology: TopologyGraph;
  topologyState: TopologyState;
  topologySelection: TopologySelection | null;
  topologyInstalled: boolean;
}

const state: AppState = {
  profile: DEFAULT_PROFILE,
  connection: 'connecting',
  connectionError: null,
  dataset: null,
  query: { kind: 'idle' },
  viewport: null,
  selectedId: null,
  selection: null,
  features: new Map(),
  mapData: EMPTY_COLLECTION,
  mapReady: false,
  lastRequestedBbox: null,
  lastTopologyBbox: null,
  topologyEnabled: false,
  topology: EMPTY_GRAPH,
  topologyState: { kind: 'off' },
  topologySelection: null,
  topologyInstalled: false,
};

setWorkerUrl(maplibreWorkerUrl);

const map = new MapLibreMap({
  container: 'map',
  style: BLANK_STYLE,
  center: [51.39, 35.69],
  zoom: 13,
  attributionControl: false,
});
map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');

const queryController = new ViewportQueryController({
  run: (request, signal) => fetchFeatures(request, signal),
  onLoading: () => {
    state.query = { kind: 'loading' };
    renderStatus();
  },
  onResult: (collection, request) => {
    applyCollection(collection, request);
  },
  onError: (error) => {
    state.query = { kind: 'failed', message: describeError(error) };
    renderStatus();
    diagnosticsPanel.render(state.query, state.viewport);
  },
  debounceMs: 220,
});

/**
 * The topology query's own controller.
 *
 * A separate instance from the feature controller, not a second mode of it.
 * The two have independent generations and independent in-flight requests, so
 * a topology answer is never discarded because the road query moved on, and a
 * topology failure never touches the road map. The lifecycle rules — debounce,
 * supersede, abort, ignore stale answers — are the same because it is the same
 * class.
 */
const topologyController = new ViewportQueryController<TopologyQueryRequest, TopologyCollection>({
  run: (request, signal) => fetchTopology(request, signal),
  onLoading: () => {
    state.topologyState = { kind: 'loading' };
    topologyStatusPanel.render(state.topologyState);
  },
  onResult: (payload) => {
    applyTopology(payload);
  },
  onError: (error) => {
    // The overlay reports the failure and the road map is left exactly as it
    // was: no source is cleared, no layer is removed, no feature is refetched.
    state.topologyState = { kind: 'failed', message: describeError(error) };
    topologyStatusPanel.render(state.topologyState);
  },
  debounceMs: 220,
});

// -- rendering ------------------------------------------------------------

function renderStatus(): void {
  statusBar.render(state.connection, state.dataset, state.query);
}

function renderAll(): void {
  renderStatus();
  datasetPanel.render(state.dataset, state.connectionError);
  warningsPanel.render(state.dataset);
  diagnosticsPanel.render(state.query, state.viewport);
  profileSelector.render(state.profile);
  // The legend describes the categories, which do not depend on the profile.
  accessLegend.render();
  inspectorPanel.render(state.selection, state.profile);
  topologyStatusPanel.render(state.topologyState);
  topologyLegend.render(state.topologyEnabled);
  topologyInspectorPanel.render(state.topologySelection, state.topologyEnabled);
}

function renderBanner(): void {
  if (state.query.kind === 'ready' && state.query.meta.truncated) {
    const { returned } = state.query.meta;
    banner.textContent = `Result truncated at ${formatNumber(returned)} roads — zoom in to see the rest`;
    banner.hidden = false;
    return;
  }
  banner.hidden = true;
}

function renderAttribution(): void {
  const text = state.dataset?.attribution?.text ?? '© OpenStreetMap contributors';
  const url = state.dataset?.attribution?.licenseUrl ?? 'https://www.openstreetmap.org/copyright';
  attribution.replaceChildren();
  attribution.append(document.createTextNode('Map data '));
  const link = document.createElement('a');
  link.textContent = text;
  // The URL arrives from the API; only http(s) links are ever made clickable.
  link.href = isSafeHttpUrl(url) ? url : 'https://www.openstreetmap.org/copyright';
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  attribution.append(link);
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof AtlasApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

// -- map wiring -----------------------------------------------------------

map.on('load', () => {
  // The arrow is generated here and now. Nothing is fetched: no sprite sheet,
  // no glyph range, no icon CDN.
  map.addImage(ARROW_IMAGE_ID, createArrowImage(), { pixelRatio: ARROW_PIXEL_RATIO });
  map.addSource(ROAD_SOURCE_ID, { type: 'geojson', data: state.mapData });
  for (const layer of roadLayers(state.profile)) {
    map.addLayer(layer);
  }
  state.mapReady = true;
  applyHighlights();
  if (state.dataset?.status === 'ready') {
    requestViewport(true);
  }
  // Topology installs nothing here. With the toggle off there is no topology
  // source, no topology layer and no topology request at all.
  if (state.topologyEnabled) {
    enableTopology();
  }
});

map.on('moveend', () => {
  requestViewport(false);
  requestTopologyViewport(false);
});

map.on('mousemove', (event) => {
  const id = featureIdAt(map, event.point);
  map.getCanvas().style.cursor = id ? 'pointer' : '';
  setHovered(id);
});

map.on('mouseout', () => {
  setHovered(null);
});

map.on('click', (event) => {
  // Both, always, in that order. Topology segments lie directly on top of the
  // roads they came from, so letting the overlay swallow a click would make
  // road selection impossible wherever topology is drawn — and road selection
  // is meant to be exactly what it was before topology existed. The two have
  // separate panels, so there is nothing to arbitrate: the road inspector
  // answers about the road and the topology inspector about the segment or
  // node, and a click that misses the overlay simply leaves that panel empty.
  select(featureIdAt(map, event.point));
  selectTopologyAt(event.point);
});

debugToggle.checked = import.meta.env.DEV;
debugToggle.addEventListener('change', () => {
  requestViewport(true);
});

// Off by default, in every build. Topology is opt-in.
topologyToggle.checked = false;
topologyToggle.addEventListener('change', () => {
  if (topologyToggle.checked) {
    enableTopology();
  } else {
    disableTopology();
  }
});

function featureIdAt(target: MapLibreMap, point: Point): string | null {
  if (!state.mapReady || !target.getLayer(ROAD_HIT_LAYER_ID)) {
    return null;
  }
  const [hit] = target.queryRenderedFeatures(point, { layers: [ROAD_HIT_LAYER_ID] });
  const properties = (hit?.properties ?? {}) as Record<string, unknown>;
  const id = properties[FEATURE_KEY];
  return typeof id === 'string' ? id : null;
}

let hoveredId: string | null = null;

function setHovered(id: string | null): void {
  if (hoveredId === id) {
    return;
  }
  hoveredId = id;
  applyHighlights();
}

function select(id: string | null): void {
  state.selectedId = id;
  updateSelection();
  applyHighlights();
  inspectorPanel.render(state.selection, state.profile);
}

/**
 * Switches travel profile.
 *
 * Everything this touches is already in the browser: the arrows are re-pointed
 * and the access overlays re-filtered from the flattened properties of the
 * features that were loaded, and the inspector relabels which profile is
 * active. There is deliberately no query here, no source update and no
 * geometry change, so hover, selection and the viewport diagnostics all
 * survive untouched — including the selected road, which stays selected
 * because nothing clears `state.selectedId`.
 *
 * The two map updates are independent calls on purpose. Direction and access
 * are separate facts drawn by separate layers, and neither switch reads the
 * other's properties.
 *
 * There is deliberately no third call for speed. No layer draws a speed limit,
 * because a colour scale would need thresholds and thresholds would imply that
 * a legal maximum is a travel speed. The speed facts are inspector-only, and
 * the inspector re-renders from the wire feature it already holds.
 *
 * There is no fourth call for topology either, and no topology request. A
 * profile is a question about who may travel and which way; topology is a
 * question about what is joined to what. Nothing about the graph changes when
 * the profile does, so the overlay is left exactly as it is — still drawn,
 * still selected, and not refetched.
 */
function selectProfile(profile: TravelProfile): void {
  if (state.profile === profile) {
    return;
  }
  state.profile = profile;
  profileSelector.render(profile);
  if (state.mapReady) {
    applyAccessProfile(map, profile);
    applyDirectionProfile(map, profile);
  }
  inspectorPanel.render(state.selection, state.profile);
}

function applyHighlights(): void {
  if (!state.mapReady || !map.getLayer(ROAD_HOVER_LAYER_ID)) {
    return;
  }
  map.setFilter(ROAD_HOVER_LAYER_ID, featureFilter(hoveredId));
  map.setFilter(ROAD_SELECTED_LAYER_ID, featureFilter(state.selectedId));
}

/**
 * Keeps the inspector stable across viewport refreshes: a selected road that
 * scrolls out of the queried area keeps its panel, flagged as out of view,
 * rather than vanishing.
 */
function updateSelection(): void {
  if (state.selectedId === null) {
    state.selection = null;
    return;
  }
  const feature = state.features.get(state.selectedId);
  if (feature) {
    state.selection = { feature, inCurrentViewport: true };
    return;
  }
  if (state.selection && state.selection.feature.id === state.selectedId) {
    state.selection = { feature: state.selection.feature, inCurrentViewport: false };
    return;
  }
  state.selection = null;
}

// -- querying -------------------------------------------------------------

function currentViewport(): Bbox {
  const bounds = map.getBounds();
  return normalizeViewportBbox(
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  );
}

function requestViewport(force: boolean): void {
  if (state.dataset?.status !== 'ready') {
    return;
  }
  const bbox = currentViewport();
  state.viewport = bbox;
  if (!force && state.lastRequestedBbox && bboxesEqual(state.lastRequestedBbox, bbox)) {
    diagnosticsPanel.render(state.query, state.viewport);
    return;
  }
  state.lastRequestedBbox = bbox;

  const request: FeatureQueryRequest = {
    bbox,
    kind: 'road',
    limit: FEATURE_LIMIT,
    ...(debugToggle.checked ? { include: ['source', 'diagnostics'] as const } : {}),
  };
  queryController.request(request);
  diagnosticsPanel.render(state.query, state.viewport);
}

function applyCollection(collection: AtlasFeatureCollection, request: FeatureQueryRequest): void {
  state.features = indexFeatures(collection);
  state.mapData = toMapCollection(collection);
  state.query = { kind: 'ready', meta: collection.atlas, request };

  if (state.mapReady) {
    const source = map.getSource<GeoJSONSource>(ROAD_SOURCE_ID);
    // setData resolves once the worker has re-parsed the data; Studio renders
    // on the map's own schedule and has nothing to do with the result.
    void source?.setData(state.mapData);
  }

  updateSelection();
  applyHighlights();
  renderStatus();
  diagnosticsPanel.render(state.query, state.viewport);
  inspectorPanel.render(state.selection, state.profile);
  renderBanner();
}

// -- topology -------------------------------------------------------------

/**
 * Turns the overlay on.
 *
 * Installs the layers over whatever is already drawn and asks for the current
 * viewport. It does not touch the road source, the road layers, the selection
 * or the viewport, so enabling topology cannot disturb the map underneath it
 * and cannot cause a feature request.
 */
function enableTopology(): void {
  state.topologyEnabled = true;
  topologyToggle.checked = true;
  topologyLegend.render(true);
  topologyInspectorPanel.render(state.topologySelection, true);
  if (state.mapReady) {
    state.topologyInstalled = installTopologyLayers(map, state.topology) || state.topologyInstalled;
  }
  requestTopologyViewport(true);
}

/**
 * Turns the overlay off.
 *
 * Cancels anything in flight and removes the overlay's own layers and
 * sources. Deliberately no feature request and no road source update: the
 * roads on the screen were already correct and are left alone.
 */
function disableTopology(): void {
  state.topologyEnabled = false;
  topologyToggle.checked = false;
  topologyController.cancel();
  if (state.mapReady) {
    removeTopologyLayers(map);
  }
  state.topologyInstalled = false;
  state.topology = EMPTY_GRAPH;
  state.topologySelection = null;
  state.topologyState = { kind: 'off' };
  topologyStatusPanel.render(state.topologyState);
  topologyLegend.render(false);
  topologyInspectorPanel.render(null, false);
}

/**
 * Clears whatever topology is on the screen without turning the overlay off.
 *
 * Used when the dataset is replaced: the old dataset's segments must not stay
 * drawn over the new dataset's roads even for the moment before the
 * replacement answers.
 */
function clearTopology(): void {
  state.topology = EMPTY_GRAPH;
  state.topologySelection = null;
  pushTopologyToMap();
  topologyInspectorPanel.render(null, state.topologyEnabled);
}

/** Asks for the topology of the current viewport, pinning the dataset. */
function requestTopologyViewport(force: boolean): void {
  // Every guard is a reason not to make a request. With the toggle off, or
  // before a dataset is ready, Studio issues no topology request at all.
  if (!state.topologyEnabled || state.dataset?.status !== 'ready') {
    if (state.topologyEnabled) {
      state.topologyState = { kind: 'idle' };
      topologyStatusPanel.render(state.topologyState);
    }
    return;
  }
  const bbox = currentViewport();
  if (!force && state.lastTopologyBbox && bboxesEqual(state.lastTopologyBbox, bbox)) {
    return;
  }
  state.lastTopologyBbox = bbox;

  const request: TopologyQueryRequest = {
    bbox,
    limit: TOPOLOGY_LIMIT,
    // The dataset is pinned so that a swap mid-pan is noticed rather than
    // drawn as one graph over another import's roads.
    ...(state.dataset.datasetId !== undefined ? { dataset: state.dataset.datasetId } : {}),
    ...(debugToggle.checked ? { include: ['diagnostics'] as const } : {}),
  };
  topologyController.request(request);
}

function applyTopology(payload: TopologyCollection): void {
  state.topology = parseTopology(payload);
  state.topologyState = { kind: 'ready', graph: state.topology };
  pushTopologyToMap();
  // A selected node or segment that is no longer in the viewport is dropped
  // rather than kept as a stale panel: unlike a road, a topology element the
  // response no longer carries may have had its degree change.
  refreshTopologySelection();
  topologyStatusPanel.render(state.topologyState);
  topologyInspectorPanel.render(state.topologySelection, state.topologyEnabled);
}

function pushTopologyToMap(): void {
  if (!state.mapReady || !state.topologyInstalled) {
    return;
  }
  const segments = map.getSource<GeoJSONSource>(TOPOLOGY_SEGMENT_SOURCE_ID);
  void segments?.setData(toSegmentCollection(state.topology));
  const nodes = map.getSource<GeoJSONSource>(TOPOLOGY_NODE_SOURCE_ID);
  void nodes?.setData(toNodeCollection(state.topology));
}

function refreshTopologySelection(): void {
  const selection = state.topologySelection;
  if (!selection) {
    return;
  }
  if (selection.kind === 'node') {
    const node = indexNodes(state.topology).get(selection.node.id);
    state.topologySelection = node ? { kind: 'node', node } : null;
    return;
  }
  const segment = indexSegments(state.topology).get(selection.segment.id);
  state.topologySelection = segment ? { kind: 'segment', segment } : null;
}

/**
 * Inspects whatever topology element is under the pointer.
 *
 * Nodes win over segments: at a junction the circle sits on top of every line
 * that converges on it, and the reader who clicked it meant the junction. A
 * click that hits neither clears the topology panel rather than leaving a
 * stale one, which is how the road inspector has always behaved.
 *
 * This never touches the road selection, the road source or the viewport.
 */
function selectTopologyAt(point: Point): void {
  if (!state.topologyEnabled || !state.mapReady || !state.topologyInstalled) {
    return;
  }
  const nodeId = topologyIdAt(TOPOLOGY_NODE_LAYER_ID, point);
  const node = nodeId === null ? undefined : indexNodes(state.topology).get(nodeId);
  if (node) {
    state.topologySelection = { kind: 'node', node };
    topologyInspectorPanel.render(state.topologySelection, true);
    return;
  }

  const segmentId = topologyIdAt(TOPOLOGY_SEGMENT_HIT_LAYER_ID, point);
  const segment = segmentId === null ? undefined : indexSegments(state.topology).get(segmentId);
  state.topologySelection = segment ? { kind: 'segment', segment } : null;
  topologyInspectorPanel.render(state.topologySelection, true);
}

function topologyIdAt(layerId: string, point: Point): string | null {
  if (!map.getLayer(layerId)) {
    return null;
  }
  const [hit] = map.queryRenderedFeatures(point, { layers: [layerId] });
  const properties = (hit?.properties ?? {}) as Record<string, unknown>;
  const id = properties[TOPOLOGY_ID_KEY];
  return typeof id === 'string' ? id : null;
}

// -- startup --------------------------------------------------------------

async function connect(): Promise<void> {
  state.connection = 'connecting';
  state.connectionError = null;
  renderAll();

  try {
    await fetchLiveness();
    state.connection = 'online';
  } catch (error) {
    state.connection = 'offline';
    state.connectionError = `Cannot reach the Atlas server (${describeError(error)}). Retrying…`;
    renderAll();
    window.setTimeout(() => void connect(), CONNECT_RETRY_MS);
    return;
  }

  renderAll();
  await refreshDataset();
}

async function refreshDataset(): Promise<void> {
  let dataset: CurrentDataset;
  try {
    dataset = await fetchCurrentDataset();
  } catch (error) {
    state.connection = 'offline';
    state.connectionError = `Cannot reach the Atlas server (${describeError(error)}). Retrying…`;
    renderAll();
    window.setTimeout(() => void connect(), CONNECT_RETRY_MS);
    return;
  }

  const previousId = state.dataset?.datasetId;
  state.dataset = dataset;
  state.connection = 'online';
  state.connectionError = null;
  renderAll();
  renderAttribution();

  if (dataset.status === 'loading') {
    window.setTimeout(() => void refreshDataset(), DATASET_POLL_MS);
    return;
  }
  if (dataset.status === 'failed') {
    window.setTimeout(() => void refreshDataset(), DATASET_RETRY_MS);
    return;
  }

  if (dataset.datasetId !== previousId) {
    select(null);
    // The replacement's roads are about to be drawn, so the old dataset's
    // topology must not stay on top of them. It is cleared before the
    // replacement is asked for, not after it answers.
    clearTopology();
    if (dataset.bounds) {
      const [west, south, east, north] = dataset.bounds;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 56, duration: 0, maxZoom: 17 },
      );
    }
  }
  requestViewport(true);
  queryController.flush();
  // Only when the overlay is on; `requestTopologyViewport` returns without a
  // request otherwise.
  requestTopologyViewport(true);
  topologyController.flush();
}

if (import.meta.env.DEV) {
  // A debugging tool deserves a debugging handle. Dev builds only.
  (globalThis as unknown as { atlasStudio?: unknown }).atlasStudio = { map, state };
}

renderAll();
renderAttribution();
void connect();
