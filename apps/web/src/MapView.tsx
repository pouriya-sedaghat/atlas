import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// The worker is bundled locally as a hashed asset; no remote script is ever loaded.
maplibregl.setWorkerUrl(workerUrl);

export interface OverlayPoint {
  id: string;
  lon: number;
  lat: number;
  label: string;
  kind: 'stop' | 'search' | 'poi' | 'origin' | 'candidate' | 'reverse' | 'unreachable';
}
export interface OverlayRoute {
  rank: number;
  coordinates: [number, number][];
}
export interface Overlay {
  points: OverlayPoint[];
  routes: OverlayRoute[];
}

const KIND_COLOR: Record<OverlayPoint['kind'], string> = {
  stop: '#1f6feb',
  search: '#8e24aa',
  poi: '#ef6c00',
  origin: '#2e7d32',
  candidate: '#455a64',
  reverse: '#c2185b',
  unreachable: '#9e9e9e',
};

function addOverlayLayers(map: MlMap): void {
  if (!map.getSource('seyra-overlay-routes')) {
    map.addSource('seyra-overlay-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'seyra-overlay-route-alt',
      type: 'line',
      source: 'seyra-overlay-routes',
      filter: ['>', ['get', 'rank'], 0],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#7e57c2', 'line-width': 5, 'line-opacity': 0.6, 'line-dasharray': [2, 1] },
    });
    map.addLayer({
      id: 'seyra-overlay-route-main',
      type: 'line',
      source: 'seyra-overlay-routes',
      filter: ['==', ['get', 'rank'], 0],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1f6feb', 'line-width': 6, 'line-opacity': 0.85 },
    });
  }
  if (!map.getSource('seyra-overlay-points')) {
    map.addSource('seyra-overlay-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'seyra-overlay-point',
      type: 'circle',
      source: 'seyra-overlay-points',
      paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'seyra-overlay-label',
      type: 'symbol',
      source: 'seyra-overlay-points',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Vazirmatn Bold'],
        'text-size': 12,
        'text-offset': [0, -1.4],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
  }
}

function setOverlayData(map: MlMap, overlay: Overlay): void {
  const routes = map.getSource('seyra-overlay-routes') as GeoJSONSource | undefined;
  const points = map.getSource('seyra-overlay-points') as GeoJSONSource | undefined;
  routes?.setData({
    type: 'FeatureCollection',
    features: overlay.routes.map((r) => ({ type: 'Feature', properties: { rank: r.rank }, geometry: { type: 'LineString', coordinates: r.coordinates } })),
  });
  points?.setData({
    type: 'FeatureCollection',
    features: overlay.points.map((p) => ({
      type: 'Feature',
      properties: { id: p.id, label: p.label, color: KIND_COLOR[p.kind] },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  });
}

export interface MapViewProps {
  styleUrl: string | null;
  overlay: Overlay;
  onClick: (lonlat: { lon: number; lat: number }) => void;
  onMove: (bounds: [number, number, number, number], center: { lon: number; lat: number }) => void;
  flyTo: { lon: number; lat: number; zoom?: number; seq: number } | null;
  maxZoom: number;
}

export function MapView({ styleUrl, overlay, onClick, onMove, flyTo, maxZoom }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  useEffect(() => {
    if (!container.current || !styleUrl) return;
    if (mapRef.current) {
      mapRef.current.setStyle(styleUrl);
      return;
    }
    const map = new maplibregl.Map({
      container: container.current,
      style: styleUrl, // initial center/zoom come from the release style
      maxZoom,
      // Only the data attribution; no external logo/link controls.
      attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors (ODbL)' },
      maplibreLogo: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.on('style.load', () => {
      addOverlayLayers(map);
      setOverlayData(map, overlayRef.current);
    });
    map.on('click', (e: MapMouseEvent) => clickRef.current({ lon: Number(e.lngLat.lng.toFixed(6)), lat: Number(e.lngLat.lat.toFixed(6)) }));
    const reportMove = () => {
      const b = map.getBounds();
      const c = map.getCenter();
      moveRef.current([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], { lon: c.lng, lat: c.lat });
    };
    map.on('moveend', reportMove);
    map.on('load', reportMove);
    mapRef.current = map;
  }, [styleUrl, maxZoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) setOverlayData(map, overlay);
  }, [overlay]);

  useEffect(() => {
    if (flyTo && mapRef.current) mapRef.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? Math.max(mapRef.current.getZoom(), 15) });
  }, [flyTo]);

  useEffect(() => () => mapRef.current?.remove(), []);

  return <div ref={container} className="map" aria-label="map" />;
}
