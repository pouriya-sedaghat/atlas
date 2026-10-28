import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {IntakeQueue} from '@atlas/ingest/queue';
import {sha256,type Submission} from '@atlas/ingest/contracts';
import {BuildQueue} from './queue.js';
const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('candidate transactions and shared admission',()=>{
  const pool=new pg.Pool({connectionString,max:8,connectionTimeoutMillis:5000}),queue=new BuildQueue(pool,1000),intake=new IntakeQueue(pool,1000);
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
});
