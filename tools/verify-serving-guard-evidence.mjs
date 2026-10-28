// Integrity of recorded lab evidence; no operational publication or capacity approval.
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]??'docs/evidence/2026-10-29-guard'),sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=name=>readFile(join(root,name)),json=async name=>JSON.parse(await bytes(name)),listed=new Set();
for(const line of (await readFile(join(root,'SHA256SUMS'),'utf8')).trim().split('\n')){
 const m=/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);assert.ok(m);assert.ok(!listed.has(m[2]));listed.add(m[2]);assert.equal(sha(await bytes(m[2])),m[1]);
}
assert.deepEqual([...listed].sort(),(await readdir(root)).filter(n=>n!=='SHA256SUMS').sort());
const q=await json('queue-tests.json'),g=await json('guard-fault-tests.json'),p=await json('guard-fault-probe.json'),inc=await json('guard-incidents.json');
assert.equal(q.passed,true);assert.equal(q.builder_tests_passed,30);assert.equal(q.new_guard_queue_regressions,7);assert.equal(q.owned_fixture_removed,true);assert.equal(q.production_import_repeated,false);
assert.equal(q.test_log_sha256,sha(await bytes('pg-tests.txt')));assert.ok((await bytes('pre-fixture-lease-fix-pg-tests.txt')).toString().includes('29 passed'));
assert.equal(g.passed,true);assert.equal(g.count,6);assert.equal(g.tests.length,6);assert.equal(g.fictional_control_only,true);assert.equal(g.real_builder_unit_stopped,false);
assert.equal(g.final_state,'failed');assert.equal(g.final_stage,'guard_stopped');assert.equal(g.attempts,1);assert.equal(g.failed_data_retained,true);
assert.equal(g.wire_probe_sha256,sha(await bytes('guard-fault-probe.json')));assert.equal(p.guard_incident,g.wire_incident);assert.equal(p.requests,1);assert.equal(p.errors,1);
assert.equal(p.samples[0].status,503);assert.equal(p.guard_stopped_experimental_builder,true);assert.equal(p.observer_failure,null);assert.match(p.scope,/fictional HTTP endpoint/);
assert.deepEqual(p.terminal,{state:'failed',stage:'guard_stopped'});assert.equal(p.old_container_ids_and_start_times_unchanged,true);
assert.equal(inc.fictional_database_only,true);assert.equal(inc.admission_clear_after_verified_recovery,true);assert.equal(inc.incidents.length,2);
assert.deepEqual(inc.incidents.map(r=>r.id).sort(),[g.incident,g.wire_incident].sort());
for(const r of inc.incidents){
 assert.equal(r.evidence_sha256,sha(r.evidence_text));const e=JSON.parse(r.evidence_text);
 assert.equal(e.root,r.root_sha256);assert.equal(e.pipeline,r.pipeline_sha256);assert.equal(e.job,r.job_id);assert.equal(e.token,r.token);assert.equal(e.observation.status,503);
 assert.equal(r.state,'failed');assert.equal(r.stage,'guard_stopped');assert.equal(r.attempts,1);assert.equal(r.failures,1);assert.equal(r.manifest_sha256,null);assert.ok(r.shutdown_confirmed_at);
 for(const key of ['unit_stopped','containers_stopped','backends_stopped','roles_disabled'])assert.equal(r.shutdown_witness[key],true);
 const events=inc.events.filter(x=>x.job_id===r.job_id&&x.token===r.token);assert.deepEqual(events.map(x=>x.event),['serving_guard_latched','serving_guard_shutdown_confirmed']);
 assert.equal(events[0].detail.evidence_sha256,r.evidence_sha256);assert.ok(Date.parse(events[0].created_at)<=Date.parse(events[1].created_at));
}
const e2e=await json('fixture-e2e-report.json');assert.equal(e2e.passed,true);assert.equal(e2e.count,10);assert.equal(e2e.fictional_data_only,true);assert.equal(e2e.production_publication_approved,false);
const old=await json('fixture-serving-probe.json');assert.equal(old.errors,0);assert.equal(old.requests,old.statuses.length);assert.ok(old.statuses.every(s=>[200,204].includes(s)));
for(const kind of ['healthy','geometry','details','topology']){
 const m=await json('fixture-'+kind+'-manifest.json');assert.equal(m.pipeline_sha256,e2e.pipeline_sha256);assert.equal(m.pipeline_sha256,sha(JSON.stringify(m.specification)));
 assert.equal(m.scope,'experimental_source_only');assert.equal(m.publishable,false);assert.equal(m.map_release_ready,false);
 for(const [key,suffix]of Object.entries({canonical_roundtrip:'raw-roundtrip',feature_coverage:'feature-coverage',tile_parity:'tile-parity'}))assert.equal(m.qa[key],sha(await bytes('fixture-'+kind+'-'+suffix+'.json')));
 for(const [path,digest]of Object.entries(g.source_files))if(path.startsWith('apps/builder/dist/'))assert.equal(m.specification.files['builder/'+path.split('/').at(-1)],digest);
 for(const [path,digest]of Object.entries(q.source_files))if(path.startsWith('apps/builder/dist/'))assert.equal(m.specification.files['builder/'+path.split('/').at(-1)],digest);
}
const io=await json('bounded-io-diagnostic.json');assert.equal(io.source_failed_job,'e5139b4aef800ceecfe9aa5b1bd8c57166737915149c8b4fd0c704da0da5af42');
assert.equal(io.requests,48);assert.equal(io.samples.length,48);assert.equal(io.errors,0);assert.equal(io.original_serving_unchanged,true);assert.equal(io.aborted_on_serving_failure,false);
assert.equal(io.workload.read_only,true);assert.equal(io.workload.statement_timeout_ms,20000);assert.equal(io.workload.code,'57014');
for(const flag of ['candidate_data_modified','full_import_repeated','production_acceptance_claim'])assert.equal(io[flag],false);
for(const [phase,r]of Object.entries(io.summary)){const samples=io.samples.filter(s=>s.phase===phase);assert.equal(samples.length,r.requests);assert.equal(r.errors,0);assert.equal(r.max_ms,Math.max(...samples.map(s=>s.ms)));}
const summary=await json('verification-summary.json');assert.equal(summary.local_tests_passed,136);assert.equal(summary.local_environment_dependent_skipped,40);assert.equal(summary.guard_runtime_fault_cases,6);
for(const flag of ['country_import_repeated','main_runtime_upgraded','production_approved'])assert.equal(summary[flag],false);
if(process.argv.includes('--source')){
 const repo=fileURLToPath(new URL('..',import.meta.url));
 for(const [path,digest]of Object.entries({...q.source_files,...g.source_files}))assert.equal(sha((await readFile(join(repo,path),'utf8')).replaceAll('\r\n','\n')),digest,path);
 assert.equal(sha(await readFile(new URL('./diagnose-io-contention.mjs',import.meta.url))),io.tool_sha256);
 assert.equal(sha((await readFile(join(repo,'apps/builder/dist/qa.js'),'utf8')).replaceAll('\r\n','\n')),io.qa_compiled_sha256);
}
console.log(JSON.stringify({passed:true,pg_environment_builder_tests:30,core_e2e:10,guard_fault_cases:6,bounded_io_requests:48,bounded_io_errors:0,full_country_acceptance:false},null,2));
