import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {IntakeQueue} from './queue.js';
import {sha256,type Submission,type Decision} from './contracts.js';

const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('durable intake on real PostgreSQL',()=>{
  const pool=new pg.Pool({connectionString,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});
  const queue=new IntakeQueue(pool,1000),spec='a'.repeat(64);
  const manifest=():Submission=>({schema:'atlas.submission/1',id:randomBytes(16).toString('hex'),sha256:'b'.repeat(64),bytes:1234,
    source:{provider:'geofabrik',region:'iran',url:'https://download.geofabrik.de/asia/iran-latest.osm.pbf'}});
  const decision:Decision={kind:'pass',reasons:[],snapshot:'2026-10-25T21:21:21Z',counts:{node:10,way:2,relation:1},baselineId:null};
  const register=async(m=manifest())=>{await queue.register(m,sha256(JSON.stringify(m)),spec);return m;};
  beforeAll(async()=>{
    const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    if(!String(db).startsWith('atlas_test'))throw new Error('test suite requires a disposable atlas_test* database');
    await pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  });
  beforeEach(async()=>{await pool.query('UPDATE atlas_control.processing_slot SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL');await pool.query(`TRUNCATE atlas_control.intake_events,atlas_control.intake_reviews,atlas_control.intake_baselines,
    atlas_control.intake_attempts,atlas_control.intake_jobs,atlas_control.intake_validations,atlas_control.intake_delivery_rejections CASCADE`);});
  afterAll(()=>pool.end());
  it('admits a delivery once and serializes competing coordinators into one heavy worker',async()=>{
    const m=await register();expect(await queue.register(m,sha256(JSON.stringify(m)),spec)).toBe(false);
    await register();
    const results=await Promise.all([queue.claim(spec),queue.claim(spec),queue.claim(spec)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(queue.register(m,'c'.repeat(64),spec)).rejects.toMatchObject({code:'delivery_changed'});
  });
  it('recovers a verified blob after lease loss and fences every write by the obsolete attempt',async()=>{
    await register();const old=(await queue.claim(spec))!;
    await queue.markBlobVerified(old);const initial=await queue.beginValidation(old);
    await pool.query("UPDATE atlas_control.intake_jobs SET lease_until=clock_timestamp()-interval '1 second'");
    await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second'");
    expect(await queue.claim(spec)).toBeNull();
    await queue.releaseExpiredSlot();
    await pool.query("UPDATE atlas_control.intake_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");
    const fresh=(await queue.claim(spec))!;expect(fresh.token).not.toBe(old.token);expect(fresh.blobVerified).toBe(true);
    await expect(queue.heartbeat(old)).rejects.toMatchObject({code:'lease_lost'});
    await expect(queue.completeValidation(old,initial.validation.id,'d'.repeat(64),decision)).rejects.toMatchObject({code:'lease_lost'});
    const resumed=await queue.beginValidation(fresh);
    expect(resumed.validation.id).toBe(initial.validation.id);
    await queue.completeValidation(fresh,resumed.validation.id,'d'.repeat(64),decision);
  });
  it('reuses identical verified input but separates different provenance statements',async()=>{
    await register();const first=(await queue.claim(spec))!;const v=await queue.beginValidation(first);
    await queue.completeValidation(first,v.validation.id,'d'.repeat(64),decision);
    await register();const second=(await queue.claim(spec))!;const duplicate=await queue.beginValidation(second);
    expect(duplicate.reused).toBe(true);expect(duplicate.validation.id).toBe(v.validation.id);
    const other=manifest();other.source.url='https://other.example/map.osm.pbf';await register(other);
    const third=(await queue.claim(spec))!;const distinct=await queue.beginValidation(third);
    expect(distinct.reused).toBe(false);expect(distinct.validation.id).not.toBe(v.validation.id);
  });
  it('does not let an operator approve a hard rejection or a stale decision',async()=>{
    await register();const claim=(await queue.claim(spec))!;const v=await queue.beginValidation(claim);
    const hard={...decision,kind:'reject' as const,reasons:['missing_way_nodes']};
    await queue.completeValidation(claim,v.validation.id,'d'.repeat(64),hard);
    await expect(queue.review(v.validation.id,'d'.repeat(64),sha256(JSON.stringify(hard)),'approve','operator','Intentional test approval')).rejects.toMatchObject({code:'stale_or_forbidden_review'});
  });
  it('binds human review to the exact report and decision before entering signing',async()=>{
    await register();const claim=(await queue.claim(spec))!;const v=await queue.beginValidation(claim);
    const review={...decision,kind:'review' as const,reasons:['initial_baseline_required']};
    await queue.completeValidation(claim,v.validation.id,'d'.repeat(64),review);
    expect(await queue.claimSigning(spec)).toBeNull();
    await expect(queue.review(v.validation.id,'d'.repeat(64),'e'.repeat(64),'approve','operator','Expected report reviewed')).rejects.toMatchObject({code:'stale_or_forbidden_review'});
    await queue.review(v.validation.id,'d'.repeat(64),sha256(JSON.stringify(review)),'approve','operator','Expected report reviewed');
    expect(await queue.approvedReview(v.validation.id,sha256(JSON.stringify(review)),'d'.repeat(64))).not.toBeNull();
    expect(await queue.approvedReview(v.validation.id,sha256(JSON.stringify(review)),'e'.repeat(64))).toBeNull();
    expect((await queue.claimSigning(spec))?.id).toBe(v.validation.id);
  });
  it('fails closed on an expired signer and does not use capacity shortage to discard the input',async()=>{
    await register();const c=(await queue.claim(spec))!;await queue.fail(c,'capacity',true);
    expect((await queue.status() as {failures:number;job_state:string}[])[0]).toMatchObject({failures:0,job_state:'retry_wait'});
    await pool.query("UPDATE atlas_control.intake_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'");
    const fresh=(await queue.claim(spec))!,v=await queue.beginValidation(fresh);
    await queue.completeValidation(fresh,v.validation.id,'d'.repeat(64),decision);
    const signer=(await queue.claimSigning(spec))!;
    await pool.query("UPDATE atlas_control.intake_validations SET sign_lease_until=clock_timestamp()-interval '1 second'");
    await expect(queue.finishSigning(signer,'e'.repeat(64),'f'.repeat(64),'0'.repeat(64))).rejects.toMatchObject({code:'lease_lost'});
  });
  it('honors a live candidate slot and fences a parser whose slot was lost',async()=>{
    await register();
    await pool.query("UPDATE atlas_control.processing_slot SET holder_kind='candidate',job_id='test-candidate',token='candidate-token',lease_until=clock_timestamp()+interval '1 minute'");
    expect(await queue.claim(spec)).toBeNull();
    await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second'");
    expect(await queue.claim(spec)).toBeNull();await queue.releaseExpiredSlot();
    expect((await pool.query('SELECT holder_kind FROM atlas_control.processing_slot')).rows[0].holder_kind).toBe('candidate');
    await pool.query('UPDATE atlas_control.processing_slot SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL');
    const claim=(await queue.claim(spec))!;expect(claim).not.toBeNull();
    await pool.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await expect(queue.heartbeat(claim)).rejects.toMatchObject({code:'lease_lost'});
    expect(await queue.tokenLive(claim.id,claim.token)).toBe(false);
  });
});
