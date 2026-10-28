// Offline integrity/accounting check; this does not establish geographic truth or publisher trust.
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]??'docs/evidence/2026-10-28-candidates');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async name=>{const bytes=await readFile(join(root,name));return JSON.parse(name.endsWith('.gz')?gunzipSync(bytes):bytes);};
const listed=new Set();
for(const line of (await readFile(join(root,'SHA256SUMS'),'utf8')).trim().split('\n')){
 const match=/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);assert.ok(match,'invalid checksum record');
 assert.ok(!listed.has(match[2]));listed.add(match[2]);assert.equal(digest(await readFile(join(root,match[2]))),match[1]);
}
assert.deepEqual([...listed].sort(),(await readdir(root)).filter(n=>n!=='SHA256SUMS').sort());
const {job,attempts}=await json('iran-job.json'),manifestBytes=await readFile(join(root,'iran-manifest.json'));
assert.equal(digest(manifestBytes),job.manifest_sha256,'manifest must match the terminal control record');
assert.ok(['component_verified','review_required'].includes(job.state));
const m=JSON.parse(manifestBytes),attempt=attempts.find(a=>a.token===m.attempt);
const sourceBytes=await readFile(join(root,'iran-source-acceptance.json'));
assert.equal(digest(sourceBytes),m.source.payload_sha256);
assert.equal(digest(await readFile(join(root,'iran-source-bundle.sigstore.json'))),m.source.bundle_sha256);
assert.equal(digest(await readFile(join(root,'lab-source-public-key.pub'))),m.source.public_key_sha256);
const acceptance=JSON.parse(sourceBytes);
assert.equal(acceptance.usage_scope,'experimental_source_only');assert.equal(acceptance.subject.sha256,m.source.sha256);
assert.equal(digest(await readFile(join(root,'iran-intake-audit.json'))),acceptance.report_sha256);
assert.equal(attempt?.state,'completed');
assert.equal(m.scope,'experimental_source_only');assert.equal(m.publishable,false);assert.equal(m.map_release_ready,false);
assert.equal(m.source.validation_id,job.source_validation_id);assert.equal(m.source.payload_sha256,job.payload_sha256);
assert.equal(m.pipeline_sha256,job.pipeline_sha256);assert.equal(digest(JSON.stringify(m.specification)),m.pipeline_sha256);
assert.deepEqual(m.postgis.target,attempt.data_target);
assert.equal(m.postgis.database,attempt.database_name);assert.equal(m.postgis.read_only,true);
assert.deepEqual(m.serving.public_ports,[]);
for(const name of ['search','routing','poi','assets'])assert.equal(m.components[name],'missing');
const reports={};
for(const [key,name]of Object.entries({canonical_roundtrip:'raw-roundtrip',feature_coverage:'feature-coverage',tile_parity:'tile-parity'})){
  const bytes=await readFile(join(root,'iran-'+name+'.json'));assert.equal(digest(bytes),m.qa[key]);reports[name]=JSON.parse(bytes);
}
const raw=reports['raw-roundtrip'],coverage=reports['feature-coverage'],tiles=reports['tile-parity'];
const audit=await json('iran-intake-audit.json');
assert.equal(raw.source_sha256,m.source.sha256);assert.equal(raw.passed,true);
assert.equal(audit.source.sha256,m.source.sha256);
for(const [kind,r]of Object.entries(raw.results)){
 assert.equal(r.count_matches,true);assert.equal(r.digest_matches,true);assert.equal(r.count,audit.counts[kind]);assert.equal(r.sha256,audit.semantic_digest[kind]);
}
assert.equal(coverage.source_sha256,m.source.sha256);assert.equal(coverage.accounting.missing_outcomes,0);assert.equal(coverage.accounting.orphan_outcomes,0);
assert.equal(coverage.geographic_truth_verified,false);
assert.ok(!coverage.outcomes.some(r=>r.status==='unaccounted'&&r.objects>0));
assert.equal(coverage.incomplete_relations.reduce((n,r)=>n+r.missing_references,0),
 Object.entries(audit.references.missing).filter(([k])=>k.startsWith('relation_to_')).reduce((n,[,v])=>n+v,0));
for(const r of Object.values(coverage.layers)){assert.equal(r.invalid_geometries,0);assert.equal(r.empty_geometries,0);assert.equal(r.rows,r.observed_inserts);}
assert.ok(tiles.samples.length>0&&tiles.samples.every(s=>s.parity));
assert.equal(job.state,m.qa.review_reasons.length?'review_required':'component_verified');
assert.equal((await json('fixture-builder-e2e-report.json')).passed,true);
assert.equal((await json('fixture-intake-e2e-report.json')).passed,true);
assert.equal((await json('cancellation-baseline.json')).backend_present_after_client_end,true);
assert.equal((await json('cancellation-check.json')).passed,true);
const probe=await json('isolated-serving-probe.json.gz');
const summary=await json('verification-summary.json');
for(const name of ['isolated-serving-probe.json','rejected-shared-cluster-serving-probe.json']){
 const compressed=await readFile(join(root,name+'.gz'));
 assert.equal(digest(compressed),summary.probe_files[name].gzip_sha256);
 assert.equal(digest(gunzipSync(compressed)),summary.probe_files[name].uncompressed_sha256);
}
assert.equal(probe.job_id,job.id);assert.equal(probe.errors,0);assert.equal(probe.guard_stopped_experimental_builder,false);
assert.equal(probe.old_container_ids_and_start_times_unchanged,true);assert.equal(probe.byte_change_observations,0);
assert.equal(probe.samples.length,probe.requests);assert.equal(tiles.passed,true);
const baseline=await json('same-input-tile-parity.json');
assert.equal(baseline.passed,true);assert.ok(baseline.samples.every(s=>s.parity&&s.decoded.baseline));
const rejected=await json('rejected-shared-cluster-serving-probe.json.gz'),rejectedJob=await json('rejected-shared-cluster-job.json');
assert.ok(rejected.errors>0);assert.equal(rejectedJob.job.state,'failed');assert.equal(rejectedJob.job.manifest_sha256,null);
console.log(JSON.stringify({passed:true,scope:'offline evidence integrity and recorded checks; no production approval',
  job_id:job.id,state:job.state,raw_objects:Object.values(raw.results).reduce((n,r)=>n+r.count,0),
  tagged_outcomes:coverage.outcomes.reduce((n,r)=>n+r.objects,0),serving_requests:probe.requests,review_reasons:m.qa.review_reasons},null,2));
