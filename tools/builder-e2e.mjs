// Real candidate builds, restricted to a fresh disposable control DB and fictional PBFs.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execute} from '../apps/ingest/dist/process.js';
import {loadConfig,secretFile} from '../apps/ingest/dist/config.js';
import {IntakeFiles} from '../apps/ingest/dist/files.js';
import {IntakeQueue} from '../apps/ingest/dist/queue.js';
import {BuildQueue} from '../apps/builder/dist/queue.js';
import {IntakeWorker,DockerValidator} from '../apps/ingest/dist/worker.js';
import {sha256} from '../apps/ingest/dist/contracts.js';
const[sourcePath,buildPath,fixturePath,evidencePath]=process.argv.slice(2);
if(!sourcePath||!buildPath||!fixturePath||!evidencePath)throw Error('usage: builder-e2e.mjs SOURCE_CONFIG BUILD_CONFIG FIXTURES EVIDENCE');
const source=await loadConfig(sourcePath),build=JSON.parse(await readFile(buildPath,'utf8'));
const pool=new pg.Pool({connectionString:await secretFile(source.dsnFiles.admin),max:4,connectionTimeoutMillis:5000});
const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
if(!/^atlas_test_ingest_e2e_[0-9a-f]{8}$/.test(db))throw Error('fresh atlas_test_ingest_e2e_<nonce> database required');
if(build.sourceConfigPath!==resolve(sourcePath)||source.policy.provider!=='fixture'||source.policy.region!=='fixture')throw Error('fictional source configuration required');
const expectedControl=new URL(await secretFile(source.dsnFiles.admin));
for(const path of [build.controlDsnFile,build.controlAdminDsnFile]){
  const actual=new URL(await secretFile(path));
  if(actual.hostname!==expectedControl.hostname||(actual.port||'5432')!==(expectedControl.port||'5432')||actual.pathname!==expectedControl.pathname)throw Error('all control connections must target the same disposable test database');
}
const intake=new IntakeQueue(pool),queue=new BuildQueue(pool),files=new IntakeFiles(source.root,source.python);
const worker=new IntakeWorker(files,intake,source.policy,source.worker,new DockerValidator(files,source.worker));
const root=fileURLToPath(new URL('..',import.meta.url)),intakeCli=join(root,'apps/ingest/dist/cli.js'),buildCli=join(root,'apps/builder/dist/cli.js');
async function command(cli,config,name,args=[]){
  const r=await execute(process.execPath,[cli,name,'--config',config,...args],{timeoutMs:180000,maxOutput:2*1024*1024,cwd:root});
  assert.equal(r.code,0,`${name}: ${r.stderr.toString()}`);return r;
}
const s=(name,args=[])=>command(intakeCli,sourcePath,name,args),b=(name,args=[])=>command(buildCli,buildPath,name,args);
async function accept(filename,approveFictionalAnomaly=false){
  const r=await s('submit',['--file',resolve(fixturePath,filename),'--provider','fixture','--region','fixture','--url','https://example.org/fixture.osm.pbf']);
  const delivery=JSON.parse(r.stdout.toString());
  // A previous admission test deliberately left an older delivery queued.
  // A single work invocation may legitimately process that delivery first.
  for(let i=0;i<10;i++){
    await s('work',['--once']);const row=(await intake.status()).find(x=>x.id===delivery.id);
    if(row.validation_id)break;
    assert.ok(!['rejected','failed'].includes(row.job_state),JSON.stringify(row));
  }
  if(approveFictionalAnomaly){
    const row=(await intake.status()).find(x=>x.id===delivery.id);assert.equal(row.validation_state,'review_required');
    await s('review',['--validation',row.validation_id,'--report-sha',row.report_sha256,'--decision-sha',row.decision_sha256,
      '--action','approve','--actor','e2e-fictional-topology-operator','--reason','Only this fictional topology fixture is approved for an experimental test']);
  }
  await s('sign',['--once']);
  const row=(await intake.status()).find(x=>x.id===delivery.id);assert.equal(row.validation_state,'accepted');return {delivery,validation:await intake.validation(row.validation_id)};
}
async function jobFor(validation){return (await queue.status()).find(x=>x.source_validation_id===validation.id&&x.payload_sha256===validation.payload_sha256);}
async function artifact(hash){return JSON.parse(await readFile(join(build.root,'artifacts',hash+'.json'),'utf8'));}
async function inspect(name){const r=await execute('docker',['inspect',name]);assert.equal(r.code,0);return JSON.parse(r.stdout.toString())[0];}
async function readManifest(job){return artifact(job.manifest_sha256);}
const tests=[];let orphan,foreign;
await mkdir(evidencePath,{recursive:true,mode:0o700});
try{
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.intake_jobs')).rows[0].n,0);
  // A candidate cannot silently register/publish a map release even when the registry exists.
  await pool.query(await readFile(join(root,'packages/releases/src/schema.sql'),'utf8'));
  const initialDefault=(await pool.query('SELECT * FROM atlas_control.defaults WHERE singleton')).rows[0];
  const healthy=await accept('candidate-healthy.osm.pbf');await b('work',['--once']);
  let first=await jobFor(healthy.validation);assert.equal(first.state,'component_verified');const manifest=await readManifest(first);
  assert.equal(manifest.publishable,false);assert.equal(manifest.map_release_ready,false);assert.equal(manifest.scope,'experimental_source_only');
  assert.equal(manifest.components.routing,'missing');assert.equal(manifest.components.search,'missing');
  const rt=await artifact(manifest.qa.canonical_roundtrip);assert.equal(rt.passed,true);
  tests.push('accepted_signed_source_builds_into_a_separate_verified_readonly_component');
  const firstInfo=await inspect(manifest.serving.container),firstEndpoint='http://'+firstInfo.NetworkSettings.Networks[build.network].IPAddress+':3000';
  const tilejsonResponse=await fetch(firstEndpoint+'/basemap',{signal:AbortSignal.timeout(5000)});assert.equal(tilejsonResponse.status,200);
  const tilejson=await tilejsonResponse.json();assert.equal(tilejson.attribution,'\u00a9 OpenStreetMap contributors');
  const attempt=(await pool.query('SELECT * FROM atlas_control.candidate_attempts WHERE job_id=$1 AND token=$2',[first.id,manifest.attempt])).rows[0];
  const dir=join(build.root,'attempts',manifest.attempt),credentials=JSON.parse(await readFile(join(dir,'credentials.json'),'utf8'));
  const qaDsn=await secretFile(join(dir,'qa.dsn')),qa=new pg.Client({connectionString:qaDsn});await qa.connect();
  try{
    assert.equal((await qa.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
    await assert.rejects(qa.query("INSERT INTO osm_raw.nodes(osm_id,tags,geom) VALUES(999,'{}',ST_SetSRID(ST_Point(0,0),4326))"));
  }finally{await qa.end();}
  const tileUri=new URL(qaDsn);tileUri.username=attempt.tile_role;tileUri.password=credentials.tilePassword;
  const tile=new pg.Client({connectionString:tileUri.toString()});await tile.connect();
  try{await assert.rejects(tile.query('SELECT count(*) FROM osm_raw.nodes'));await assert.rejects(tile.query('SELECT count(*) FROM render.transport'));
    assert.ok((await tile.query('SELECT count(*) FROM tiles.transport')).rows[0]);assert.ok((await tile.query('SELECT tiles.basemap(6,32,31) AS tile')).rows[0].tile.length>=0);
    await assert.rejects(tile.query('REFRESH MATERIALIZED VIEW tiles.transport'));
    await assert.rejects(tile.query('DELETE FROM tiles.transport'));}
  finally{await tile.end();}
  const importUri=new URL(qaDsn);importUri.username=attempt.import_role;importUri.password=credentials.importPassword;
  const disabled=new pg.Client({connectionString:importUri.toString()});await assert.rejects(disabled.connect());await disabled.end().catch(()=>{});
  tests.push('importer_login_disabled_and_tile_role_cannot_read_raw_archive_or_mutate_data');
  // A second source is accepted, but not admitted while a parser owns the shared slot.
  const geometry=await accept('candidate-geometry.osm.pbf');await b('reconcile');
  const delayed=JSON.parse((await s('submit',['--file',resolve(fixturePath,'candidate-healthy.osm.pbf'),'--provider','fixture','--region','fixture','--url','https://example.org/fixture.osm.pbf'])).stdout.toString());
  await s('reconcile');const parser=await intake.claim(worker.specSha256);assert.equal(parser.id,delayed.id);
  await b('work',['--once']);assert.equal((await jobFor(geometry.validation)).state,'queued');
  await intake.fail(parser,'capacity',true);tests.push('builder_waits_for_a_live_intake_processing_slot');
  const pending=b('work',['--once']);let finished=false,error;pending.then(()=>{finished=true;},e=>{finished=true;error=e;});
  const probes=[];let checkedParser=false;
  while(!finished){
    try{const r=await fetch(firstEndpoint+'/basemap/14/8192/8191',{signal:AbortSignal.timeout(5000)});await r.arrayBuffer();probes.push(r.status);}
    catch{probes.push(0);}
    const slot=(await pool.query('SELECT * FROM atlas_control.processing_slot WHERE singleton')).rows[0];
    if(slot.holder_kind==='candidate'&&!checkedParser){
      await pool.query("UPDATE atlas_control.intake_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[delayed.id]);
      await s('work',['--once']);assert.notEqual((await intake.status()).find(x=>x.id===delayed.id).job_state,'completed');checkedParser=true;
    }
    await new Promise(r=>setTimeout(r,100));
  }
  await pending;if(error)throw error;assert.equal(checkedParser,true);assert.ok(probes.length>0);assert.ok(probes.every(x=>x===200||x===204));
  assert.equal((await inspect(manifest.serving.container)).State.StartedAt,firstInfo.State.StartedAt);
  tests.push('intake_waits_during_build_and_previous_martin_continues_serving_without_restart');
  const second=await jobFor(geometry.validation);assert.equal(second.state,'review_required');const reviewed=await readManifest(second),coverage=await artifact(reviewed.qa.feature_coverage);
  assert.deepEqual(coverage.accounting,{missing_outcomes:0,orphan_outcomes:0});
  assert.ok(coverage.outcomes.some(x=>x.status==='partial'&&x.objects>0));assert.ok(coverage.outcomes.some(x=>x.status==='geometry_rejected'&&x.objects>0));
  assert.ok(coverage.outcomes.some(x=>x.status==='catalog_policy_excluded'&&x.objects>0));
  assert.ok(coverage.outcomes.some(x=>x.status==='uncatalogued'&&x.objects>0));assert.ok(coverage.outcomes.some(x=>x.status==='metadata_only'&&x.objects>0));
  assert.ok(reviewed.qa.review_reasons.includes('geometry_conversion_issues'));
  assert.equal((await artifact(reviewed.qa.canonical_roundtrip)).passed,true);
  tests.push('partial_null_unsupported_and_metadata_outcomes_are_accounted_without_raw_data_loss');
  const detailsSource=await accept('candidate-details.osm.pbf');await b('work',['--once']);
  const detailsJob=await jobFor(detailsSource.validation);assert.equal(detailsJob.state,'review_required');const detailsManifest=await readManifest(detailsJob);
  const detailsQa=new pg.Client({connectionString:await secretFile(join(build.root,'attempts',detailsManifest.attempt,'qa.dsn'))});await detailsQa.connect();
  try{
    assert.deepEqual((await detailsQa.query("SELECT family FROM render.detail_points WHERE osm_type='N' AND osm_id=3 ORDER BY family")).rows.map(r=>r.family),['barrier','power']);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.detail_lines WHERE osm_type='W' AND osm_id=10 AND family='power'")).rows[0].n,1);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.transport WHERE osm_type='W' AND osm_id=10")).rows[0].n,1);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.detail_areas WHERE osm_id=16 AND family='transport'")).rows[0].n,1);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.landcover WHERE osm_id=17")).rows[0].n,0);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.detail_lines WHERE osm_id=17 AND family='natural'")).rows[0].n,1);
    assert.equal((await detailsQa.query("SELECT count(*)::integer n FROM render.detail_points WHERE osm_id=9")).rows[0].n,0);
    assert.equal((await detailsQa.query("SELECT detail_facets->'power'->>'status' AS status FROM render.object_outcomes WHERE osm_type='N' AND osm_id=9")).rows[0].status,'unknown_value_or_primitive');
    assert.equal((await detailsQa.query('SELECT count(*)::integer n FROM (SELECT feature_id FROM render.detail_points GROUP BY feature_id HAVING count(*)>1) d')).rows[0].n,0);
  }finally{await detailsQa.end();}
  tests.push('independent_detail_families_preserve_overlapping_features_and_reject_unknown_values_without_false_areas');
  const topoSource=await accept('candidate-topology.osm.pbf',true);await b('work',['--once']);
  const topoJob=await jobFor(topoSource.validation);assert.equal(topoJob.state,'review_required');const topoManifest=await readManifest(topoJob);
  const topoQa=new pg.Client({connectionString:await secretFile(join(build.root,'attempts',topoManifest.attempt,'qa.dsn'))});await topoQa.connect();
  try{
    assert.deepEqual((await topoQa.query('SELECT osm_id::text FROM render.boundaries ORDER BY osm_id')).rows.map(r=>r.osm_id),['31','32','33','34','35']);
    assert.deepEqual((await topoQa.query('SELECT osm_id::text FROM tiles.boundaries ORDER BY osm_id')).rows.map(r=>r.osm_id),['34','35']);
    assert.equal((await topoQa.query('SELECT count(*)::integer n FROM osm_raw.relations')).rows[0].n,5);
  }finally{await topoQa.end();}
  const topoCoverage=await artifact(topoManifest.qa.feature_coverage);assert.equal(topoCoverage.serving_integrity.blocked_rows_exposed,0);
  assert.equal(topoCoverage.serving_integrity.withheld_relations,3);assert.equal((await artifact(topoManifest.qa.canonical_roundtrip)).passed,true);
  tests.push('incomplete_and_nested_relation_fragments_are_kept_for_audit_but_withheld_from_serving_snapshots');
  // Changing both the payload and its database hash must still fail before provisioning.
  const changed=JSON.parse((await files.artifact(healthy.validation.payload_sha256)).toString());changed.tampered=true;
  const forgedSha=await files.putArtifact(Buffer.from(JSON.stringify(changed)+'\n'));
  await pool.query('UPDATE atlas_control.intake_validations SET payload_sha256=$2 WHERE id=$1',[healthy.validation.id,forgedSha]);
  await b('reconcile');
  const refused=(await queue.status()).find(x=>x.source_validation_id===healthy.validation.id&&x.payload_sha256===forgedSha);
  assert.equal(refused.state,'failed');assert.equal(refused.attempts,0);assert.equal(refused.failure_code,'cosign_verification_or_signing_failed');
  await pool.query('UPDATE atlas_control.intake_validations SET payload_sha256=$2 WHERE id=$1',[healthy.validation.id,healthy.validation.payload_sha256]);
  tests.push('cryptographically_forged_source_is_refused_before_database_allocation');
  // Expired managed importer is reaped; a valid lease and an unrelated container survive.
  const oldId=await queue.enqueue({id:healthy.validation.id,payload_sha256:healthy.validation.payload_sha256},'0'.repeat(64),{fictional_orphan_test:true});
  const old=await queue.claim('0'.repeat(64));assert.equal(old.id,oldId);
  orphan='atlas-import-'+old.id.slice(0,12)+'-'+old.token.slice(0,16);foreign='atlas-unrelated-'+randomBytes(8).toString('hex');
  const common=['run','--detach','--pull','never','--network','none','--read-only','--cap-drop','ALL','--memory','64m','--log-driver','none'];
  let r=await execute('docker',[...common,'--name',orphan,'--label',`atlas.candidate.root=${sha256(build.root)}`,'--label',`atlas.candidate.job=${old.id}`,'--label',`atlas.candidate.token=${old.token}`,'--label','atlas.candidate.kind=importer',
    '--entrypoint','python',source.worker.validatorImage,'-I','-c','import time;time.sleep(120)']);assert.equal(r.code,0);
  r=await execute('docker',[...common,'--name',foreign,'--entrypoint','python',source.worker.validatorImage,'-I','-c','import time;time.sleep(120)']);assert.equal(r.code,0);
  await b('work',['--once']);assert.equal((await execute('docker',['inspect',orphan])).code,0);
  await pool.query("UPDATE atlas_control.candidate_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
  await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE token=$1",[old.token]);
  await b('work',['--once']);assert.notEqual((await execute('docker',['inspect',orphan])).code,0);assert.equal((await execute('docker',['inspect',foreign])).code,0);
  assert.equal((await inspect(manifest.serving.container)).State.StartedAt,firstInfo.State.StartedAt);
  tests.push('expired_managed_importer_reaped_with_live_completed_and_unrelated_resources_protected');
  assert.deepEqual((await pool.query('SELECT * FROM atlas_control.defaults WHERE singleton')).rows[0],initialDefault);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.releases')).rows[0].n,0);
  tests.push('component_success_or_review_never_registers_or_publishes_a_map_release');
  for(const [name,data]of [['healthy-manifest.json',manifest],['geometry-manifest.json',reviewed],['geometry-coverage.json',coverage],['details-manifest.json',detailsManifest],['topology-manifest.json',topoManifest],['topology-coverage.json',topoCoverage],['serving-probe.json',{requests:probes.length,errors:probes.filter(s=>s!==200&&s!==204).length,statuses:probes}],
    ['e2e-report.json',{schema:'atlas.candidate-e2e/1',passed:true,tests,count:tests.length,pipeline_sha256:build.expectedPipelineSha256,tool_sha256:sha256(await readFile(new URL(import.meta.url))),fictional_data_only:true,production_publication_approved:false}]])
    await writeFile(join(evidencePath,name),JSON.stringify(data,null,2)+'\n');
  console.log(JSON.stringify({passed:true,tests,count:tests.length,serving_probe_requests:probes.length}));
}finally{
  for(const name of [orphan,foreign].filter(Boolean))await execute('docker',['rm','--force',name]).catch(()=>{});
  await pool.end();
}
