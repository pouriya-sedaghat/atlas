import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
import pg from 'pg';

const [output,roundText='4',concurrencyText='4']=process.argv.slice(2);
const rounds=Number(roundText),concurrency=Number(concurrencyText);
if (!output||!Number.isInteger(rounds)||rounds<1||rounds>100||!Number.isInteger(concurrency)||concurrency<1||concurrency>16)
  throw new Error('usage: benchmark-engines.mjs REPORT.json ROUNDS(1..100) CONCURRENCY(1..16)');
const settings=JSON.parse(readFileSync(new URL('../.lab-state/settings.json',import.meta.url),'utf8'));
const c=new pg.Client({host:'db',database:'atlas_lab',user:'atlas_admin',password:readFileSync('/run/secrets/db_password','utf8').trim(),connectionTimeoutMillis:5000});
await c.connect();
const versions=(await c.query("SELECT current_setting('server_version') AS postgres,postgis_lib_version() AS postgis,postgis_geos_version() AS geos")).rows[0];
await c.end();
const sites={tehran:[51.389,35.6892],mashhad:[59.6062,36.2605],shiraz:[52.5311,29.5918],
  tabriz:[46.2919,38.0962],ahvaz:[48.6692,31.3183],rural:[58.5,32.4]};
const paths=Object.entries(sites).flatMap(([site,[lon,lat]])=>[6,10,14,16].map(z=>{
  const n=2**z;
  return {site,z,x:Math.floor((lon+180)/360*n),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n)};
}));
const engines={martin:t=>`http://martin:3000/basemap/${t.z}/${t.x}/${t.y}`,
  pgtileserv:t=>`http://pgtileserv:7800/tiles.basemap/${t.z}/${t.x}/${t.y}.pbf`};
function request(engine,tile) {
  return new Promise(resolve=>{
    const started=performance.now();let settled=false;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve({engine,...tile,...result,ms:Number((performance.now()-started).toFixed(3))});};
    const req=http.get(engines[engine](tile),{agent:false,headers:{'Accept-Encoding':'identity'}},res=>{
      let bytes=0;const h=createHash('sha256');
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024)req.destroy(new Error('response_bound'));else h.update(chunk);});
      res.on('end',()=>finish({status:res.statusCode,bytes,sha256:h.digest('hex')}));
      res.on('error',()=>finish({error:'response_error'}));
    });
    const timer=setTimeout(()=>req.destroy(new Error('deadline')),15000);
    req.on('error',err=>finish({error:err.code??err.message}));
  });
}
async function batch(engine) {
  const rows=new Array(paths.length);let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(next<paths.length){const index=next++;rows[index]=await request(engine,paths[index]);}
  }));return rows;
}
const failed=r=>r.error||![200,204].includes(r.status);
const warmup=[];
for(const engine of Object.keys(engines))warmup.push(...await batch(engine));
if(warmup.some(failed))throw new Error('warm-up failed; no benchmark result was produced');
const rows=[];
for(let round=0;round<rounds;round++)for(const engine of round%2?Object.keys(engines).reverse():Object.keys(engines))
  rows.push(...(await batch(engine)).map(row=>({round:round+1,...row})));
function summarize(selected) {
  const times=selected.map(r=>r.ms).sort((a,b)=>a-b),mid=Math.floor(times.length/2);
  return {requests:selected.length,errors:selected.filter(failed).length,
    p50_ms:times.length%2?times[mid]:(times[mid-1]+times[mid])/2,
    p95_ms:times[Math.ceil(times.length*.95)-1],max_ms:times.at(-1)};
}
const summary=Object.fromEntries(Object.keys(engines).map(engine=>[engine,summarize(rows.filter(r=>r.engine===engine))]));
const by_zoom=Object.fromEntries(Object.keys(engines).map(engine=>[engine,Object.fromEntries([6,10,14,16].map(z=>[z,summarize(rows.filter(r=>r.engine===engine&&r.z===z))]))]));
const report={schema:'atlas.engine-comparison/1',source_sha256:settings.source_sha256,images:settings.images,versions,
  concurrency,rounds,warmup_requests:warmup.length,
  cache:'HTTP application caches disabled; all samples warmed through both engines; shared PostgreSQL buffers',
  http_client:'Node http, new connection per request, isolated Docker bridge, client limited to one CPU',
  summary,by_zoom,requests:rows,production_capacity_established:false};
writeFileSync(`${output}.partial`,JSON.stringify(report,null,2)+'\n');renameSync(`${output}.partial`,output);
console.log(JSON.stringify(summary));
if(Object.values(summary).some(s=>s.errors))process.exitCode=1;
