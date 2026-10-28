// Verify recorded failure evidence and separate software tests. Never authorizes publication.
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]??'docs/evidence/2026-10-28-catalog-attempt');
const sha=b=>createHash('sha256').update(b).digest('hex');
const listed=new Set();
for(const line of (await readFile(join(root,'SHA256SUMS'),'utf8')).trim().split('\n')){
 const match=/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);assert.ok(match);assert.ok(!listed.has(match[2]));listed.add(match[2]);
 assert.equal(sha(await readFile(join(root,match[2]))),match[1]);
}
assert.deepEqual([...listed].sort(),(await readdir(root)).filter(n=>n!=='SHA256SUMS').sort());
const bytes=async name=>listed.has(name)?readFile(join(root,name)):gunzipSync(await readFile(join(root,name+'.gz')));
const json=async name=>JSON.parse(await bytes(name));
const {job,attempts,events}=await json('latest-job.json'),summary=await json('verification-summary.json');
assert.equal(job.state,'failed');assert.equal(job.failure_code,'old_serving_http_timeout');assert.equal(job.manifest_sha256,null);
assert.equal(job.attempts,1);assert.equal(job.failures,1);assert.equal(job.token,null);assert.equal(attempts.length,1);assert.equal(attempts[0].state,'failed');
// PostgreSQL jsonb changes object key order. Use the exact frozen inspector serialization.
const pipeline=await json('latest-pipeline.json');assert.equal(pipeline.sha256,job.pipeline_sha256);
assert.equal(pipeline.sha256,sha(JSON.stringify(pipeline.specification)));assert.deepEqual(pipeline.specification,job.specification);
assert.equal(job.pipeline_sha256,'32590f3516d833ae9a773fb27488d66b4790026d5478a34e7c149621d8406e64');
assert.equal(summary.job_id,job.id);assert.equal(summary.pipeline_sha256,job.pipeline_sha256);
assert.equal(summary.scope,'experimental_source_only');assert.equal(summary.publishable,false);assert.equal(summary.map_release_ready,false);
for(const flag of ['manifest_created','feature_coverage_completed','tile_qa_completed','whole_platform_migration_complete','production_publication_approved'])assert.equal(summary[flag],false);
assert.equal(summary.automatic_reimport_disabled,true);assert.equal(summary.candidate_data_modified_by_archive,false);
assert.equal(summary.import_code_commit,'e783af8a7c060a8dfd8dd94fa28c14ca684bcbeb');
const duplicate=await json('iran-job.json');assert.deepEqual(duplicate.job,job);assert.deepEqual(duplicate.attempts,attempts);
const stages=events.filter(e=>e.event==='stage').map(e=>e.detail.stage);
assert.deepEqual(stages,['source_verification','provision','import','finalize','raw_roundtrip','feature_coverage']);
assert.ok(events.some(e=>e.event==='failed'&&e.detail.code==='candidate_infrastructure_error'));
assert.ok(events.some(e=>e.event==='operator_invalidated'&&e.detail.manifest_created===false));
const source=await json('iran-source-acceptance.json'),audit=await json('iran-intake-audit.json');
assert.equal(source.usage_scope,'experimental_source_only');assert.equal(source.subject.sha256,'a3c61d35b010d4a474c1eabdef9500339472743423d7bb895b16241c08eb4065');
assert.equal(sha(await bytes('iran-source-acceptance.json')),job.payload_sha256);assert.equal(source.report_sha256,sha(await bytes('iran-intake-audit.json')));
const raw=await json('latest-raw-roundtrip.json');assert.equal(raw.passed,true);assert.equal(raw.source_sha256,source.subject.sha256);
for(const [kind,r]of Object.entries(raw.results)){assert.equal(r.count,audit.counts[kind]);assert.equal(r.sha256,audit.semantic_digest[kind]);assert.equal(r.digest_matches,true);}
assert.equal(Object.values(raw.results).reduce((n,r)=>n+r.count,0),30500932);
const native=await json('latest-native-import-witness.json');assert.equal(native.job_id,job.id);assert.equal(native.attempt,attempts[0].token);assert.match(native.sha256,/^[a-f0-9]{64}$/);assert.ok(native.tail.some(s=>s.includes('osm2pgsql took 4595s')));
const segments=[];
for(let i=1;i<=2;i++){
 const b=await bytes('latest-serving-probe-segment-'+i+'.json'),r=JSON.parse(b);segments.push(r);
 assert.equal(r.job_id,job.id);assert.equal(r.guard_enabled,true);assert.equal(r.observer_failure,null);assert.equal(r.requests,r.samples.length);
 assert.equal(r.errors,r.samples.filter(s=>![200,204].includes(s.status)).length);assert.equal(r.old_container_ids_and_start_times_unchanged,true);assert.equal(r.byte_change_observations,0);
 const descriptor=summary.segments[i-1];assert.equal(descriptor.sha256,sha(b));
 for(const key of ['requests','errors','started_at','ended_at'])assert.equal(descriptor[key],r[key]);
}
assert.equal(segments[0].requests,5837);assert.equal(segments[0].errors,0);assert.equal(segments[0].terminal,null);assert.equal(segments[0].guard_stopped_experimental_builder,false);
assert.equal(segments[1].requests,44);assert.equal(segments[1].errors,1);assert.equal(segments[1].guard_stopped_experimental_builder,true);
assert.deepEqual(segments[1].terminal,{state:'running',stage:'feature_coverage'});assert.deepEqual(segments[0].old_containers,segments[1].old_containers);
const bad=segments.flatMap(r=>r.samples).filter(s=>![200,204].includes(s.status));assert.deepEqual(bad,summary.failures);
assert.equal(bad.length,1);assert.equal(bad[0].site,'ahvaz');assert.equal(bad[0].z,16);assert.equal(bad[0].status,0);
assert.equal(summary.requests,5881);assert.equal(summary.errors,1);
assert.equal(Date.parse(segments[1].started_at)-Date.parse(segments[0].ended_at),2730);
const continuation=await json('latest-observer-continuation-status.json');assert.equal(continuation.first_report_sha256,summary.segments[0].sha256);assert.equal(continuation.pipeline_sha256,job.pipeline_sha256);
assert.equal(events.find(e=>e.event==='operator_invalidated').detail.observer_report_sha256,summary.segments[1].sha256);
const idle=await json('latest-idle-health.json');assert.equal(idle.passed,true);assert.equal(idle.builder_active,false);assert.equal(idle.requests,24);assert.equal(idle.errors,0);assert.equal(idle.old_containers_unchanged,true);
assert.ok(idle.samples.every(s=>[200,204].includes(s.status)&&s.matches_before_import));assert.equal(idle.tool_sha256,sha(await bytes('latest-record-stage4-idle-health.mjs')));
const initialIdle=await json('latest-idle-health-initial-count-check.json');assert.equal(initialIdle.passed,false);assert.equal(initialIdle.requests,23);assert.equal(initialIdle.errors,0);
assert.equal(initialIdle.tool_sha256,sha(await bytes('latest-idle-health-initial-count-check.mjs')));
const prereq=await json('server-prerequisite-negative.json');assert.equal(prereq.passed,true);assert.equal(prereq.pipeline_sha256,job.pipeline_sha256);assert.equal(prereq.server_configuration_changed,false);
assert.equal(job.specification.resources.data_limits.readBps,8388608);assert.equal(job.specification.resources.data_limits.writeBps,8388608);
const deps=await json('runtime-dependency-permissions.json');assert.equal(deps.pipeline_sha256,job.pipeline_sha256);assert.equal(deps.shared_by_hardlink,0);assert.equal(deps.writable_regular_files,0);
const diagnostic=await json('full-source-serving-profile.json');assert.equal(diagnostic.passed,true);assert.equal(diagnostic.original_snapshots_modified,false);assert.equal(diagnostic.owned_schema_removed,true);
assert.equal(diagnostic.tile_parity.samples.length,48);assert.equal(diagnostic.tile_parity.passed,true);assert.equal(diagnostic.old_serving.requests,776);assert.equal(diagnostic.old_serving.errors,0);
assert.equal(diagnostic.tested_tile_sql_sha256,job.specification.files['infra/atlas/tiles-v2.sql']);assert.equal(diagnostic.original_verifier_sha256,job.specification.files['tools/verify-tiles.mjs']);
const timeout=await json('rejected-tile-timeout-job.json');assert.equal(timeout.job.state,'failed');assert.equal(timeout.job.manifest_sha256,null);assert.equal(timeout.job.id,diagnostic.source_failed_job);
const resize=await json('filesystem-capacity-change.json');assert.equal(resize.pipeline_sha256,timeout.job.pipeline_sha256);assert.notEqual(resize.pipeline_sha256,job.pipeline_sha256);
const resizeConfirmation=await json('capacity-user-confirmation.json');assert.equal(resizeConfirmation.human_user_reported_performing_resize,true);
assert.equal(resizeConfirmation.historical_pipeline_sha256,resize.pipeline_sha256);assert.equal(resizeConfirmation.user_reported_ext4_blocks_after,resize.new_ext4_blocks);
assert.equal(resizeConfirmation.historical_witness_preserved_unchanged,true);assert.equal(resizeConfirmation.changes_made_by_this_check,false);
assert.equal(resizeConfirmation.latency_issue_resolved,false);assert.ok(resizeConfirmation.filesystem_now.available_bytes>190*1024**3);
for(const name of ['rejected-security-barrier-job.json','rejected-metadata-job.json','rejected-serving-profile-job.json','rejected-deadlock-job.json']){const r=await json(name);assert.equal(r.job.state,'failed');assert.equal(r.job.manifest_sha256,null);}
const deadlock=await json('rejected-deadlock-job.json');assert.equal(deadlock.failures.length,2);assert.ok(deadlock.failures[0].message.includes('deadlock detected'));
const oldPg=(await bytes('pg-tests.txt')).toString();assert.ok(oldPg.includes('20 passed'));
const meta=await json('metadata-test-cleanup-guard.json');assert.equal(meta.passed,true);assert.equal(meta.original_table_oid_unchanged,true);assert.equal(meta.original_rows_unchanged,true);
const faults=await json('tile-check-faults.json');assert.equal(faults.passed,true);assert.equal(faults.count,3);assert.equal(faults.verifier_sha256,job.specification.files['tools/verify-tiles.mjs']);
const opt=await json('optimization-report.json');assert.equal(opt.passed,true);assert.equal(opt.builder_tests_passed,23);assert.equal(opt.new_real_postgresql_regressions,3);assert.equal(opt.production_import_repeated,false);assert.equal(opt.owned_fixture_removed,true);
assert.equal(opt.test_log_sha256,sha(await bytes('optimization-pg-tests.txt')));
const fixtureReports=[];
for(const prefix of ['', 'optimization-']){
 const e2e=await json(prefix+'fixture-e2e-report.json');fixtureReports.push(e2e);assert.equal(e2e.passed,true);assert.equal(e2e.count,10);assert.equal(e2e.fictional_data_only,true);assert.equal(e2e.production_publication_approved,false);
 const probe=await json(prefix+'fixture-serving-probe.json');assert.equal(probe.errors,0);assert.equal(probe.statuses.length,probe.requests);assert.ok(probe.statuses.every(s=>[200,204].includes(s)));
 if(prefix)assert.equal(probe.requests,97);
 for(const kind of ['healthy','geometry','details','topology']){
  const m=await json(prefix+'fixture-'+kind+'-manifest.json');assert.equal(m.publishable,false);assert.equal(m.map_release_ready,false);assert.equal(m.scope,'experimental_source_only');
  assert.equal(m.pipeline_sha256,sha(JSON.stringify(m.specification)));assert.equal(m.pipeline_sha256,e2e.pipeline_sha256);
  const changed=Object.keys(job.specification.files).filter(k=>job.specification.files[k]!==m.specification.files[k]).sort();assert.deepEqual(changed,prefix?['builder/qa.js']:[]);
  if(prefix)assert.equal(m.specification.files['builder/qa.js'],opt.qa_compiled_sha256);
  for(const [key,suffix]of Object.entries({canonical_roundtrip:'raw-roundtrip',feature_coverage:'feature-coverage',tile_parity:'tile-parity'}))assert.equal(m.qa[key],sha(await bytes(prefix+'fixture-'+kind+'-'+suffix+'.json')));
  const coverage=await json(prefix+'fixture-'+kind+'-feature-coverage.json');assert.deepEqual(coverage.accounting,{missing_outcomes:0,orphan_outcomes:0});assert.equal(coverage.serving_integrity.blocked_rows_exposed,0);
  const tile=await json(prefix+'fixture-'+kind+'-tile-parity.json');assert.equal(tile.passed,true);assert.equal(tile.failure,null);assert.ok(tile.samples.every(r=>r.parity));
 }
}
assert.deepEqual(summary.local,{build:'passed',typecheck:'passed',tests_passed:136,environment_dependent_skipped:33});
const stops=await json('optimization-fixtures-stopped.json');assert.equal(stops.stopped.length,4);assert.equal(stops.databases_and_volumes_deleted,false);assert.equal(stops.original_serving_restarted,false);
if(listed.has('evidence-fault-tests.json')){
 const f=await json('evidence-fault-tests.json');assert.equal(f.passed,true);assert.equal(f.positive_control_passed,true);assert.equal(f.count,3);assert.equal(f.source_evidence_changed,false);assert.ok(f.cases.every(c=>c.refused&&c.checksum_inventory_recomputed));
 assert.deepEqual(f.cases.map(c=>c.name),['publication_flag_forged','serving_failure_erased','raw_count_changed']);
 assert.equal(f.checker_sha256,sha((await readFile(new URL(import.meta.url),'utf8')).replaceAll('\r\n','\n')));
 assert.equal(f.fault_harness_sha256,sha((await readFile(new URL('./fault-check-catalog-attempt-evidence.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n')));
}
if(process.argv.includes('--source')){
 const repo=fileURLToPath(new URL('..',import.meta.url));
 assert.equal(opt.qa_source_sha256,sha(await readFile(join(repo,'apps/builder/src/qa.ts'))));
 assert.equal(opt.integration_test_sha256,sha(await readFile(join(repo,'apps/builder/src/topology.integration.test.ts'))));
 assert.equal(opt.qa_compiled_sha256,sha((await readFile(join(repo,'apps/builder/dist/qa.js'),'utf8')).replaceAll('\r\n','\n')));
 for(const [name,expected]of Object.entries(job.specification.files)){
  if(name==='builder/qa.js')continue;const path=name.startsWith('builder/')?'apps/builder/dist/'+name.slice(8):name;
  assert.equal(sha((await readFile(join(repo,path),'utf8')).replaceAll('\r\n','\n')),expected,name);
 }
 assert.equal(fixtureReports[1].tool_sha256,sha((await readFile(new URL('./builder-e2e.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n')));
}
console.log(JSON.stringify({passed:true,full_country_attempt:'failed',raw_objects:30500932,old_serving_requests:summary.requests,old_serving_errors:summary.errors,post_change_pg_tests:23,post_change_e2e_tests:10,production_approved:false},null,2));
