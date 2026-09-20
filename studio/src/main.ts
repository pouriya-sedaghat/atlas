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

import { AtlasApiError, fetchCurrentDataset, fetchFeatures, fetchLiveness } from './api/client.js';
import type { FeatureQueryRequest } from './api/client.js';
import type { AtlasFeature, AtlasFeatureCollection, Bbox, CurrentDataset } from './api/types.js';
import { EMPTY_COLLECTION, indexFeatures, toMapCollection } from './map/geojson.js';
import {
  FEATURE_KEY,
  ROAD_HIT_LAYER_ID,
  ROAD_HOVER_LAYER_ID,
  ROAD_SELECTED_LAYER_ID,
  ROAD_SOURCE_ID,
  featureFilter,
  roadLayers,
} from './map/roadLayers.js';
import { BLANK_STYLE } from './map/style.js';
import { InspectorPanel, type InspectorSelection } from './ui/inspector.js';
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

const statusBar = new StatusBar(requireElement('status-bar'));
const datasetPanel = new DatasetPanel(requireElement('dataset-panel'));
const warningsPanel = new WarningsPanel(requireElement('warnings-panel'));
const diagnosticsPanel = new DiagnosticsPanel(requireElement('diagnostics-panel'));
const inspectorPanel = new InspectorPanel(requireElement('inspector-panel'));
const banner = requireElement('banner');
const attribution = requireElement('attribution');
const debugToggle = requireElement<HTMLInputElement>('toggle-debug');

interface AppState {
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
}

const state: AppState = {
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

// -- rendering ------------------------------------------------------------

function renderStatus(): void {
  statusBar.render(state.connection, state.dataset, state.query);
}

function renderAll(): void {
  renderStatus();
  datasetPanel.render(state.dataset, state.connectionError);
  warningsPanel.render(state.dataset);
  diagnosticsPanel.render(state.query, state.viewport);
  inspectorPanel.render(state.selection);
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
  map.addSource(ROAD_SOURCE_ID, { type: 'geojson', data: state.mapData });
  for (const layer of roadLayers()) {
    map.addLayer(layer);
  }
  state.mapReady = true;
  applyHighlights();
  if (state.dataset?.status === 'ready') {
    requestViewport(true);
  }
});

map.on('moveend', () => {
  requestViewport(false);
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
  select(featureIdAt(map, event.point));
});

debugToggle.checked = import.meta.env.DEV;
debugToggle.addEventListener('change', () => {
  requestViewport(true);
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
  inspectorPanel.render(state.selection);
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
  inspectorPanel.render(state.selection);
  renderBanner();
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
}

if (import.meta.env.DEV) {
  // A debugging tool deserves a debugging handle. Dev builds only.
  (globalThis as unknown as { atlasStudio?: unknown }).atlasStudio = { map, state };
}

renderAll();
renderAttribution();
void connect();
