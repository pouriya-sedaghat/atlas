// Read-only recovery observation. This cannot make the rejected import successful.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const p='/home/owner/atlas-candidate-private/';
const first=JSON.parse(await readFile(p+'stage4/rejected-old-serving/serving-probe-segment-1.json','utf8'));
const cfg=JSON.parse(await readFile(p+'serving-probe-config.json','utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(cfg.jobId,first.job_id);
let active=false;try{execFileSync('systemctl',['--user','is-active','--quiet','atlas-candidate-worker.service']);active=true;}catch{}assert.equal(active,false);
const samples=[],started=new Date().toISOString();
// Keep all 24 site/zoom cases: two sites can legitimately share one low-zoom tile.
for(const baseline of first.samples.slice(0,24)){
 const key=`${baseline.z}/${baseline.x}/${baseline.y}`;
 const began=performance.now();let row;
 try{
  const response=await fetch(cfg.endpoint+'/basemap/'+key,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(5000)});
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=32*1024*1024);
  row={site:baseline.site,z:baseline.z,x:baseline.x,y:baseline.y,status:response.status,bytes:bytes.length,sha256:sha(bytes),matches_before_import:sha(bytes)===baseline.sha256};
 }catch(error){row={site:baseline.site,z:baseline.z,x:baseline.x,y:baseline.y,status:0,error:error.name};}
 row.ms=Math.round((performance.now()-began)*1000)/1000;samples.push(row);
}
const identities=JSON.parse(execFileSync('docker',['inspect',...first.old_containers.map(r=>r.name)]));
const unchanged=first.old_containers.every(r=>identities.some(x=>x.Id===r.id&&x.State.StartedAt===r.started_at&&x.State.Running));
const report={schema:'atlas.idle-serving-health/1',tool_sha256:sha(await readFile(new URL(import.meta.url))),job_id:cfg.jobId,started_at:started,ended_at:new Date().toISOString(),
 builder_active:false,requests:samples.length,errors:samples.filter(r=>![200,204].includes(r.status)).length,old_containers_unchanged:unchanged,
 passed:unchanged&&samples.length===24&&samples.every(r=>[200,204].includes(r.status)&&r.matches_before_import),samples,
 scope:'24 sequential old-serving checks after the build was stopped; no warmup; does not negate the earlier timeout or prove load capacity'};
await writeFile(p+'stage4/rejected-old-serving/idle-health.json',JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(p+'stage4/rejected-old-serving/record-stage4-idle-health.mjs',await readFile(new URL(import.meta.url)),{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:report.passed,requests:report.requests,errors:report.errors,old_containers_unchanged:unchanged}));
if(!report.passed)process.exitCode=1;
