// Read-only witness outside the VM, over a temporary SSH tunnel. Never grants admission.
import {readFile,writeFile,lstat,link,unlink} from 'node:fs/promises';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import {createServer} from 'node:net';import {createInterface} from 'node:readline';import {monitorEventLoopDelay} from 'node:perf_hooks';import assert from 'node:assert/strict';
import {classifyServingObservation} from '../serving-observation.mjs';
const [configFile,output]=process.argv.slice(2);if(!configFile||!output)throw Error('usage: observe-external.mjs PRIVATE_CONFIG REPORT');
for(const path of [output,output+'.partial']){try{await lstat(path);throw Error('report path already exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
const c=JSON.parse(await readFile(configFile,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const sourceHash=sha(await readFile(new URL(import.meta.url))),classifierHash=sha(await readFile(new URL('../serving-observation.mjs',import.meta.url)));
assert.match(c.host,/^[A-Za-z0-9.-]+$/);assert.match(c.user,/^[a-z_][a-z0-9_-]*$/);assert.match(c.collector,/^\/[A-Za-z0-9._/-]+\.py$/);assert.ok(!c.collector.split('/').includes('..'));assert.match(c.targetIp,/^\d+\.\d+\.\d+\.\d+$/);assert.ok(Number.isInteger(c.seconds)&&c.seconds>=10&&c.seconds<=600);
const baselineBytes=await readFile(c.baselineFile),baseline=JSON.parse(baselineBytes),known=new Map(baseline.samples.filter(s=>[200,204].includes(s.status)&&s.sha256).map(s=>[s.z+'/'+s.x+'/'+s.y,s.sha256]));
const cases=[...new Map(baseline.samples.filter(s=>s.sha256).map(s=>[s.z+'/'+s.x+'/'+s.y,{site:s.site,z:s.z,x:s.x,y:s.y}])).values()];assert.ok(cases.length>=1&&cases.length<=100);
const reserve=createServer();await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const args=['-T','-i',c.identityFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+c.knownHostsFile,'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-L',`127.0.0.1:${port}:${c.targetIp}:3000`,c.user+'@'+c.host,'python3',c.collector,'--seconds',String(c.seconds)];
const child=spawn('ssh',args,{stdio:['ignore','pipe','pipe']}),delay=monitorEventLoopDelay({resolution:20});delay.enable();
const began=performance.now(),started=new Date().toISOString(),samples=[],telemetry=[],stderr=[];let identity=null,complete=null,abort=null,done=false,previousArrival=null,total=0,firstResolve;
const first=new Promise(r=>firstResolve=r),pause=ms=>new Promise(r=>setTimeout(r,ms));
child.stderr.on('data',b=>{if(stderr.reduce((n,x)=>n+x.length,0)<16384)stderr.push(b);});
const exited=new Promise(resolve=>{child.once('error',e=>{abort??='ssh_spawn_'+e.code;done=true;firstResolve();resolve({code:null,signal:null});});child.once('exit',(code,signal)=>{done=true;firstResolve();resolve({code,signal});});});
const watchdog=setTimeout(()=>{abort??='external_window_expired';child.kill('SIGTERM');},(c.seconds+30)*1000);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{abort??='operator_stop';child.kill('SIGTERM');});
const reader=(async()=>{try{for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){total+=line.length;if(line.length>32768||total>8*1024*1024)throw Error('stream bound');const row=JSON.parse(line),arrival=performance.now()-began;
 if(row.kind==='identity'){assert.equal(identity,null);assert.equal(row.schema,'atlas.passive-guest/1');assert.equal(row.tool_sha256,c.collectorSha256);assert.equal(row.containers.find(x=>x.name==='atlas-lab-martin-1')?.id,c.martinId);identity=row;firstResolve();}
 else if(row.kind==='sample'){assert.ok(identity&&!complete);assert.equal(row.sequence,telemetry.length);assert.match(row.monotonic_ns,/^\d{1,24}$/);assert.match(row.wall_ns,/^\d{1,24}$/);assert.ok(Number.isFinite(row.collection_ms));telemetry.push({arrival_ms:arrival,arrival_gap_ms:previousArrival===null?null:arrival-previousArrival,...row});previousArrival=arrival;}
 else if(row.kind==='complete'){assert.ok(identity&&!complete);complete=row;assert.equal(row.samples,telemetry.length);}
 else throw Error('unexpected telemetry record');
 }}catch{abort??='invalid_guest_stream';child.kill('SIGTERM');firstResolve();}})();
await Promise.race([first,pause(15000).then(()=>{if(!identity){abort??='guest_identity_timeout';child.kill('SIGTERM');}})]);
const httpDeadline=performance.now()+(c.seconds-6)*1000;
let i=0;while(identity&&!done&&!abort&&performance.now()<httpDeadline){const t=cases[i++%cases.length],key=t.z+'/'+t.x+'/'+t.y,start=performance.now();let row;
 try{const r=await fetch(`http://127.0.0.1:${port}/basemap/${key}`,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(5000)}),parts=[];let length=0;if(r.body)for await(const b of r.body){length+=b.length;if(length>32*1024*1024)throw Error('body bound');parts.push(b);}const digest=sha(Buffer.concat(parts));row={...t,status:r.status,sha256:digest,bytes:length,matches_first_observation:digest===known.get(key)};}catch(e){row={...t,status:0,error:e.name};}
 row=classifyServingObservation(row,performance.now()-start);samples.push(row);if(row.status===0||![200,204].includes(row.status)){abort='serving_observation_failed';child.kill('SIGTERM');break;}await pause(1000);
}
const exit=await exited;await reader;clearTimeout(watchdog);delay.disable();
if(sourceHash!==sha(await readFile(new URL(import.meta.url)))||classifierHash!==sha(await readFile(new URL('../serving-observation.mjs',import.meta.url))))abort??='observer_source_changed';
const errors=samples.filter(s=>![200,204].includes(s.status)).length,maxArrivalGap=Math.max(0,...telemetry.map(s=>s.arrival_gap_ms??0)),maxGuestGap=Math.max(0,...telemetry.map(s=>s.previous_gap_ms??0)),continuous=delay.max/1e6<=2500&&maxArrivalGap<=2500&&maxGuestGap<=2500;
const valid=Boolean(identity&&complete&&exit.code===0&&!abort&&complete.original_containers_unchanged&&samples.length>0&&errors===0);
const report={schema:'atlas.external-passive-observation/1',tool_sha256:sourceHash,classifier_sha256:classifierHash,baseline_sha256:sha(baselineBytes),started_at:started,ended_at:new Date().toISOString(),scope:'different computer from the VM; SSH tunnel includes guest SSH scheduling/network; not a public gateway or heavy-load acceptance',read_only:true,heavy_workload_started:false,admission_changed:false,production_acceptance:false,complete:valid,observation_continuous:continuous,max_guest_gap_ms:maxGuestGap,max_arrival_gap_ms:maxArrivalGap,abort_reason:abort,exit,requests:samples.length,errors,event_loop_delay_ms:{max:delay.max/1e6,p99:delay.percentile(99)/1e6},guest_identity:identity,guest_complete:complete,guest_samples:telemetry,http_samples:samples,ssh_stderr:Buffer.concat(stderr).toString().slice(0,16384)};
await writeFile(output+'.partial',JSON.stringify(report,null,2)+'\n',{flag:'wx'});await link(output+'.partial',output);await unlink(output+'.partial');console.log(JSON.stringify({complete:valid,continuous,requests:samples.length,errors,guest_samples:telemetry.length,abort_reason:abort}));if(!valid||!continuous)process.exitCode=1;
