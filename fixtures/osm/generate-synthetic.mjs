#!/usr/bin/env node
// Generates the SYNTHETIC Seyra test fixture (OSM XML) and its expectation manifest.
//
// Every object is fictional, tagged seyra:fixture=synthetic and placed near Null Island
// (0°E, 0°N, open ocean) so it can never be mistaken for real Iranian roads or addresses.
// Usage: node fixtures/osm/generate-synthetic.mjs [outDir]
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const TS = '2026-10-01T00:00:00Z';
const FIXTURE = { 'seyra:fixture': 'synthetic' };

const nodes = new Map(); // id -> {lon, lat, tags}
const ways = []; // {id, refs, tags}
const relations = []; // {id, members, tags}
const expect = { layers: {}, routing: {}, search: [], uncatalogued: [] };
const addExpect = (layer, ref) => (expect.layers[layer] ??= []).push(ref);

let nextNode = 1000;
let nextWay = 5000;
let nextRel = 9000;
const node = (lon, lat, tags = {}) => {
  const id = nextNode++;
  nodes.set(id, { lon: +lon.toFixed(7), lat: +lat.toFixed(7), tags: { ...tags } });
  return id;
};
const way = (refs, tags) => {
  const id = nextWay++;
  ways.push({ id, refs, tags: { ...FIXTURE, ...tags } });
  return id;
};
const rel = (members, tags) => {
  const id = nextRel++;
  relations.push({ id, members, tags: { ...FIXTURE, ...tags } });
  return id;
};

// ------------------------------------------------------------------------------------------
// Road grid: columns i = 0..8 (lon), rows j = 0..6 (lat), spacing 0.005° (~556 m)
// ------------------------------------------------------------------------------------------
const LON0 = 0.01;
const LAT0 = 0.01;
const STEP = 0.005;
const g = [];
for (let i = 0; i <= 8; i++) {
  g[i] = [];
  for (let j = 0; j <= 6; j++) g[i][j] = node(LON0 + i * STEP, LAT0 + j * STEP);
}
const row = (j, i0, i1) => Array.from({ length: i1 - i0 + 1 }, (_, k) => g[i0 + k][j]);
const col = (i, j0, j1) => Array.from({ length: j1 - j0 + 1 }, (_, k) => g[i][j0 + k]);

// Motorway on row 0: fastest for cars, forbidden for motorcycles (motorcycle=no) and pedestrians.
const motorway = way(row(0, 0, 8), {
  highway: 'motorway', oneway: 'no', motorcycle: 'no', maxspeed: '120', ref: 'SYN-1',
  name: 'آزادراه آزمایشی ۱', 'name:fa': 'آزادراه آزمایشی ۱', 'name:en': 'Synthetic Motorway 1',
});
addExpect('transport', { type: 'w', id: motorway, highway: 'motorway' });
// Slow parallel tertiary road on row 1: the motorcycle alternative.
const tertiary = way(row(1, 0, 8), { highway: 'tertiary', maxspeed: '30', name: 'جاده کناری آزمایشی', 'name:en': 'Synthetic Side Road' });
addExpect('transport', { type: 'w', id: tertiary, highway: 'tertiary' });
// Connect row 0 and row 1 at both ends so cars can enter/leave the motorway.
way([g[0][0], g[0][1]], { highway: 'tertiary', maxspeed: '30' });
way([g[8][0], g[8][1]], { highway: 'tertiary', maxspeed: '30' });
// Main street on row 2 with ARABIC Yeh/Kaf letters in its name (normalization fixture).
const mainStreet = way(row(2, 0, 8), {
  highway: 'primary', maxspeed: '50',
  name: 'خيابان اصلي آزمايشي', 'name:en': 'Synthetic Main Street',
});
addExpect('transport', { type: 'w', id: mainStreet, highway: 'primary' });
expect.search.push({ query: 'خیابان اصلی آزمایشی', lang: 'fa', expect_osm: `W${mainStreet}`, note: 'Persian Yeh/Kaf query must match Arabic-letter name' });
expect.search.push({ query: 'Synthetic Main Street', lang: 'en', expect_osm: `W${mainStreet}` });
// Columns 0..8 between rows 1..2 (residential connectors) with Persian-digit names.
const toFa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
for (let i = 0; i <= 8; i += 2) {
  way(col(i, 1, 2), { highway: 'residential', name: `کوچه آزمایشی ${toFa(i + 1)}`, 'name:en': `Synthetic Alley ${i + 1}` });
}
// Rows 3..6 residential grid.
for (let j = 3; j <= 6; j++) {
  const name = j === 5 ? 'خیابان‌ شمالی‌ آزمایشی' : `خیابان آزمایشی ${toFa(j)}`;
  const id = way(row(j, 0, 8), { highway: 'residential', name, 'name:en': `Synthetic Row ${j}` });
  if (j === 5) expect.search.push({ query: 'خیابان شمالی آزمایشی', lang: 'fa', expect_osm: `W${id}`, note: 'ZWNJ in data, space in query' });
  if (j === 3) expect.search.push({ query: 'خیابان آزمایشی 3', lang: 'fa', expect_osm: `W${id}`, note: 'ASCII digit query, Persian digit data' });
}
for (const i of [0, 2, 6, 8]) way(col(i, 2, 6), { highway: 'residential', name: `خیابان عمودی آزمایشی ${toFa(i)}`, 'name:en': `Synthetic Column ${i}` });
// Column 4: ONE-WAY northbound (asymmetric proximity/routing fixture).
const oneway = way(col(4, 2, 6), { highway: 'residential', oneway: 'yes', name: 'یک‌طرفه آزمایشی', 'name:en': 'Synthetic One-way North' });
expect.routing.oneway = { way: oneway, from: [LON0 + 4 * STEP, LAT0 + 2 * STEP], to: [LON0 + 4 * STEP, LAT0 + 6 * STEP] };
// Pedestrian-only diagonal footway shortcut between (2,3) and (6,6).
const foot1 = node(LON0 + 3 * STEP, LAT0 + 4 * STEP);
const foot2 = node(LON0 + 5 * STEP, LAT0 + 5 * STEP);
const footway = way([g[2][3], foot1, foot2, g[6][6]], { highway: 'footway', name: 'پیاده‌روی آزمایشی', 'name:en': 'Synthetic Footpath' });
addExpect('transport', { type: 'w', id: footway, highway: 'footway' });
expect.routing.footway = { way: footway, from: [LON0 + 2 * STEP, LAT0 + 3 * STEP], to: [LON0 + 6 * STEP, LAT0 + 6 * STEP] };
// motor_vehicle=no service lane on column 1 rows 3..4 (walkable, not drivable).
const nomotor = way(col(1, 3, 4), { highway: 'service', motor_vehicle: 'no', name: 'کوچه بدون خودرو آزمایشی', 'name:en': 'Synthetic No-motor Lane' });
expect.routing.motor_vehicle_no = { way: nomotor };
// Rail line north of the grid.
const r1 = node(LON0, LAT0 + 6.6 * STEP);
const r2 = node(LON0 + 8 * STEP, LAT0 + 6.6 * STEP);
const rail = way([r1, r2], { railway: 'rail', name: 'راه‌آهن آزمایشی', 'name:en': 'Synthetic Railway' });
addExpect('transport', { type: 'w', id: rail, railway: 'rail' });

// Disconnected island network (unreachable from the grid).
const isl = [node(0.08, 0.08), node(0.085, 0.08), node(0.085, 0.085)];
const island = way(isl, { highway: 'residential', name: 'جزیره آزمایشی', 'name:en': 'Synthetic Island Road' });
expect.routing.island = { way: island, point: [0.085, 0.08] };

// ------------------------------------------------------------------------------------------
// Water, waterways, land cover, buildings
// ------------------------------------------------------------------------------------------
const ring = (lon, lat, w, h) => {
  const a = node(lon, lat), b = node(lon + w, lat), c = node(lon + w, lat + h), d = node(lon, lat + h);
  return [a, b, c, d, a];
};
const lake = way(ring(0.052, 0.012, 0.006, 0.004), { natural: 'water', water: 'lake', name: 'دریاچه آزمایشی', 'name:en': 'Synthetic Lake' });
addExpect('water', { type: 'w', id: lake, class: 'water' });
const river = way([node(0.0, 0.005), node(0.03, 0.006), node(0.06, 0.0065)], { waterway: 'river', name: 'رود آزمایشی', 'name:en': 'Synthetic River' });
addExpect('waterways', { type: 'w', id: river, waterway: 'river' });
const stream = way([node(0.02, 0.05), node(0.025, 0.045)], { waterway: 'stream', name: 'نهر آزمایشی' });
addExpect('waterways', { type: 'w', id: stream, waterway: 'stream' });
const canal = way([node(0.0, 0.0075), node(0.05, 0.0075)], { waterway: 'canal', name: 'کانال آزمایشی', 'name:en': 'Synthetic Canal' });
addExpect('waterways', { type: 'w', id: canal, waterway: 'canal' });
const resid = way(ring(0.011, 0.026, 0.008, 0.008), { landuse: 'residential' });
addExpect('landcover', { type: 'w', id: resid, class: 'landuse', subclass: 'residential' });
const wood = way(ring(0.04, 0.026, 0.006, 0.006), { natural: 'wood', name: 'جنگل آزمایشی' });
addExpect('landcover', { type: 'w', id: wood, class: 'natural', subclass: 'wood' });
const park = way(ring(0.026, 0.031, 0.003, 0.003), { leisure: 'park', name: 'پارک لاله آزمایشی', 'name:en': 'Synthetic Tulip Park' });
addExpect('landcover', { type: 'w', id: park, class: 'leisure', subclass: 'park' });
addExpect('pois', { type: 'w', id: park, key: 'leisure', value: 'park' });

const building = (lon, lat, tags) => way(ring(lon, lat, 0.0004, 0.0003), { building: 'yes', ...tags });
const b1 = building(0.0125, 0.0205, { 'addr:street': 'خيابان اصلي آزمايشي', 'addr:housenumber': '۱۲' });
const b2 = building(0.0185, 0.0205, { 'addr:street': 'خيابان اصلي آزمايشي', 'addr:housenumber': '14' });
addExpect('buildings', { type: 'w', id: b1 });
addExpect('buildings', { type: 'w', id: b2 });
expect.search.push({ query: 'خیابان اصلی آزمایشی 12', lang: 'fa', expect_osm: `W${b1}`, note: 'housenumber with Persian digits in data' });
// Multipolygon building with an inner courtyard.
const outer = way(ring(0.03, 0.0215, 0.001, 0.001), {});
const inner = way(ring(0.0303, 0.0218, 0.0004, 0.0004), {});
const mpBuilding = rel([{ type: 'way', ref: outer, role: 'outer' }, { type: 'way', ref: inner, role: 'inner' }], {
  type: 'multipolygon', building: 'yes', name: 'ساختمان حیاط‌دار آزمایشی', 'name:en': 'Synthetic Courtyard Building',
});
addExpect('buildings', { type: 'r', id: mpBuilding, multipolygon: true });

// ------------------------------------------------------------------------------------------
// POIs (nodes unless noted)
// ------------------------------------------------------------------------------------------
const poi = (lon, lat, tags, layerRef = true) => {
  const id = node(lon, lat, { ...FIXTURE, ...tags });
  const key = Object.keys(tags).find((k) => ['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic', 'emergency', 'public_transport'].includes(k));
  if (layerRef && key) addExpect('pois', { type: 'n', id, key, value: tags[key] });
  return id;
};
const P = (i, j, di = 0.0008, dj = 0.0006) => [LON0 + i * STEP + di, LAT0 + j * STEP + dj];
const hosp = poi(...P(1, 2), { amenity: 'hospital', name: 'بیمارستان آزمایشی', 'name:en': 'Synthetic Hospital' });
const pharm = poi(...P(3, 2), { amenity: 'pharmacy', name: 'داروخانه كوثر آزمايشي', 'name:en': 'Synthetic Kowsar Pharmacy' });
expect.search.push({ query: 'داروخانه کوثر', lang: 'fa', expect_osm: `N${pharm}`, note: 'Persian Kaf query vs Arabic Kaf data' });
expect.search.push({ query: 'Kowsar', lang: 'en', expect_osm: `N${pharm}` });
poi(...P(5, 2), { amenity: 'police', name: 'کلانتری آزمایشی', 'name:en': 'Synthetic Police Station' });
poi(...P(7, 2), { amenity: 'fire_station', name: 'آتش‌نشانی آزمایشی', 'name:en': 'Synthetic Fire Station' });
poi(...P(2, 1), { amenity: 'fuel', name: 'جایگاه سوخت آزمایشی', 'name:en': 'Synthetic Fuel' });
const lot = way(ring(...P(6, 1), 0.0005, 0.0004), { amenity: 'parking', name: 'پارکینگ آزمایشی' });
addExpect('pois', { type: 'w', id: lot, key: 'amenity', value: 'parking' });
const school = way(ring(...P(1, 4), 0.0008, 0.0005), { amenity: 'school', name: 'مدرسه آزمایشی', 'name:en': 'Synthetic School' });
addExpect('pois', { type: 'w', id: school, key: 'amenity', value: 'school' });
const rest = poi(...P(3, 4), { amenity: 'restaurant', name: 'رستوران لاله آزمایشی', 'name:en': 'Synthetic Laleh Restaurant' });
expect.search.push({ query: 'رستوران لاله', lang: 'fa', expect_osm: `N${rest}`, note: 'lam-alef' });
poi(...P(4, 4), { amenity: 'cafe', name: 'کافه آزمایشی' });
poi(...P(5, 4), { amenity: 'fast_food', name: 'فست‌فود آزمایشی' });
poi(...P(6, 3), { shop: 'bakery', name: 'نانوایی آزمایشی', 'name:en': 'Synthetic Bakery' });
const shop24 = poi(...P(7, 3), { shop: 'convenience', name: 'فروشگاه ۲۴ ساعته آزمایشی', 'name:en': 'Synthetic 24h Store' });
expect.search.push({ query: 'فروشگاه 24 ساعته', lang: 'fa', expect_osm: `N${shop24}`, note: 'digits' });
poi(...P(2, 5), { tourism: 'hotel', name: 'هتل آزمایشی', 'name:en': 'Synthetic Hotel' });
poi(...P(3, 5), { tourism: 'museum', name: 'موزه آزمایشی', 'name:en': 'Synthetic Museum' });
poi(...P(4, 5), { office: 'government', name: 'اداره آزمایشی' });
poi(...P(5, 5), { healthcare: 'clinic', name: 'درمانگاه آزمایشی' });
poi(...P(6, 5), { craft: 'carpenter', name: 'نجاری آزمایشی' });
const monument = poi(...P(7, 5), { historic: 'monument', name: 'بنای یادبود مُحَمَّد آزمایشی', 'name:en': 'Synthetic Monument' });
expect.search.push({ query: 'بنای یادبود محمد', lang: 'fa', expect_osm: `N${monument}`, note: 'diacritics in data' });
poi(...P(1, 6), { emergency: 'ambulance_station', name: 'پایگاه اورژانس آزمایشی' });
poi(...P(2, 6), { public_transport: 'station', name: 'ایستگاه آزمایشی', 'name:en': 'Synthetic Station' });
poi(...P(3, 6), { amenity: 'bench' });
const generic = poi(...P(4, 6), { amenity: 'synthetic_unlisted_value', name: 'مکان عمومی آزمایشی' });
expect.generic_icon_poi = { type: 'n', id: generic, value: 'synthetic_unlisted_value' };
// English-only and Persian-only names (label fallback fixtures).
const enOnly = poi(...P(5, 6), { amenity: 'library', 'name:en': 'Synthetic English-only Library' });
expect.label_fallback = { en_only: enOnly };
// Uncatalogued tagged objects: kept for inspection, not rendered as POIs.
const tower = node(0.015, 0.042, { ...FIXTURE, power: 'tower' });
const gate = node(0.016, 0.042, { ...FIXTURE, barrier: 'gate' });
expect.uncatalogued.push({ type: 'n', id: tower, key: 'power' }, { type: 'n', id: gate, key: 'barrier' });

// ------------------------------------------------------------------------------------------
// Places and administrative boundaries
// ------------------------------------------------------------------------------------------
const city = node(0.03, 0.027, { ...FIXTURE, place: 'city', name: 'شهر آزمایشی', 'name:fa': 'شهر آزمایشی', 'name:en': 'Synthetic City', population: '50000' });
addExpect('places', { type: 'n', id: city, place: 'city' });
expect.search.push({ query: 'Synthetic City', lang: 'en', expect_osm: `N${city}` });
const suburb = node(0.02, 0.035, { ...FIXTURE, place: 'suburb', name: 'محله آزمایشی', 'name:en': 'Synthetic Suburb' });
addExpect('places', { type: 'n', id: suburb, place: 'suburb' });
const village = node(0.08, 0.083, { ...FIXTURE, place: 'village', name: 'روستای جزیره آزمایشی' });
addExpect('places', { type: 'n', id: village, place: 'village' });
expect.label_fallback.fa_only_place = village;

const bRing = (lon0, lat0, lon1, lat1) => {
  const a = node(lon0, lat0), b = node(lon1, lat0), c = node(lon1, lat1), d = node(lon0, lat1);
  return way([a, b, c, d, a], {});
};
const provinceWay = bRing(0.0, 0.0, 0.095, 0.095);
const province = rel([{ type: 'way', ref: provinceWay, role: 'outer' }], {
  type: 'boundary', boundary: 'administrative', admin_level: '4', name: 'استان آزمایشی', 'name:en': 'Synthetic Province',
});
addExpect('boundaries', { type: 'r', id: province, admin_level: 4 });
const countyWay = bRing(0.005, 0.005, 0.06, 0.045);
const county = rel([{ type: 'way', ref: countyWay, role: 'outer' }], {
  type: 'boundary', boundary: 'administrative', admin_level: '6', name: 'شهرستان آزمایشی', 'name:en': 'Synthetic County',
});
addExpect('boundaries', { type: 'r', id: county, admin_level: 6 });

// ------------------------------------------------------------------------------------------
// Serialize (sorted ids; nodes, ways, relations order required by OSM tools)
// ------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tagXml = (tags) => Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `    <tag k="${esc(k)}" v="${esc(v)}"/>`).join('\n');
const meta = `version="1" timestamp="${TS}"`;
const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<osm version="0.6" generator="seyra synthetic fixture generator v1">',
  '  <!-- SYNTHETIC TEST FIXTURE. Fictional objects near 0,0 — not real geography. -->',
  '  <bounds minlat="0.0000000" minlon="0.0000000" maxlat="0.0950000" maxlon="0.0950000"/>',
];
for (const [id, n] of [...nodes.entries()].sort((a, b) => a[0] - b[0])) {
  const t = n.tags;
  if (Object.keys(t).length === 0) lines.push(`  <node id="${id}" ${meta} lat="${n.lat.toFixed(7)}" lon="${n.lon.toFixed(7)}"/>`);
  else lines.push(`  <node id="${id}" ${meta} lat="${n.lat.toFixed(7)}" lon="${n.lon.toFixed(7)}">`, tagXml(t), '  </node>');
}
for (const w of ways) {
  lines.push(`  <way id="${w.id}" ${meta}>`, ...w.refs.map((r) => `    <nd ref="${r}"/>`), tagXml(w.tags), '  </way>');
}
for (const r of relations) {
  lines.push(`  <relation id="${r.id}" ${meta}>`, ...r.members.map((m) => `    <member type="${m.type}" ref="${m.ref}" role="${m.role}"/>`), tagXml(r.tags), '  </relation>');
}
lines.push('</osm>', '');
writeFileSync(join(outDir, 'synthetic-v1.osm'), lines.join('\n'));
expect.counts = { nodes: nodes.size, ways: ways.length, relations: relations.length };
expect.snapshot_timestamp = TS;
expect.notice = 'SYNTHETIC fixture expectations; not real geography.';
writeFileSync(join(outDir, 'synthetic-v1.expect.json'), `${JSON.stringify(expect, null, 2)}\n`);
console.log(`synthetic fixture: ${nodes.size} nodes, ${ways.length} ways, ${relations.length} relations`);
