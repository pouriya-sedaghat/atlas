// Run inside the isolated lab network. Every endpoint and SQL function is fixed.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import pg from 'pg';

const [output,roundText='3'] = process.argv.slice(2);
if (!output) throw new Error('usage: verify-tiles.mjs REPORT.json');
const rounds=Number(roundText);
if (!Number.isInteger(rounds)||rounds<1||rounds>10) throw new Error('rounds must be in 1..10');
const options=process.env.ATLAS_TILE_CHECK_CONFIG_FILE?JSON.parse(readFileSync(process.env.ATLAS_TILE_CHECK_CONFIG_FILE,'utf8')):null;
const connection=options?{connectionString:readFileSync(options.connectionFile,'utf8').trim()}:{host:'db',database:'atlas_lab',user:'atlas_admin',password:readFileSync('/run/secrets/db_password','utf8').trim()};
if(options&&!/^atlas_candidate_[0-9a-f]{24}_[0-9a-f]{16}$/.test(new URL(connection.connectionString).pathname.slice(1)))throw new Error('candidate tile check requires a managed candidate database');
const client = new pg.Client({...connection,connectionTimeoutMillis:5000,statement_timeout:15000});
const allowed = new Set(options?.layers??['water','landcover','waterways','boundaries','transport','buildings','places','pois']);
const sites = options?.sites??{tehran:[51.389,35.6892],mashhad:[59.6062,36.2605],shiraz:[52.5311,29.5918],
  tabriz:[46.2919,38.0962],ahvaz:[48.6692,31.3183],rural:[58.5,32.4]};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function decode(bytes) {
  const tile = new VectorTile(new PbfReader(bytes));
  const layers = {};
  let features = 0;
  for (const name of Object.keys(tile.layers).sort()) {
    if (!allowed.has(name)) throw new Error(`unexpected layer ${name}`);
    const layer = tile.layers[name];
    if (layer.extent !== 4096 || layer.version !== 2) throw new Error('unexpected MVT extent/version');
    const records = [];
    for (let i=0;i<layer.length;i++) {
      const f = layer.feature(i);
      if (![1,2,3].includes(f.type)) throw new Error('invalid geometry type');
      if (f.id !== undefined && !Number.isSafeInteger(f.id)) throw new Error('feature ID precision loss');
      const geometry = f.loadGeometry().map(r=>r.map(p=>{
        if (!Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y)) throw new Error('invalid tile coordinate');
        return [p.x,p.y];
      }));
      const properties = Object.fromEntries(Object.entries(f.properties).sort(([a],[b])=>a.localeCompare(b,'en')));
      records.push(JSON.stringify([f.id ?? null,f.type,properties,geometry]));
    }
    records.sort(); features += records.length;
    layers[name] = records;
  }
  return {sha256:digest(JSON.stringify(layers)),features,layers:Object.fromEntries(Object.entries(layers).map(([k,v])=>[k,v.length]))};
}
async function fetchTile(url) {
  const response = await fetch(url,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(15000)});
  if (![200,204].includes(response.status)) throw new Error(`tile returned HTTP ${response.status}`);
  const chunks = []; let length=0;
  if (response.body) for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 32*1024*1024) throw new Error('tile exceeds bounded response');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const rows = [];
const warmup=[];
await client.connect();
try {
  if(options?.warmup){
    await client.query("SET statement_timeout='120s'");
    for(const [site,[lon,lat]]of Object.entries(sites))for(const z of [6,10,14,16]){
      const n=2**z,x=Math.floor((lon+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n),started=performance.now();
      await client.query('SELECT octet_length(tiles.basemap($1,$2,$3))',[z,x,y]);warmup.push({site,z,x,y,ms:Math.round((performance.now()-started)*1000)/1000});
    }
    await client.query("SET statement_timeout='15s'");
  }
  for (let round=1;round<=rounds;round++) for (const [site,[lon,lat]] of Object.entries(sites)) for (const z of [6,10,14,16]) {
    const n=2**z,x=Math.floor((lon+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
    const sources = {
      database:(await client.query('SELECT tiles.basemap($1,$2,$3) AS tile',[z,x,y])).rows[0].tile,
      martin:await fetchTile(`${options?.martin??'http://martin:3000'}/basemap/${z}/${x}/${y}`),
      ...(options?.baseline?{baseline:await fetchTile(`${options.baseline}/basemap/${z}/${x}/${y}`)}:{}),
      ...(!options?{pgtileserv:await fetchTile(`http://pgtileserv:7800/tiles.basemap/${z}/${x}/${y}.pbf`)}:{}),
    };
    const decoded = Object.fromEntries(Object.entries(sources).map(([engine,bytes])=>[engine,{...decode(bytes),bytes:bytes.length}]));
    const parity = new Set(Object.values(decoded).map(r=>r.sha256)).size === 1;
    rows.push({round,site,z,x,y,parity,decoded});
    process.stdout.write(`round ${round} ${site} z${z}: ${parity?'matched':'MISMATCH'}\n`);
  }
} finally { await client.end(); }
const report = {schema:'atlas.tile-parity/1',rounds,passed:rows.every(r=>r.parity)&&rows.some(r=>r.decoded.database.features>0),
  warmup,warmup_sql_timeout_ms:options?.warmup?120000:null,comparison_sql_timeout_ms:15000,http_timeout_ms:15000,
  comparison:'Decoded MVT features, properties and ordered geometry; layer/feature serialization order ignored',
  geographic_truth_verified:false,samples:rows};
writeFileSync(`${output}.partial`,JSON.stringify(report,null,2)+'\n');
renameSync(`${output}.partial`,output);
if (!report.passed) process.exitCode=1;
