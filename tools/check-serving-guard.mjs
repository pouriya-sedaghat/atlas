// Fault injection is restricted to an existing disposable fictional-data E2E environment.
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadConfig,pipeline} from '../apps/builder/dist/config.js';
import {BuildQueue} from '../apps/builder/dist/queue.js';
import {DataRuntime} from '../apps/builder/dist/data.js';
import {SourceGate} from '../apps/builder/dist/source.js';
import {ServingGuard} from '../apps/builder/dist/guard.js';
import {secretFile} from '../apps/ingest/dist/config.js';
import {execute} from '../apps/ingest/dist/process.js';
import {sha256} from '../apps/ingest/dist/contracts.js';
const [basePath,reportPath]=process.argv.slice(2);if(!basePath||!reportPath)throw Error('usage: check-serving-guard.mjs FICTIONAL_BUILD_CONFIG REPORT');
const base=await loadConfig(basePath),pool=new pg.Pool({connectionString:await secretFile(base.controlAdminDsnFile),connectionTimeoutMillis:5000,max:4});
const guardPool=new pg.Pool({connectionString:await secretFile(base.controlDsnFile),connectionTimeoutMillis:5000,max:2});
const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
assert.match(db,/^atlas_test_ingest_e2e_[0-9a-f]{8}$/);assert.equal(base.source.policy.provider,'fixture');
const nonce=randomBytes(4).toString('hex'),unit='atlas-guard-test-'+nonce+'.service',path=join(resolve(basePath,'..'),'guard-'+nonce+'.json');
const unitPath=join(process.env.HOME,'.config/systemd/user',unit),queue=new BuildQueue(pool,300000),tests=[];
let unitOwned=false,foreign=null,importer=null,managedAdmin=null,importTask=null,adminTask=null,incident=null,originalTarget=null,claim=null,config=null,httpContainer=null;
async function system(args){const r=await execute('systemctl',['--user',...args],{timeoutMs:10000,maxOutput:65536});assert.equal(r.code,0,r.stderr.toString());return r.stdout.toString().trim();}
try{
 const raw=JSON.parse(await readFile(basePath,'utf8'));raw.timeoutMs+=1;raw.expectedPipelineSha256=null;
 await writeFile(path,JSON.stringify(raw)+'\n',{mode:0o600,flag:'wx'});config=await loadConfig(path);
 const spec=await pipeline(config);raw.expectedPipelineSha256=spec.sha256;await writeFile(path,JSON.stringify(raw)+'\n');config=await loadConfig(path);
 const sourceRow=(await pool.query("SELECT id,payload_sha256 FROM atlas_control.intake_validations WHERE state='accepted' ORDER BY validated_at LIMIT 1")).rows[0];assert.ok(sourceRow);
 const source=await new SourceGate(config,pool).verify(sourceRow.id,sourceRow.payload_sha256);
 const id=await queue.enqueue(sourceRow,spec.sha256,spec.specification);claim=await queue.claim(spec.sha256);assert.equal(claim.id,id);
 const data=new DataRuntime(config,claim,queue);await data.prepare();await data.provision(source);
 originalTarget=(await pool.query('SELECT data_target FROM atlas_control.candidate_attempts WHERE token=$1',[claim.token])).rows[0].data_target;
 await mkdir(join(process.env.HOME,'.config/systemd/user'),{recursive:true});
 await writeFile(unitPath,`[Unit]\nDescription=Disposable Atlas guard fault fixture ${nonce}\n[Service]\nType=simple\nExecStart=${process.execPath} ${config.repo}/apps/builder/dist/cli.js work --config ${path}\nRestart=no\n`,{flag:'wx',mode:0o600});unitOwned=true;
 await system(['daemon-reload']);await system(['start',unit]);assert.equal(await system(['is-active',unit]),'active');
 const guard=new ServingGuard(config,path,guardPool,unit);
 const observation={at:new Date().toISOString(),site:'fixture',z:1,x:0,y:0,status:503,ms:2};
 const wrong=new ServingGuard(config,path,guardPool);await assert.rejects(()=>wrong.latch(id,claim.token,observation),e=>e.code==='guard_unit_binding_mismatch');
 assert.equal(await queue.tokenLive(id,claim.token),true);tests.push('foreign_worker_unit_refused_before_quarantine_or_stop');
 const credentials=JSON.parse(await secretFile(join(data.directory,'credentials.json'))),uri=new URL(await secretFile(config.dataAdminDsnFile));uri.pathname='/'+claim.database_name;uri.username=claim.import_role;uri.password=credentials.importPassword;
 importer=new pg.Client({connectionString:uri.toString()});await importer.connect();importer.on('error',()=>{});
 importTask=importer.query('SELECT pg_sleep(120)').then(()=>null,e=>e.code??e.name);
 const adminUri=new URL(await secretFile(config.dataAdminDsnFile));adminUri.pathname='/'+claim.database_name;
 foreign=new pg.Client({connectionString:adminUri.toString(),application_name:'atlas-guard-fixture-unrelated'});await foreign.connect();
 const controlAdminUri=new URL(adminUri);controlAdminUri.pathname='/postgres';
 managedAdmin=new pg.Client({connectionString:controlAdminUri.toString(),application_name:'atlas-build/'+id.slice(0,12)+'/'+claim.token});await managedAdmin.connect();managedAdmin.on('error',()=>{});
 adminTask=managedAdmin.query('SELECT pg_sleep(120)').then(()=>null,e=>e.code??e.name);
 incident=await guard.latch(id,claim.token,observation);
 assert.equal(await system(['is-active',unit]),'active');assert.equal((await queue.status()).find(r=>r.id===id).state,'failed');
 const restarted=new ServingGuard(await loadConfig(path),path,guardPool,unit);
 assert.equal(await restarted.queue.claim(spec.sha256),null);tests.push('committed_guard_survives_observer_restart_before_unit_stop');
 await pool.query('UPDATE atlas_control.candidate_attempts SET data_target=$2 WHERE token=$1',[claim.token,JSON.stringify({...originalTarget,system_identifier:'wrong-fixture-target'})]);
 await assert.rejects(()=>restarted.recover(incident.id),e=>e.code==='guard_data_target_changed');
 assert.equal((await queue.servingGuard(incident.id,sha256(config.root),spec.sha256)).shutdown_confirmed_at,null);
 assert.equal((await foreign.query('SELECT 42 AS n')).rows[0].n,42);tests.push('changed_target_refused_without_releasing_admission');
 await pool.query('UPDATE atlas_control.candidate_attempts SET data_target=$2 WHERE token=$1',[claim.token,JSON.stringify(originalTarget)]);
 await assert.rejects(()=>restarted.recover(incident.id),e=>e.code==='guard_backends_remain');
 assert.equal((await foreign.query('SELECT 42 AS n')).rows[0].n,42);assert.equal(await importTask,'57P01');
 assert.equal(await adminTask,'57P01');
 assert.equal((await queue.servingGuard(incident.id,sha256(config.root),spec.sha256)).shutdown_confirmed_at,null);
 tests.push('owned_import_and_tagged_admin_backends_terminated_unknown_backend_keeps_hold');
 await foreign.end();foreign=null;await importer.end().catch(()=>{});importer=null;
 await restarted.recover(incident.id);const final=await queue.servingGuard(incident.id,sha256(config.root),spec.sha256);assert.ok(final.shutdown_confirmed_at);
 assert.equal((await pool.query('SELECT holder_kind FROM atlas_control.processing_slot')).rows[0].holder_kind,null);
 const status=(await queue.status()).find(r=>r.id===id);assert.equal(status.state,'failed');assert.equal(status.attempts,1);assert.equal(status.stage,'guard_stopped');
 await assert.rejects(()=>new pg.Client({connectionString:uri.toString(),connectionTimeoutMillis:1000}).connect(),e=>['28000','28P01'].includes(e.code));
 await restarted.recover(incident.id);tests.push('recovery_disables_credentials_releases_once_and_never_requeues_failed_job');
 // Exercise the actual observer -> transaction -> unit -> resource cleanup path with one intentional 503.
 const second=(await pool.query("SELECT id,payload_sha256 FROM atlas_control.intake_validations WHERE state='accepted' AND id<>$1 ORDER BY validated_at LIMIT 1",[sourceRow.id])).rows[0];assert.ok(second);
 const secondId=await queue.enqueue(second,spec.sha256,spec.specification),wire=await queue.claim(spec.sha256);assert.ok(wire);assert.equal(wire.id,secondId);
 const wireSource=await new SourceGate(config,pool).verify(wire.source_validation_id,wire.payload_sha256);
 const wireData=new DataRuntime(config,wire,queue);await wireData.prepare();await wireData.provision(wireSource);await system(['start',unit]);
 const python="from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(503);self.end_headers()\n def log_message(self,*a):pass\nHTTPServer(('0.0.0.0',3000),H).serve_forever()";
 const server=await execute('docker',['run','--detach','--pull','never','--name','atlas-guard-http-'+nonce,'--label','atlas.guard.fixture='+nonce,'--network',config.network,'--read-only','--cap-drop','ALL','--user','1000:1000','--memory','64m','--entrypoint','python',config.source.worker.validatorImage,'-I','-c',python],{maxOutput:65536});assert.equal(server.code,0);httpContainer=server.stdout.toString().trim();
 const info=JSON.parse((await execute('docker',['inspect',httpContainer],{maxOutput:65536})).stdout.toString())[0],endpoint='http://'+info.NetworkSettings.Networks[config.network].IPAddress+':3000';
 let ready=false;for(let i=0;i<30;i++){try{if((await fetch(endpoint,{signal:AbortSignal.timeout(500)})).status===503){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(ready,true);
 const probeConfig=join(resolve(basePath,'..'),'guard-probe-'+nonce+'.json'),wireReport=reportPath.replace(/\.json$/,'-probe.json');
 await writeFile(probeConfig,JSON.stringify({root:config.root,jobId:wire.id,controlDsnFile:config.controlDsnFile,endpoint,buildConfigFile:path,guardUnit:unit})+'\n',{mode:0o600,flag:'wx'});
 const ran=await execute(process.execPath,[join(config.repo,'tools/candidate-serving-probe.mjs'),probeConfig,wireReport],{timeoutMs:60000,maxOutput:65536});assert.equal(ran.code,0,ran.stderr.toString());
 const wireProbe=JSON.parse(await readFile(wireReport,'utf8'));assert.equal(wireProbe.requests,1);assert.equal(wireProbe.errors,1);assert.equal(wireProbe.observer_failure,null);assert.equal(wireProbe.guard_stopped_experimental_builder,true);assert.match(wireProbe.guard_incident,/^[a-f0-9]{64}$/);assert.deepEqual(wireProbe.terminal,{state:'failed',stage:'guard_stopped'});
 tests.push('actual_http_observer_commits_incident_before_stopping_only_the_fixture_unit');
 const evidence={schema:'atlas.serving-guard-fault-tests/1',passed:true,count:tests.length,tests,fictional_control_only:true,real_builder_unit_stopped:false,
  incident:final.id,root_sha256:final.root_sha256,pipeline_sha256:final.pipeline_sha256,evidence_sha256:final.evidence_sha256,
  job_id:id,attempt:claim.token,final_state:status.state,final_stage:status.stage,attempts:status.attempts,failed_data_retained:true,wire_incident:wireProbe.guard_incident,wire_probe_sha256:sha256(await readFile(wireReport)),
  source_files:Object.fromEntries(await Promise.all(['apps/builder/dist/guard.js','apps/builder/dist/queue.js','apps/builder/dist/data.js','apps/builder/dist/schema.sql','tools/check-serving-guard.mjs','tools/candidate-serving-probe.mjs'].map(async name=>[name,sha256(await readFile(join(config.repo,name)))])))};
 await writeFile(reportPath,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:true,count:tests.length,tests}));
}finally{
 if(foreign)await foreign.end().catch(()=>{});if(importer)await importer.end().catch(()=>{});if(managedAdmin)await managedAdmin.end().catch(()=>{});if(importTask)await importTask;if(adminTask)await adminTask;
 if(httpContainer){const detail=JSON.parse((await execute('docker',['inspect',httpContainer],{maxOutput:65536})).stdout.toString())[0];assert.equal(detail.Config.Labels['atlas.guard.fixture'],nonce);await execute('docker',['rm','--force',httpContainer],{maxOutput:65536});}
 if(unitOwned){await system(['stop',unit]);assert.equal(await readFile(unitPath,'utf8'),`[Unit]\nDescription=Disposable Atlas guard fault fixture ${nonce}\n[Service]\nType=simple\nExecStart=${process.execPath} ${config.repo}/apps/builder/dist/cli.js work --config ${path}\nRestart=no\n`);await unlink(unitPath);await system(['daemon-reload']);}
 await guardPool.end();await pool.end();
}
