// Real observer-death test; restricted to an already prepared disposable fictional E2E database.
import {readFile,writeFile,unlink,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadConfig,pipeline} from '../apps/builder/dist/config.js';
import {BuildQueue,SERVING_WATCH_MS} from '../apps/builder/dist/queue.js';
import {DataRuntime} from '../apps/builder/dist/data.js';
import {SourceGate} from '../apps/builder/dist/source.js';
import {secretFile} from '../apps/ingest/dist/config.js';
import {execute} from '../apps/ingest/dist/process.js';
import {sha256} from '../apps/ingest/dist/contracts.js';
const [basePath,reportPath]=process.argv.slice(2);if(!basePath||!reportPath)throw Error('usage: check-serving-watch.mjs FICTIONAL_BUILD_CONFIG REPORT');
const base=await loadConfig(basePath),pool=new pg.Pool({connectionString:await secretFile(base.controlAdminDsnFile),connectionTimeoutMillis:5000,max:4});
assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/^atlas_test_ingest_e2e_[0-9a-f]{8}$/);assert.equal(base.source.policy.provider,'fixture');
const nonce=randomBytes(4).toString('hex'),unit='atlas-guard-test-'+nonce+'.service',folder=resolve(basePath,'..'),path=join(folder,'watch-'+nonce+'.json'),probePath=join(folder,'watch-probe-'+nonce+'.json'),probeReport=join(folder,'watch-probe-'+nonce+'-report.json');
const unitPath=join(process.env.HOME,'.config/systemd/user',unit),queue=new BuildQueue(pool,300000),pause=ms=>new Promise(r=>setTimeout(r,ms));
let unitOwned=false,http=null,collector=null,importer=null,importTask=null,unitBody='';const logs=[];
async function system(args){const r=await execute('systemctl',['--user',...args],{timeoutMs:10000,maxOutput:65536});assert.equal(r.code,0);return r.stdout.toString().trim();}
try{
 const raw=JSON.parse(await readFile(basePath,'utf8'));raw.timeoutMs+=2;raw.expectedPipelineSha256=null;await writeFile(path,JSON.stringify(raw)+'\n',{flag:'wx',mode:0o600});
 let config=await loadConfig(path);const spec=await pipeline(config);raw.expectedPipelineSha256=spec.sha256;await writeFile(path,JSON.stringify(raw)+'\n');config=await loadConfig(path);
 const root=sha256(config.root);await pool.query('UPDATE atlas_control.candidate_instance SET admission_enabled=false,serving_watch_required=true WHERE singleton');
 const paused=await execute(process.execPath,[join(config.repo,'apps/builder/dist/cli.js'),'work','--once','--config',path],{timeoutMs:20000,maxOutput:65536});assert.equal(paused.code,0);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.candidate_jobs WHERE pipeline_sha256=$1',[spec.sha256])).rows[0].n,0);
 const source=(await pool.query("SELECT id,payload_sha256 FROM atlas_control.intake_validations WHERE state='accepted' ORDER BY validated_at LIMIT 1")).rows[0];assert.ok(source);
 const id=await queue.enqueue(source,spec.sha256,spec.specification);assert.equal(await queue.claim(spec.sha256),null);
 await assert.rejects(()=>queue.setAdmission(root,spec.sha256,true),e=>e.code==='serving_watch_not_ready');
 unitBody=`[Unit]\nDescription=Disposable Atlas watcher death fixture ${nonce}\n[Service]\nType=simple\nExecStart=${process.execPath} ${config.repo}/apps/builder/dist/cli.js work --config ${path}\nRestart=no\n`;
 await writeFile(unitPath,unitBody,{flag:'wx',mode:0o600});unitOwned=true;await system(['daemon-reload']);
 const python="from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):self.send_response(204);self.end_headers()\n def log_message(self,*a):pass\nHTTPServer(('0.0.0.0',3000),H).serve_forever()";
 const server=await execute('docker',['run','--detach','--pull','never','--name','atlas-watch-http-'+nonce,'--label','atlas.watch.fixture='+nonce,'--network',config.network,'--read-only','--cap-drop','ALL','--user','1000:1000','--memory','64m','--entrypoint','python',config.source.worker.validatorImage,'-I','-c',python],{maxOutput:65536});assert.equal(server.code,0);http=server.stdout.toString().trim();
 const item=JSON.parse((await execute('docker',['inspect',http],{maxOutput:65536})).stdout.toString())[0],endpoint='http://'+item.NetworkSettings.Networks[config.network].IPAddress+':3000';
 for(let i=0;i<30;i++){try{if((await fetch(endpoint,{signal:AbortSignal.timeout(500)})).status===204)break;}catch{}await pause(100);}
 await writeFile(probePath,JSON.stringify({root:config.root,jobId:id,controlDsnFile:config.controlDsnFile,endpoint,buildConfigFile:path,guardUnit:unit})+'\n',{flag:'wx',mode:0o600});
 collector=spawn(process.execPath,[join(config.repo,'tools/candidate-serving-probe.mjs'),probePath,probeReport],{stdio:['ignore','pipe','pipe']});for(const stream of [collector.stdout,collector.stderr])stream.on('data',b=>logs.push(b));
 let ready;for(let i=0;i<200;i++){try{ready=JSON.parse(await readFile(probeReport+'.ready','utf8'));break;}catch{}assert.equal(collector.exitCode,null,Buffer.concat(logs).toString());await pause(100);}assert.ok(ready);assert.equal(ready.job_id,id);
 await queue.setAdmission(root,spec.sha256,true);const claim=await queue.claim(spec.sha256);assert.equal(claim.id,id);
 const bound=(await pool.query('SELECT guard_observer_token FROM atlas_control.candidate_attempts WHERE token=$1',[claim.token])).rows[0].guard_observer_token;assert.equal(bound,ready.observer);
 const data=new DataRuntime(config,claim,queue),verified=await new SourceGate(config,pool).verify(source.id,source.payload_sha256);await data.prepare();await data.provision(verified);await system(['start',unit]);
 const credentials=JSON.parse(await secretFile(join(data.directory,'credentials.json'))),uri=new URL(await secretFile(config.dataAdminDsnFile));uri.pathname='/'+claim.database_name;uri.username=claim.import_role;uri.password=credentials.importPassword;
 importer=new pg.Client({connectionString:uri.toString()});await importer.connect();importer.on('error',()=>{});importTask=importer.query('SELECT pg_sleep(120)').then(()=>null,e=>e.code??e.name);
 const killedAt=new Date().toISOString(),exited=new Promise(resolve=>collector.once('exit',(code,signal)=>resolve({code,signal})));collector.kill('SIGKILL');const exit=await exited;assert.equal(exit.signal,'SIGKILL');
 let lost=false;const began=performance.now();while(performance.now()-began<45000){try{await queue.heartbeat(claim);}catch(e){assert.equal(e.code,'lease_lost');lost=true;break;}await pause(500);}assert.equal(lost,true);
 const lossAfter=Math.round(performance.now()-began),fenced=(await queue.status()).find(r=>r.id===id);assert.equal(fenced.state,'failed');assert.equal(fenced.stage,'guard_stopping');assert.equal(fenced.attempts,1);
 const before=await queue.servingGuard(fenced.guard_incident,root,spec.sha256);assert.equal(JSON.parse(before.evidence_text).schema,'atlas.serving-watch-loss/1');assert.equal(before.shutdown_confirmed_at,null);
 const recovery=await execute(process.execPath,[join(config.repo,'tools/recover-serving-guard.mjs'),path,'pending',unit],{timeoutMs:60000,maxOutput:65536});assert.equal(recovery.code,0,recovery.stderr.toString());
 assert.equal(await importTask,'57P01');const final=await queue.servingGuard(before.id,root,spec.sha256);assert.ok(final.shutdown_confirmed_at);
 await queue.setAdmission(root,spec.sha256,false);assert.equal(await queue.claim(spec.sha256),null);
 let finalReport=false;try{await access(probeReport);finalReport=true;}catch{}assert.equal(finalReport,false);
 const report={schema:'atlas.serving-watch-death-test/1',passed:true,fictional_control_only:true,real_builder_unit_stopped:false,
  admission_without_health_refused:true,paused_worker_skips_reconcile:true,observer_bound_to_claim:true,observer_killed_with:'SIGKILL',lease_ms:SERVING_WATCH_MS,killed_at:killedAt,loss_detected_after_ms:lossAfter,
  collector_final_report_available:false,collector_total_http_requests:null,collector_http_error_count:null,initial_ready:ready,
  incident:final.id,evidence_sha256:final.evidence_sha256,evidence_text:final.evidence_text,shutdown_confirmed_at:final.shutdown_confirmed_at,
  final_state:'failed',attempts:1,guarded_candidate_requeued:false,final_admission:await queue.admissionStatus(),
  source_files:Object.fromEntries(await Promise.all(['apps/builder/dist/queue.js','apps/builder/dist/guard.js','apps/builder/dist/worker.js','apps/builder/dist/schema.sql','tools/candidate-serving-probe.mjs','tools/serving-observation.mjs','tools/recover-serving-guard.mjs','tools/check-serving-watch.mjs'].map(async name=>[name,sha256(await readFile(join(config.repo,name)))])))};
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:true,watcher_death_detected:true,loss_ms:report.loss_detected_after_ms,real_unit_stopped:false}));
}finally{
 if(collector&&collector.exitCode===null&&collector.signalCode===null)collector.kill('SIGKILL');
 if(importer)await importer.end().catch(()=>{});if(importTask)await importTask;
 if(unitOwned){await system(['stop',unit]);assert.equal(await readFile(unitPath,'utf8'),unitBody);await unlink(unitPath);await system(['daemon-reload']);}
 if(http){const info=JSON.parse((await execute('docker',['inspect',http],{maxOutput:65536})).stdout.toString())[0];assert.equal(info.Config.Labels['atlas.watch.fixture'],nonce);await execute('docker',['rm','--force',http],{maxOutput:65536});}
 await pool.end();
}
