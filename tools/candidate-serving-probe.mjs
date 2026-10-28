// A trusted lab observer. It may stop only the experimental builder on the first serving error.
import {readFile,writeFile,statfs} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {execute} from '../apps/ingest/dist/process.js';
import {secretFile} from '../apps/ingest/dist/config.js';
const[configPath,output]=process.argv.slice(2);if(!configPath||!output)throw Error('probe config and output required');
const config=JSON.parse(await secretFile(configPath));if(!/^[0-9a-f]{64}$/.test(config.jobId))throw Error('invalid managed job');
const uri=new URL(config.endpoint);if(uri.protocol!=='http:'||!/^\d+\.\d+\.\d+\.\d+$/.test(uri.hostname)||uri.port!=='3000')throw Error('probe requires the inspected private Martin address');
const pool=new pg.Pool({connectionString:await secretFile(config.controlDsnFile),connectionTimeoutMillis:5000,max:1,statement_timeout:5000});
const digest=b=>createHash('sha256').update(b).digest('hex'),startedAt=new Date().toISOString(),started=performance.now();
const samples=[],resources=[],baselines=new Map();let index=0,consecutive=0,stopped=false,terminal=null,lastMetrics=-Infinity;
const sites={tehran:[51.389,35.6892],mashhad:[59.6062,36.2605],shiraz:[52.5311,29.5918],tabriz:[46.2919,38.0962],ahvaz:[48.6692,31.3183],rural:[58.5,32.4]};
const tiles=Object.entries(sites).flatMap(([site,[lon,lat]])=>[6,10,14,16].map(z=>{const n=2**z;return {site,z,x:Math.floor((lon+180)/360*n),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n)};}));
const before=await execute('docker',['inspect','atlas-lab-db-1','atlas-lab-martin-1','atlas-lab-pgtileserv-1'],{maxOutput:65536});
if(before.code!==0)throw Error('baseline inspection failed');
const identities=JSON.parse(before.stdout.toString()).map(r=>({name:r.Name.slice(1),id:r.Id,started_at:r.State.StartedAt}));
try{
  while(performance.now()-started<2*3600_000){
    const t=tiles[index++%tiles.length],key=`${t.z}/${t.x}/${t.y}`,begin=performance.now();let row;
    try{
      const response=await fetch(config.endpoint+'/basemap/'+key,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(5000)});
      const parts=[];let size=0;if(response.body)for await(const b of response.body){size+=b.length;if(size>32*1024*1024)throw Error('oversized tile');parts.push(b);}
      const hash=digest(Buffer.concat(parts));if(!baselines.has(key))baselines.set(key,hash);
      row={...t,status:response.status,bytes:size,ms:Math.round((performance.now()-begin)*1000)/1000,sha256:hash,bytes_match_first_sample:baselines.get(key)===hash};
    }catch{row={...t,status:0,bytes:0,ms:Math.round((performance.now()-begin)*1000)/1000};}
    samples.push(row);consecutive=[200,204].includes(row.status)?0:consecutive+1;
    if(consecutive>=1&&!stopped){
      const stop=await execute('systemctl',['--user','stop','atlas-candidate-worker.service'],{timeoutMs:55000,maxOutput:65536});
      stopped=stop.code===0;process.stderr.write(JSON.stringify({event:'serving_guard_stopped_experimental_builder',succeeded:stopped})+'\n');
    }
    if(performance.now()-lastMetrics>=15000){
      lastMetrics=performance.now();const free=await statfs(config.root,{bigint:true});
      const memory=await readFile('/proc/meminfo','utf8');const available=Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]??0)*1024;
      const listed=await execute('docker',['ps','--filter',`label=atlas.candidate.job=${config.jobId}`,'--format','{{.Names}}'],{maxOutput:65536});
      const names=['atlas-lab-db-1','atlas-lab-martin-1','atlas-lab-pgtileserv-1',...(config.dataContainer?[config.dataContainer]:[]),...listed.stdout.toString().trim().split('\n').filter(Boolean)];
      const stats=await execute('docker',['stats','--no-stream','--format','{{json .}}',...names],{maxOutput:65536});
      const io=config.dataContainer?await execute('docker',['exec',config.dataContainer,'cat','/sys/fs/cgroup/io.stat'],{maxOutput:65536}):null;
      resources.push({at:new Date().toISOString(),elapsed_ms:Math.round(performance.now()-started),filesystem_available_bytes:Number(free.bavail*free.bsize),memory_available_bytes:available,data_io_stat:io?.code===0?io.stdout.toString().trim():null,
        docker:stats.code===0?stats.stdout.toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[],stats_ok:stats.code===0});
    }
    const rowState=(await pool.query('SELECT state,stage FROM atlas_control.candidate_jobs WHERE id=$1',[config.jobId])).rows[0];
    if(rowState&&['component_verified','review_required','failed'].includes(rowState.state)){terminal=rowState;break;}
    if(stopped){terminal=rowState??{state:'unknown'};break;}
    await new Promise(r=>setTimeout(r,1000));
  }
}finally{await pool.end();}
const after=await execute('docker',['inspect',...identities.map(r=>r.name)],{maxOutput:65536});
const current=after.code===0?JSON.parse(after.stdout.toString()):[];
const unchanged=identities.every(r=>current.some(x=>x.Id===r.id&&x.State.StartedAt===r.started_at));
const times=samples.map(r=>r.ms).sort((a,b)=>a-b),percentile=p=>times[Math.max(0,Math.ceil(times.length*p)-1)]??null;
const report={schema:'atlas.candidate-serving-probe/1',tool_sha256:digest(await readFile(new URL(import.meta.url))),node:process.versions.node,
  started_at:startedAt,ended_at:new Date().toISOString(),job_id:config.jobId,terminal,requests:samples.length,errors:samples.filter(r=>![200,204].includes(r.status)).length,
  byte_change_observations:samples.filter(r=>r.bytes_match_first_sample===false).length,latency_ms:{median:percentile(.5),p95:percentile(.95),max:times.at(-1)??null},
  old_containers:identities,old_container_ids_and_start_times_unchanged:unchanged,guard_stopped_experimental_builder:stopped,
  scope:'existing private laboratory Martin during candidate import and QA; not a public gateway, browser, publication, or capacity proof',
  resource_sampling:'approximately every 15 seconds; observed samples are not exact peaks',resources,samples};
await writeFile(output+'.partial',JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const {rename}=await import('node:fs/promises');await rename(output+'.partial',output);
console.log(JSON.stringify({requests:report.requests,errors:report.errors,terminal,old_containers_unchanged:unchanged,guard_stopped:stopped}));
