/**
 * MapLibre style builder for catalog v1 (light/dark × fa/en).
 *
 * All resource URLs use BASE_TOKEN, which the Nginx proxy replaces with the request's own
 * scheme://host[:port], so web and mobile clients receive absolute internal URLs without any
 * external host. Every resource is scoped by dataset id: /maps/<dataset_id>/...
 */
export const BASE_TOKEN = '__SEYRA_BASE__';
export const FONT_REGULAR = 'Vazirmatn Regular';
export const FONT_BOLD = 'Vazirmatn Bold';
export const STYLE_VERSION = 'seyra-style-1.0.1';

export type Theme = 'light' | 'dark';
export type Lang = 'fa' | 'en';

type Expr = unknown[];
type Layer = Record<string, unknown>;

/** fa: name:fa → name → name:en ; en: name:en → name → name:fa (no invented translations). */
export function labelExpression(lang: Lang): Expr {
  return lang === 'fa'
    ? ['coalesce', ['get', 'name_fa'], ['get', 'name'], ['get', 'name_en']]
    : ['coalesce', ['get', 'name_en'], ['get', 'name'], ['get', 'name_fa']];
}

interface Palette {
  background: string;
  water: string;
  waterway: string;
  wood: string;
  park: string;
  grass: string;
  residential: string;
  landuse: string;
  building: string;
  buildingOutline: string;
  motorway: string;
  motorwayCasing: string;
  trunk: string;
  primary: string;
  secondary: string;
  minor: string;
  roadCasing: string;
  path: string;
  rail: string;
  boundary: string;
  text: string;
  textHalo: string;
  waterText: string;
  poiText: string;
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    background: '#f8f4f0', water: '#a8d5f2', waterway: '#7fb8e0', wood: '#c4e3bb', park: '#d6ebcb', grass: '#e1efd2',
    residential: '#ece7e0', landuse: '#e9e4dc', building: '#dcd3c9', buildingOutline: '#c4b9ac', motorway: '#f0a35e',
    motorwayCasing: '#c27a3a', trunk: '#f6bd73', primary: '#fcd98c', secondary: '#fff1ad', minor: '#ffffff',
    roadCasing: '#cbc3b8', path: '#9c7a55', rail: '#8a8a8a', boundary: '#9a6fb0', text: '#2f2f2f', textHalo: '#ffffff',
    waterText: '#2b6ea3', poiText: '#4a3f35',
  },
  dark: {
    background: '#191c21', water: '#1d3954', waterway: '#2c5a80', wood: '#1d3323', park: '#203726', grass: '#22332a',
    residential: '#24282e', landuse: '#22262b', building: '#2e333a', buildingOutline: '#3b414a', motorway: '#a8653a',
    motorwayCasing: '#6e3f20', trunk: '#8e6a3a', primary: '#7d6b3a', secondary: '#5f5a40', minor: '#454a52',
    roadCasing: '#2a2e34', path: '#9c8463', rail: '#7a7a7a', boundary: '#8f73a6', text: '#e6e4e0', textHalo: '#111316',
    waterText: '#86b6dc', poiText: '#d9d2c8',
  },
};

const ARABIC_RANGES = ['U+0600-06FF', 'U+0750-077F', 'U+08A0-08FF', 'U+FB50-FDFF', 'U+FE70-FEFF', 'U+200C-200F'];

/** POI icon names present in the sprite; anything else uses the generic fallback icon. */
export const POI_ICON_VALUES = [
  'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'police', 'fire_station', 'fuel', 'parking', 'school',
  'university', 'college', 'kindergarten', 'restaurant', 'fast_food', 'cafe', 'food_court', 'place_of_worship', 'mosque',
  'bank', 'atm', 'hotel', 'guest_house', 'hostel', 'museum', 'attraction', 'government', 'park', 'station', 'bus_station',
  'monument', 'memorial', 'castle', 'ambulance_station', 'library', 'post_office', 'townhall', 'marketplace',
  'supermarket', 'bakery', 'convenience', 'mall',
] as const;

// MapLibre allows a zoom interpolation only at the top level of an expression, so the per-class
// widths are `match` expressions inside each zoom stop (not the other way round).
const ROAD_WIDTH_CLASSES: Array<[string[] | null, [number, number, number]]> = [
  [['motorway', 'trunk'], [1, 6, 24]],
  [['primary', 'secondary'], [0.8, 5, 20]],
  [['tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'], [0.6, 4, 16]],
  [['residential', 'unclassified', 'living_street', 'road', 'busway'], [0.4, 3, 12]],
  [null, [0.3, 1.5, 6]],
];
function roadWidth(extra = 0): Expr {
  const at = (stop: 0 | 1 | 2): Expr => {
    const m: Expr = ['match', ['get', 'type']];
    let fallback = 0;
    for (const [types, w] of ROAD_WIDTH_CLASSES) {
      if (types) m.push(types, w[stop] + extra);
      else fallback = w[stop] + extra;
    }
    m.push(fallback);
    return m;
  };
  return ['interpolate', ['exponential', 1.5], ['zoom'], 6, at(0), 14, at(1), 18, at(2)];
}

function roadLayers(p: Palette): Layer[] {
  const color: Expr = [
    'match', ['get', 'type'],
    ['motorway', 'motorway_link'], p.motorway,
    ['trunk', 'trunk_link'], p.trunk,
    ['primary', 'primary_link'], p.primary,
    ['secondary', 'secondary_link'], p.secondary,
    p.minor,
  ];
  const width = roadWidth();
  const isRoad: Expr = ['all', ['==', ['get', 'class'], 'highway'], ['!', ['in', ['get', 'type'], ['literal', ['footway', 'path', 'cycleway', 'steps', 'bridleway', 'pedestrian', 'track']]]]];
  return [
    {
      id: 'road-casing', type: 'line', source: 'seyra', 'source-layer': 'transport', filter: isRoad,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z_order'] },
      paint: {
        'line-color': ['match', ['get', 'type'], ['motorway', 'motorway_link'], p.motorwayCasing, p.roadCasing],
        'line-width': roadWidth(1.5),
        'line-opacity': ['case', ['==', ['get', 'tunnel'], true], 0.5, 1],
      },
    },
    {
      id: 'road', type: 'line', source: 'seyra', 'source-layer': 'transport', filter: isRoad,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z_order'] },
      paint: { 'line-color': color, 'line-width': width },
    },
    {
      id: 'path', type: 'line', source: 'seyra', 'source-layer': 'transport',
      filter: ['all', ['==', ['get', 'class'], 'highway'], ['in', ['get', 'type'], ['literal', ['footway', 'path', 'cycleway', 'steps', 'bridleway', 'pedestrian', 'track']]]],
      paint: { 'line-color': p.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 18, 2.5], 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'rail', type: 'line', source: 'seyra', 'source-layer': 'transport', filter: ['==', ['get', 'class'], 'railway'],
      paint: { 'line-color': p.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 16, 2.5], 'line-dasharray': [3, 2] },
    },
    {
      id: 'road-oneway', type: 'symbol', source: 'seyra', 'source-layer': 'transport', minzoom: 15,
      filter: ['all', ['==', ['get', 'class'], 'highway'], ['in', ['get', 'oneway'], ['literal', ['yes', '1', 'true']]]],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 120, 'icon-image': 'oneway', 'icon-size': 0.7, 'icon-rotation-alignment': 'map' },
    },
  ];
}

export interface StyleOptions {
  datasetId: string;
  theme: Theme;
  lang: Lang;
  bounds?: [number, number, number, number];
  center?: [number, number];
  zoom?: number;
}

export function buildStyle(o: StyleOptions): Record<string, unknown> {
  const p = PALETTES[o.theme];
  const base = `${BASE_TOKEN}/maps/${o.datasetId}`;
  const label = labelExpression(o.lang);
  const halo = { 'text-color': p.text, 'text-halo-color': p.textHalo, 'text-halo-width': 1.4 };
  const poiIcon: Expr = ['match', ['get', 'value'], [...POI_ICON_VALUES], ['concat', 'poi-', ['get', 'value']], 'poi-generic'];
  const layers: Layer[] = [
    { id: 'background', type: 'background', paint: { 'background-color': p.background } },
    {
      id: 'landcover', type: 'fill', source: 'seyra', 'source-layer': 'landcover',
      paint: {
        'fill-color': [
          'match', ['get', 'subclass'],
          ['wood', 'forest', 'scrub', 'orchard', 'vineyard', 'nature_reserve'], p.wood,
          ['park', 'garden', 'playground', 'recreation_ground', 'common', 'golf_course'], p.park,
          ['grass', 'grassland', 'meadow', 'heath', 'pitch', 'farmland', 'village_green'], p.grass,
          ['residential'], p.residential,
          p.landuse,
        ],
        'fill-opacity': 0.9,
      },
    },
    { id: 'water', type: 'fill', source: 'seyra', 'source-layer': 'water', paint: { 'fill-color': p.water } },
    {
      id: 'waterway', type: 'line', source: 'seyra', 'source-layer': 'waterways',
      paint: {
        'line-color': p.waterway,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          8, ['match', ['get', 'waterway'], ['river', 'canal'], 1, 0.5],
          12, ['match', ['get', 'waterway'], ['river', 'canal'], 3.5, 0.5],
          16, ['match', ['get', 'waterway'], ['river', 'canal'], 6, 2],
        ],
      },
    },
    {
      id: 'boundary', type: 'line', source: 'seyra', 'source-layer': 'boundaries',
      paint: {
        'line-color': p.boundary,
        'line-width': ['case', ['<=', ['coalesce', ['get', 'admin_level'], 99], 4], 1.6, 0.9],
        'line-dasharray': [4, 2],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'building', type: 'fill', source: 'seyra', 'source-layer': 'buildings', minzoom: 14,
      paint: { 'fill-color': p.building, 'fill-outline-color': p.buildingOutline },
    },
    ...roadLayers(p),
    {
      id: 'waterway-label', type: 'symbol', source: 'seyra', 'source-layer': 'waterways', minzoom: 12,
      layout: { 'symbol-placement': 'line', 'text-field': label, 'text-font': [FONT_REGULAR], 'text-size': 11 },
      paint: { ...halo, 'text-color': p.waterText },
    },
    {
      id: 'road-label', type: 'symbol', source: 'seyra', 'source-layer': 'transport', minzoom: 13,
      filter: ['==', ['get', 'class'], 'highway'],
      layout: { 'symbol-placement': 'line', 'text-field': label, 'text-font': [FONT_REGULAR], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 14], 'text-max-angle': 30 },
      paint: halo,
    },
    {
      id: 'poi', type: 'symbol', source: 'seyra', 'source-layer': 'pois',
      layout: {
        'icon-image': poiIcon,
        'icon-size': 1,
        'text-field': label,
        'text-font': [FONT_REGULAR],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
        'symbol-sort-key': ['case', ['get', 'major'], 0, 1],
      },
      paint: { ...halo, 'text-color': p.poiText },
    },
    {
      id: 'place-label', type: 'symbol', source: 'seyra', 'source-layer': 'places',
      layout: {
        'text-field': label,
        'text-font': ['match', ['get', 'place'], ['country', 'state', 'province', 'city'], ['literal', [FONT_BOLD]], ['literal', [FONT_REGULAR]]],
        'text-size': ['match', ['get', 'place'], ['country'], 16, ['state', 'province'], 15, ['city'], 15, ['town'], 13, ['village', 'suburb'], 12, 11],
        'text-max-width': 8,
        'symbol-sort-key': ['match', ['get', 'place'], ['country'], 0, ['state', 'province'], 1, ['city'], 2, ['town'], 3, 4],
      },
      paint: halo,
    },
  ];
  return {
    version: 8,
    name: `Seyra ${o.theme} ${o.lang}`,
    metadata: { 'seyra:dataset_id': o.datasetId, 'seyra:style_version': STYLE_VERSION, 'seyra:theme': o.theme, 'seyra:lang': o.lang },
    ...(o.center ? { center: o.center } : {}),
    ...(o.zoom !== undefined ? { zoom: o.zoom } : {}),
    sources: {
      seyra: {
        type: 'vector',
        tiles: [`${base}/tiles/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 16,
        ...(o.bounds ? { bounds: o.bounds } : {}),
        attribution: '© OpenStreetMap contributors (ODbL)',
      },
    },
    glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/sprites/${o.theme}`,
    'font-faces': {
      [FONT_REGULAR]: [{ url: `${base}/fonts/files/Vazirmatn-Regular.woff2`, 'unicode-range': ARABIC_RANGES }],
      [FONT_BOLD]: [{ url: `${base}/fonts/files/Vazirmatn-Bold.woff2`, 'unicode-range': ARABIC_RANGES }],
    },
    layers,
  };
}

/** TileJSON 3.0.0 for the dataset's vector tiles. */
export function buildTileJson(datasetId: string, bounds?: [number, number, number, number], center?: [number, number, number]): Record<string, unknown> {
  const layer = (id: string, fields: Record<string, string>) => ({ id, fields });
  const common = { feature_id: 'Number', osm_type: 'String', osm_id: 'Number', name: 'String', name_fa: 'String', name_en: 'String' };
  return {
    tilejson: '3.0.0',
    name: `seyra-${datasetId}`,
    version: '1.0.0',
    scheme: 'xyz',
    tiles: [`${BASE_TOKEN}/maps/${datasetId}/tiles/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 16,
    ...(bounds ? { bounds } : {}),
    ...(center ? { center } : {}),
    attribution: '© OpenStreetMap contributors (ODbL)',
    vector_layers: [
      layer('water', { ...common, class: 'String' }),
      layer('landcover', { ...common, class: 'String', subclass: 'String' }),
      layer('waterways', { ...common, waterway: 'String' }),
      layer('boundaries', { ...common, admin_level: 'Number' }),
      layer('transport', { ...common, class: 'String', type: 'String', ref: 'String', bridge: 'Boolean', tunnel: 'Boolean', layer: 'Number', oneway: 'String', access: 'String', motorcycle: 'String', motor_vehicle: 'String', foot: 'String', z_order: 'Number' }),
      layer('buildings', { ...common, building: 'String', housenumber: 'String' }),
      layer('places', { ...common, place: 'String', population: 'Number' }),
      layer('pois', { ...common, key: 'String', value: 'String', major: 'Boolean' }),
    ],
  };
}
