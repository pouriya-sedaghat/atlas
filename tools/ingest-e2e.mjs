// Fault injection is restricted to an explicitly disposable database and fictional PBFs.
import {readFile,writeFile,chmod,unlink,symlink,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadConfig,secretFile} from '../apps/ingest/dist/config.js';
import {IntakeFiles} from '../apps/ingest/dist/files.js';
import {IntakeQueue} from '../apps/ingest/dist/queue.js';
import {DockerValidator,IntakeWorker} from '../apps/ingest/dist/worker.js';
import {execute} from '../apps/ingest/dist/process.js';
import {sha256} from '../apps/ingest/dist/contracts.js';

const[configPath,fixtureDirectory,evidenceDirectory,previousCollectorRoot]=process.argv.slice(2);
if(!configPath||!fixtureDirectory||!evidenceDirectory)throw new Error('usage: ingest-e2e.mjs CONFIG FIXTURES EVIDENCE');
const config=await loadConfig(configPath),repo=fileURLToPath(new URL('..',import.meta.url));
const pool=new pg.Pool({connectionString:await secretFile(config.dsnFiles.admin),max:4,connectionTimeoutMillis:5000});
const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
if(!/^atlas_test_ingest_e2e_[0-9a-f]{8}$/.test(database))throw new Error('E2E requires its own disposable atlas_test_ingest_e2e_<nonce> database');
const queue=new IntakeQueue(pool),files=new IntakeFiles(config.root,config.python),validator=new DockerValidator(files,config.worker);
const worker=new IntakeWorker(files,queue,config.policy,config.worker,validator);
const cli=fileURLToPath(new URL('../apps/ingest/dist/cli.js',import.meta.url));
async function command(name,args=[],expectFailure=false){
  const result=await execute(process.execPath,[cli,name,'--config',configPath,...args],{timeoutMs:60000,cwd:repo,maxOutput:2*1024*1024});
  if(expectFailure)assert.notEqual(result.code,0,`${name} should fail`);
  else assert.equal(result.code,0,`${name}: ${result.stderr}`);
  return result;
}
async function status(job){return(await queue.status()).find(r=>r.id===job);}
async function submit(filename){
  const r=await command('submit',['--file',resolve(fixtureDirectory,filename),'--provider','fixture','--region','fixture','--url','https://example.org/fixture.osm.pbf']);
  return JSON.parse(r.stdout.toString());
}
const tests=[];let foreignName,orphanName;
await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
try{
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.intake_jobs')).rows[0].n,0,'fresh database required');
  const healthy=await submit('conformance.osm.pbf');await command('work',['--once']);
  let row=await status(healthy.id);assert.equal(row.validation_state,'signing_pending');
  await command('sign',['--once']);row=await status(healthy.id);assert.equal(row.validation_state,'accepted');
  await command('verify-receipt',['--validation',row.validation_id]);
  tests.push('ordinary_input_automatically_validated_signed_and_verified');
  const accepted=await queue.validation(row.validation_id);
  assert.equal(JSON.parse((await files.artifact(accepted.payload_sha256)).toString()).usage_scope,'experimental_source_only');
  for(const[field,name]of [['report_sha256','fixture-audit.json'],['payload_sha256','fixture-receipt.json'],['bundle_sha256','fixture-bundle.sigstore.json']])
    await writeFile(join(evidenceDirectory,name),await files.artifact(accepted[field]));
  await writeFile(join(evidenceDirectory,'fixture-public-key.pub'),await readFile(config.signer.publicKey));
  const duplicate=await submit('conformance.osm.pbf');await command('work',['--once']);
  assert.equal((await status(duplicate.id)).validation_id,accepted.id);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.intake_events WHERE event=$1',['validation_reused'])).rows[0].n,1);
  assert.equal(existsSync(join(config.root,'incoming',duplicate.id,'input.osm.pbf')),false);
  tests.push('duplicate_bytes_reuse_receipt_and_delivery_copy_is_consumed');
  const bad=await submit('missing-way-node.osm.pbf');await command('work',['--once']);
  const hard=await status(bad.id);assert.equal(hard.validation_state,'rejected');
  await command('review',['--validation',hard.validation_id,'--report-sha',hard.report_sha256,'--decision-sha',hard.decision_sha256,'--action','approve','--actor','e2e-test-operator','--reason','Fictional hard failure must not be approved'],true);
  tests.push('missing_way_nodes_are_rejected_and_cannot_be_overridden');
  const malformed=await submit('malformed.osm.pbf');await command('work',['--once']);
  assert.equal((await status(malformed.id)).validation_state,'rejected');
  tests.push('malformed_pbf_rejected_without_signing');
  const anomaly=await submit('missing-relation-member.osm.pbf');await command('work',['--once']);
  const review=await status(anomaly.id);assert.equal(review.validation_state,'review_required');
  await command('sign',['--once']);assert.equal((await status(anomaly.id)).validation_state,'review_required');
  const reviewArgs=['--validation',review.validation_id,'--report-sha',review.report_sha256,'--decision-sha',review.decision_sha256,'--action','approve','--actor','e2e-test-operator','--reason','Only this fictional anomaly is approved for a test'];
  await command('review',reviewArgs.map(v=>v===review.decision_sha256?'0'.repeat(64):v),true);
  await command('review',reviewArgs);await command('sign',['--once']);
  assert.equal((await status(anomaly.id)).validation_state,'accepted');
  tests.push('anomaly_waits_for_exact_report_and_decision_review');
  const canary=join(evidenceDirectory,'canary.txt');await writeFile(canary,'Fictional outside target must stay unchanged');
  const linked=await submit('conformance.osm.pbf'),link=join(config.root,'incoming',linked.id,'input.osm.pbf');
  await unlink(link);await symlink(canary,link);await command('work',['--once']);
  assert.equal((await status(linked.id)).job_state,'not_admitted');
  assert.equal(await readFile(canary,'utf8'),'Fictional outside target must stay unchanged');
  tests.push('symlink_escape_refused_and_canary_untouched');
  // Change both bytes and the database hash reference: the old signature still must fail.
  const original=await files.artifact(accepted.payload_sha256),tampered=JSON.parse(original.toString());tampered.tampered=true;
  const tamperedSha=await files.putArtifact(Buffer.from(JSON.stringify(tampered)+'\n'));
  await pool.query('UPDATE atlas_control.intake_validations SET payload_sha256=$2 WHERE id=$1',[accepted.id,tamperedSha]);
  const failure=await command('verify-receipt',['--validation',accepted.id],true);
  assert.match(failure.stderr.toString(),/cosign_verification_or_signing_failed/);
  await pool.query('UPDATE atlas_control.intake_validations SET payload_sha256=$2 WHERE id=$1',[accepted.id,accepted.payload_sha256]);
  tests.push('cryptographic_verification_rejects_referenced_payload_tampering');
  // The worker role must not manufacture a review or an accepted receipt.
  const restricted=new pg.Client({connectionString:await secretFile(config.dsnFiles.worker)});await restricted.connect();
  try{
    await assert.rejects(restricted.query('UPDATE atlas_control.intake_validations SET payload_sha256=$2 WHERE id=$1',[accepted.id,'f'.repeat(64)]));
    await assert.rejects(restricted.query("INSERT INTO atlas_control.intake_reviews(validation_id,report_sha256,decision_sha256,action,actor,rationale) VALUES($1,$2,$3,'approve','forbidden','forbidden fixture change')",[accepted.id,accepted.report_sha256,accepted.decision_sha256]));
  }finally{await restricted.end();}
  tests.push('worker_database_role_cannot_approve_or_forge_receipt_fields');
  if(previousCollectorRoot){
    const previous=JSON.parse(await readFile(join(previousCollectorRoot,'apps/ingest/dist/build-id.json'),'utf8'));
    assert.notEqual(previous.sha256,config.worker.controllerSha256);
    assert.ok(config.signer.trustedCollectorBuilds.includes(previous.sha256),'explicit operator trust required');
    const previousConfig=JSON.parse(await readFile(configPath,'utf8'));
    previousConfig.worker.controllerSha256=previous.sha256;
    const previousConfigPath=join(evidenceDirectory,'private-previous-config.json');
    await writeFile(previousConfigPath,JSON.stringify(previousConfig),{mode:0o600});
    const previousCli=join(previousCollectorRoot,'apps/ingest/dist/cli.js');
    const legacySubmit=await execute(process.execPath,[previousCli,'submit','--config',previousConfigPath,'--file',resolve(fixtureDirectory,'conformance.osm.pbf'),
      '--provider','fixture','--region','fixture','--url','https://example.org/fixture.osm.pbf']);
    assert.equal(legacySubmit.code,0,legacySubmit.stderr.toString());const legacy=JSON.parse(legacySubmit.stdout.toString());
    const legacyWork=await execute(process.execPath,[previousCli,'work','--once','--config',previousConfigPath],{timeoutMs:60000});
    assert.equal(legacyWork.code,0,legacyWork.stderr.toString());assert.equal((await status(legacy.id)).validation_state,'signing_pending');
    const untrustedConfig=JSON.parse(await readFile(configPath,'utf8'));untrustedConfig.signer.trustedCollectorBuilds=[config.worker.controllerSha256];
    const untrustedPath=join(evidenceDirectory,'private-untrusted-config.json');await writeFile(untrustedPath,JSON.stringify(untrustedConfig),{mode:0o600});
    const ignored=await execute(process.execPath,[cli,'sign','--once','--config',untrustedPath]);assert.equal(ignored.code,0);
    assert.equal((await status(legacy.id)).validation_state,'signing_pending','untrusted old collector cannot sign');
    await command('sign',['--once']);const legacyAccepted=await status(legacy.id);assert.equal(legacyAccepted.validation_state,'accepted');
    await command('verify-receipt',['--validation',legacyAccepted.validation_id]);
    const legacyValidation=await queue.validation(legacyAccepted.validation_id),receipt=JSON.parse((await files.artifact(legacyValidation.payload_sha256)).toString());
    assert.equal(receipt.processing.collector_build_sha256,previous.sha256);
    assert.equal(receipt.processing.signer_build_sha256,config.worker.controllerSha256);
    await writeFile(join(evidenceDirectory,'previous-collector-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    tests.push('previous_collector_requires_explicit_trust_and_retains_distinct_signed_lineage');
  }
  const pending=await submit('conformance.osm.pbf');await command('reconcile');const old=await queue.claim(worker.specSha256);assert.equal(old.id,pending.id);
  orphanName=validator.name(old);foreignName=`unrelated-intake-fixture-${randomBytes(8).toString('hex')}`;
  const common=['run','--detach','--pull','never','--network','none','--log-driver','none','--memory','64m','--read-only','--cap-drop','ALL'];
  const orphan=await execute('docker',[...common,'--name',orphanName,'--label',`atlas.intake.root=${sha256(config.root)}`,'--label',`atlas.intake.job=${old.id}`,'--label',`atlas.intake.token=${old.token}`,'--entrypoint','python',config.worker.validatorImage,'-I','-c','import time; time.sleep(120)']);assert.equal(orphan.code,0);
  const foreign=await execute('docker',[...common,'--name',foreignName,'--entrypoint','python',config.worker.validatorImage,'-I','-c','import time; time.sleep(120)']);assert.equal(foreign.code,0);
  const deferred=await submit('conformance.osm.pbf');await command('reconcile');assert.equal((await status(deferred.id)).job_state,'queued');
  tests.push('reconciliation_registers_new_delivery_during_an_active_lease');
  await command('work',['--once']);assert.equal((await execute('docker',['inspect',orphanName])).code,0,'valid lease protected');
  await pool.query("UPDATE atlas_control.intake_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
  await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE holder_kind='intake' AND job_id=$1",[old.id]);
  await command('work',['--once']);assert.notEqual((await execute('docker',['inspect',orphanName])).code,0,'expired managed attempt removed');
  assert.equal((await execute('docker',['inspect',foreignName])).code,0,'unrelated container retained');
  tests.push('expired_container_reaped_while_live_and_unrelated_containers_are_protected');
  const report={schema:'atlas.intake-e2e/1',passed:true,tests,counts:tests.length,controller_sha256:config.worker.controllerSha256,
    validator_image:config.worker.validatorImage,cosign_binary_sha256:config.signer.binarySha256,public_key_sha256:config.signer.publicKeySha256,
    fictional_data_only:true,production_publication_approved:false};
  await writeFile(join(evidenceDirectory,'e2e-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
  for(const name of [orphanName,foreignName].filter(Boolean))await execute('docker',['rm','--force',name]).catch(()=>undefined);
  await pool.end();
}
