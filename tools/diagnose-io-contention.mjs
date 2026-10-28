// Bounded, read-only experiment on an already failed candidate. Does not import or adopt it.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import pg from 'pg';
import {loadConfig} from '../apps/builder/dist/config.js';
import {DataRuntime} from '../apps/builder/dist/data.js';
import {BuildQueue} from '../apps/builder/dist/queue.js';
import {observedLayerInserts} from '../apps/builder/dist/qa.js';
import {secretFile} from '../apps/ingest/dist/config.js';
import {execute} from '../apps/ingest/dist/process.js';
import {sha256} from '../apps/ingest/dist/contracts.js';
const [configPath,job,probePath,output]=process.argv.slice(2);
if(!configPath||!/^[a-f0-9]{64}$/.test(job??'')||!probePath||!output)throw Error('usage: diagnose-io-contention.mjs BUILD_CONFIG FAILED_JOB OLD_PROBE_CONFIG REPORT');
const config=await loadConfig(configPath),probe=JSON.parse(await secretFile(probePath));
if(probe.root!==config.root||probe.jobId!==job||probe.controlDsnFile!==config.controlDsnFile)throw Error('diagnostic binding mismatch');
const state=await execute('systemctl',['--user','show','atlas-candidate-worker.service','-p','ActiveState','-p','MainPID'],{timeoutMs:5000,maxOutput:65536});
if(state.code!==0||!state.stdout.toString().includes('ActiveState=inactive')||!state.stdout.toString().includes('MainPID=0'))throw Error('real builder must be stopped');
const pool=new pg.Pool({connectionString:await secretFile(config.controlDsnFile),connectionTimeoutMillis:5000,statement_timeout:5000});
let claim;
try{
 const row=(await pool.query(`SELECT j.*,a.token,a.database_name,a.owner_role,a.import_role,a.qa_role,a.tile_role,a.data_target FROM atlas_control.candidate_jobs j
   JOIN atlas_control.candidate_attempts a ON a.job_id=j.id WHERE j.id=$1 AND j.state='failed' AND j.pipeline_sha256=$2 ORDER BY a.ordinal DESC LIMIT 1`,[job,config.expectedPipelineSha256])).rows[0];
 if(!row||!row.data_target)throw Error('failed bound candidate required');claim=row;
}finally{await pool.end();}
const runtime=new DataRuntime(config,claim,new BuildQueue(pool));await runtime.assertOwned();const profile=await runtime.verifyDataProfile();
const inspected=await execute('docker',['inspect','atlas-lab-db-1','atlas-lab-martin-1','atlas-lab-pgtileserv-1',config.dataContainer],{maxOutput:65536});if(inspected.code!==0)throw Error('container inventory failed');
const containers=JSON.parse(inspected.stdout.toString()),original=containers.slice(0,3).map(r=>({name:r.Name.slice(1),id:r.Id,started_at:r.State.StartedAt}));
const martin=containers.find(r=>r.Name==='/atlas-lab-martin-1'),endpoint='http://'+martin.NetworkSettings.Networks[config.network].IPAddress+':3000';
if(endpoint!==probe.endpoint)throw Error('old-serving endpoint changed');
const data=containers.at(-1),relative=(await readFile('/proc/'+data.State.Pid+'/cgroup','utf8')).trim().split('\n').find(s=>s.startsWith('0::'))?.slice(3);
if(!relative||relative.includes('..')||!relative.endsWith('docker-'+data.Id+'.scope'))throw Error('unexpected data cgroup');
const cg='/sys/fs/cgroup'+relative,devices=new Set(config.dataLimits.devices.map(d=>d.majorMinor));
const qa=new pg.Client({connectionString:await secretFile(join(config.root,'attempts',claim.token,'qa.dsn')),connectionTimeoutMillis:5000,statement_timeout:20000,application_name:'atlas-io-diagnostic'});qa.on('error',()=>{});await qa.connect();
await qa.query('SET default_transaction_read_only=on');
const identity=(await qa.query('SELECT * FROM atlas_build.identity WHERE singleton')).rows[0];if(identity.build_id!==job||identity.token!==claim.token)throw Error('data identity changed');
const sites={tehran:[51.389,35.6892],mashhad:[59.6062,36.2605],shiraz:[52.5311,29.5918],tabriz:[46.2919,38.0962],ahvaz:[48.6692,31.3183],rural:[58.5,32.4]};
const cases=Object.entries(sites).flatMap(([site,[lon,lat]])=>[6,10,14,16].map(z=>({site,z,x:Math.floor((lon+180)/360*2**z),y:Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**z)})));
const resources=[],samples=[],baselines=new Map(),stages=[],started=new Date().toISOString();let phase='baseline',finished=false,abort=false,workload={result:'not_started'};
const delay=monitorEventLoopDelay({resolution:20});delay.enable();
const pause=async ms=>{for(let i=0;i<ms/100&&!abort;i++)await new Promise(r=>setTimeout(r,100));};
const enter=name=>{phase=name;stages.push({phase,at:new Date().toISOString()});console.log(JSON.stringify({phase}));};
const observer=(async()=>{let n=0;while(!finished&&!abort){const t=cases[n++%cases.length],key=`${t.z}/${t.x}/${t.y}`,start=performance.now(),samplePhase=phase;let row;
 try{
  const response=await fetch(endpoint+'/basemap/'+key,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(5000)}),chunks=[];let length=0;
  if(response.body)for await(const b of response.body){length+=b.length;if(length>32*1024*1024)throw Error('response bound exceeded');chunks.push(b);}
  const hash=sha256(Buffer.concat(chunks));if(!baselines.has(key))baselines.set(key,hash);
  row={...t,phase:samplePhase,completed_phase:phase,status:response.status,sha256:hash,bytes:length,matches_first_observation:baselines.get(key)===hash};
 }catch(error){row={...t,phase:samplePhase,completed_phase:phase,status:0,error:error.name};}
 row.ms=Math.round((performance.now()-start)*1000)/1000;samples.push(row);
 if(![200,204].includes(row.status)||row.matches_first_observation===false){abort=true;await qa.end().catch(()=>{});break;}
 await pause(1000);
}})();
const metrics=(async()=>{while(!finished&&!abort){try{
 const [io,hostPressure,dataPressure,disks,mem]=await Promise.all([readFile(cg+'/io.stat','utf8'),readFile('/proc/pressure/io','utf8'),readFile(cg+'/io.pressure','utf8'),readFile('/proc/diskstats','utf8'),readFile('/proc/meminfo','utf8')]);
 resources.push({at:new Date().toISOString(),phase,host_io_pressure:hostPressure.trim(),data_io_pressure:dataPressure.trim(),data_io_stat:io.trim(),diskstats:disks.split('\n').filter(line=>{const p=line.trim().split(/\s+/);return devices.has(p[0]+':'+p[1]);}),memory_available_bytes:Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1]??0)*1024});
 }catch(error){resources.push({at:new Date().toISOString(),phase,error:error.code??error.name});}await pause(2000);
}})();
try{
 enter('baseline');await pause(15000);
 if(!abort){enter('bounded_read');const start=performance.now();try{await qa.query('BEGIN READ ONLY');const counts=await observedLayerInserts(qa);await qa.query('ROLLBACK');workload={result:'completed',counts};}
 catch(error){workload={result:'sql_error',code:error.code??error.name};await qa.query('ROLLBACK').catch(()=>{});}workload.ms=Math.round((performance.now()-start)*1000)/1000;}
 enter('recovery');await pause(15000);
}finally{finished=true;await qa.end().catch(()=>{});await Promise.all([observer,metrics]);delay.disable();}
const after=await execute('docker',['inspect',...original.map(r=>r.name)],{timeoutMs:5000,maxOutput:65536});const current=after.code===0?JSON.parse(after.stdout.toString()):[];
const unchanged=original.every(r=>current.some(x=>x.Id===r.id&&x.State.StartedAt===r.started_at&&x.State.Running));
const summary=Object.fromEntries(['baseline','bounded_read','recovery'].map(phase=>{const group=samples.filter(s=>s.phase===phase),times=group.map(s=>s.ms).sort((a,b)=>a-b);return[phase,{requests:group.length,errors:group.filter(s=>![200,204].includes(s.status)).length,max_ms:times.at(-1)??null,p95_ms:times[Math.max(0,Math.ceil(times.length*.95)-1)]??null}];}));
const report={schema:'atlas.bounded-io-diagnostic/1',tool_sha256:sha256(await readFile(new URL(import.meta.url))),qa_compiled_sha256:sha256(await readFile(new URL('../apps/builder/dist/qa.js',import.meta.url))),
 source_failed_job:job,source_attempt:claim.token,source_pipeline:claim.pipeline_sha256,started_at:started,ended_at:new Date().toISOString(),data_profile:profile,
 workload:{sql:'single aggregate of all layer outcome counters',statement_timeout_ms:20000,read_only:true,...workload},stages,summary,
 requests:samples.length,errors:samples.filter(s=>![200,204].includes(s.status)).length,aborted_on_serving_failure:abort,original_serving_unchanged:unchanged,
 event_loop_delay_ms:{max:delay.max/1e6,p99:delay.percentile(99)/1e6},resources,samples,
 candidate_data_modified:false,full_import_repeated:false,production_acceptance_claim:false,
 interpretation:'One bounded sequential read on an already failed candidate. PSI includes deliberate cgroup throttling. Device counters are separate block layers, not additive physical-disk measurements. No concurrency/capacity or root-cause proof.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({recorded:true,requests:report.requests,errors:report.errors,workload:report.workload,summary}));
if(abort||!unchanged)process.exitCode=1;
