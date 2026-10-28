import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {IntakeQueue} from '@atlas/ingest/queue';
import {sha256,type Submission} from '@atlas/ingest/contracts';
import {BuildQueue} from './queue.js';
const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('candidate transactions and shared admission',()=>{
  // Expiry cases set the database deadline explicitly; unrelated I/O must not expire a one-second fixture lease.
  const pool=new pg.Pool({connectionString,max:8,connectionTimeoutMillis:5000}),queue=new BuildQueue(pool,10000),intake=new IntakeQueue(pool,10000);
  const pipeline='a'.repeat(64),payload='b'.repeat(64);let sourceId:string;
  const spec={schema:'test-only'};
  beforeAll(async()=>{
    const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;if(!String(name).startsWith('atlas_test'))throw new Error('disposable atlas_test database required');
    await pool.query(readFileSync(new URL('../../ingest/src/schema.sql',import.meta.url),'utf8'));
    if(!(await pool.query("SELECT FROM pg_roles WHERE rolname='atlas_candidate_controller'")).rowCount)await pool.query('CREATE ROLE atlas_candidate_controller NOLOGIN NOSUPERUSER');
    await pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE atlas_control.candidate_events,atlas_control.candidate_attempts,atlas_control.candidate_jobs,atlas_control.intake_jobs,atlas_control.intake_validations CASCADE');
    await pool.query('UPDATE atlas_control.processing_slot SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL');
    sourceId=randomBytes(16).toString('hex');
    await pool.query(`INSERT INTO atlas_control.intake_validations(id,source_sha256,source_bytes,spec_sha256,provenance_sha256,region,manifest,state,payload_sha256,bundle_sha256,public_key_sha256)
      VALUES($1,$2,100,$3,$3,'fixture','{}','accepted',$4,$3,$3)`,[sourceId,'d'.repeat(64),pipeline,payload]);
  });
  afterAll(()=>pool.end());
  const enqueue=()=>queue.enqueue({id:sourceId,payload_sha256:payload},pipeline,spec);
  it('deduplicates a receipt/specification and serializes competing builders',async()=>{
    const first=await enqueue();expect(await enqueue()).toBe(first);
    const claims=await Promise.all([queue.claim(pipeline),queue.claim(pipeline),queue.claim(pipeline)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.database_name).toMatch(/^atlas_candidate_[0-9a-f]{24}_[0-9a-f]{16}$/);
  });
  it('holds a builder while intake owns the slot and holds intake while a builder owns it',async()=>{
    await enqueue();const manifest:Submission={schema:'atlas.submission/1',id:randomBytes(16).toString('hex'),sha256:'f'.repeat(64),bytes:100,source:{provider:'fixture',region:'fixture',url:'https://example.org/fixture.osm.pbf'}};
    await intake.register(manifest,sha256(JSON.stringify(manifest)),pipeline);const parser=(await intake.claim(pipeline))!;
    expect(await queue.claim(pipeline)).toBeNull();await intake.fail(parser,'capacity',true);
    const builder=(await queue.claim(pipeline))!;expect(builder).not.toBeNull();
    await pool.query("UPDATE atlas_control.intake_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");
    expect(await intake.claim(pipeline)).toBeNull();await queue.finish(builder,'e'.repeat(64),false);
    expect(await intake.claim(pipeline)).not.toBeNull();
  });
  it('fences an expired attempt and gives its retry a different database and identities',async()=>{
    await enqueue();const old=(await queue.claim(pipeline))!;
    await pool.query("UPDATE atlas_control.candidate_jobs SET lease_until=clock_timestamp()-interval '1 second'");
    await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second'");
    expect(await queue.claim(pipeline)).toBeNull();
    await queue.releaseExpiredSlot();
    await pool.query("UPDATE atlas_control.candidate_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");
    const fresh=(await queue.claim(pipeline))!;expect(fresh.token).not.toBe(old.token);expect(fresh.database_name).not.toBe(old.database_name);
    await expect(queue.finish(old,'e'.repeat(64),false)).rejects.toMatchObject({code:'lease_lost'});
    await expect(queue.stage(old,'seal')).rejects.toMatchObject({code:'lease_lost'});
    await queue.finish(fresh,'f'.repeat(64),true);expect(await queue.resourceKept(fresh.id,fresh.token)).toBe(true);
    expect(await queue.resourceKept(old.id,old.token)).toBe(false);
  });
  it('does not consume a failure budget for disk pressure and rejects a changed receipt',async()=>{
    await enqueue();const claim=(await queue.claim(pipeline))!;await queue.fail(claim,'capacity');
    expect((await queue.status() as any[])[0]).toMatchObject({state:'retry_wait',failures:0});
    await expect(queue.enqueue({id:sourceId,payload_sha256:'c'.repeat(64)},pipeline,spec)).rejects.toMatchObject({code:'source_acceptance_changed'});
  });
  it('records capacity wait without allocating attempts, database names or a processing slot',async()=>{
    await enqueue();await queue.waitCapacity(pipeline);
    expect((await queue.status() as any[])[0]).toMatchObject({state:'queued',stage:'capacity_wait',attempts:0,failures:0});
    expect((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.candidate_attempts')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT holder_kind FROM atlas_control.processing_slot WHERE singleton')).rows[0].holder_kind).toBeNull();
    expect(await queue.claim(pipeline)).toBeNull();
  });
  const root='1'.repeat(64),observation={at:'2026-10-28T20:00:00.000Z',site:'ahvaz',z:16,x:41627,y:26759,status:0,ms:5001};
  const witness={unit_stopped:true,containers_stopped:true,backends_stopped:true,roles_disabled:true};
  it('durably fences the failed attempt and keeps admission held across restart and lease expiry',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;
    const incident=await queue.latchServingGuard(root,pipeline,id,claim.token,observation);
    expect((await queue.status() as any[])[0]).toMatchObject({state:'failed',stage:'guard_stopping',failures:1,attempts:1});
    await expect(queue.finish(claim,'e'.repeat(64),false)).rejects.toMatchObject({code:'lease_lost'});
    await expect(queue.heartbeat(claim)).rejects.toMatchObject({code:'lease_lost'});
    const restarted=new BuildQueue(pool,1000);expect((await restarted.servingGuard(incident.id,root,pipeline)).evidence_sha256).toBe(incident.evidence_sha256);
    // Even a changed clock/finite stale lease cannot bypass an unresolved guard.
    await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 day'");
    await restarted.releaseExpiredSlot();await intake.releaseExpiredSlot();expect(await restarted.claim(pipeline)).toBeNull();
    expect((await pool.query('SELECT token FROM atlas_control.processing_slot')).rows[0].token).toBe(claim.token);
  });
  it('records one incident and one failure on duplicate concurrent delivery',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;
    const results=await Promise.all([1,2,3].map(()=>queue.latchServingGuard(root,pipeline,id,claim.token,observation)));
    expect(new Set(results.map(r=>r.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.candidate_guard_incidents')).rows[0].n).toBe(1);
    expect((await queue.status() as any[])[0].failures).toBe(1);
    await expect(queue.latchServingGuard(root,pipeline,id,claim.token,{...observation,ms:6000})).rejects.toMatchObject({code:'guard_evidence_changed'});
  });
  it('refuses stale authority after a replacement attempt is claimed',async()=>{
    await queue.bind(root,true);const id=await enqueue(),old=(await queue.claim(pipeline))!;
    await pool.query("UPDATE atlas_control.candidate_jobs SET lease_until=clock_timestamp()-interval '1 second'; UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await queue.claim(pipeline);await queue.releaseExpiredSlot();await pool.query("UPDATE atlas_control.candidate_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");
    const fresh=(await queue.claim(pipeline))!;
    await expect(queue.latchServingGuard(root,pipeline,id,old.token,observation)).rejects.toMatchObject({code:'lease_lost'});
    expect(await queue.tokenLive(fresh.id,fresh.token)).toBe(true);
    expect((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.candidate_guard_incidents')).rows[0].n).toBe(0);
  });
  it('requires matching root/pipeline and an actual failing observation',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;
    await expect(queue.latchServingGuard('2'.repeat(64),pipeline,id,claim.token,observation)).rejects.toMatchObject({code:'candidate_root_binding_mismatch'});
    await expect(queue.latchServingGuard(root,'2'.repeat(64),id,claim.token,observation)).rejects.toMatchObject({code:'lease_lost'});
    await expect(queue.latchServingGuard(root,pipeline,id,claim.token,{...observation,status:200})).rejects.toMatchObject({code:'invalid_guard_observation'});
    await expect(queue.latchServingGuard(root,pipeline,id,claim.token,{...observation,status:99})).rejects.toMatchObject({code:'invalid_guard_observation'});
    expect(await queue.tokenLive(id,claim.token)).toBe(true);await queue.finish(claim,'e'.repeat(64),false);
    await expect(queue.latchServingGuard(root,pipeline,id,claim.token,observation)).rejects.toMatchObject({code:'lease_lost'});
  });
  it('releases only a verified incident and never requeues it or releases a later owner',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;
    const incident=await queue.latchServingGuard(root,pipeline,id,claim.token,observation);
    await expect(queue.confirmServingGuard(incident.id,root,pipeline,{...witness,backends_stopped:false})).rejects.toMatchObject({code:'guard_shutdown_not_verified'});
    expect((await pool.query('SELECT token FROM atlas_control.processing_slot')).rows[0].token).toBe(claim.token);
    await queue.confirmServingGuard(incident.id,root,pipeline,witness);
    expect(await queue.claim(pipeline)).toBeNull();expect((await queue.status() as any[])[0]).toMatchObject({state:'failed',stage:'guard_stopped',attempts:1});
    const otherPipeline='3'.repeat(64);await queue.enqueue({id:sourceId,payload_sha256:payload},otherPipeline,spec);const next=(await queue.claim(otherPipeline))!;
    await queue.confirmServingGuard(incident.id,root,pipeline,witness);expect(await queue.tokenLive(next.id,next.token)).toBe(true);
  });
  it('serializes completion and guard commit without a published-and-failed race',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;
    const results=await Promise.allSettled([queue.finish(claim,'e'.repeat(64),false),queue.latchServingGuard(root,pipeline,id,claim.token,observation)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const status=(await queue.status() as any[])[0];
    if(status.state==='failed'){expect(status.manifest_sha256).toBeNull();expect(status.stage).toBe('guard_stopping');}
    else{expect(status.state).toBe('component_verified');expect((await pool.query('SELECT count(*)::integer AS n FROM atlas_control.candidate_guard_incidents')).rows[0].n).toBe(0);}
  });
  it('keeps ordinary shutdown retry semantics and denies controller edits to incident evidence',async()=>{
    await queue.bind(root,true);const id=await enqueue(),claim=(await queue.claim(pipeline))!;await queue.fail(claim,'cancelled',true);
    expect((await queue.status() as any[])[0].state).toBe('retry_wait');
    await pool.query("UPDATE atlas_control.candidate_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");const fresh=(await queue.claim(pipeline))!;
    const incident=await queue.latchServingGuard(root,pipeline,id,fresh.token,observation),client=await pool.connect();
    try{await client.query('SET ROLE atlas_candidate_controller');await expect(client.query('UPDATE atlas_control.candidate_guard_incidents SET evidence_text=$1 WHERE id=$2',['{}',incident.id])).rejects.toMatchObject({code:'42501'});}
    finally{await client.query('RESET ROLE');client.release();}
  });
});
