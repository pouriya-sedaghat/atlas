import {randomBytes} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {hash,id,IntakeError,sha256,text,type Baseline,type Decision,type Submission} from './contracts.js';

const LOCK=70620528;
const nonce=()=>randomBytes(16).toString('hex');
export interface Claim {id:string;token:string;manifest:Submission;manifestSha256:string;specSha256:string;attempt:number;blobVerified:boolean;}
export interface Validation {
  id:string;source_sha256:string;source_bytes:string;spec_sha256:string;region:string;manifest:Submission;
  state:string;report_sha256:string|null;decision:Decision|null;decision_sha256:string|null;baseline_id:string|null;
  validated_at:Date|null;sign_token:string|null;payload_sha256:string|null;bundle_sha256:string|null;public_key_sha256:string|null;
}
export class LeaseLost extends IntakeError {constructor(){super('lease_lost');}}
export class IntakeQueue {
  constructor(private readonly pool:Pool,readonly leaseMs=90_000,readonly maxFailures=3){
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000||!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>10)throw new IntakeError('invalid_queue_limits');
  }
  private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
    const c=await this.pool.connect();
    try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s'");await c.query("SET LOCAL lock_timeout='3s'");
      await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);const result=await fn(c);await c.query('COMMIT');return result;
    }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}finally{c.release();}
  }
  private async event(c:PoolClient,event:string,jobId:string|null,validationId:string|null,detail:unknown={}):Promise<void>{
    await c.query('INSERT INTO atlas_control.intake_events(event,job_id,validation_id,detail) VALUES($1,$2,$3,$4)',[event,jobId,validationId,JSON.stringify(detail)]);
  }
  private async live(c:PoolClient,claim:Claim):Promise<void>{
    const r=await c.query("SELECT id FROM atlas_control.intake_jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE",[claim.id,claim.token]);
    if(!r.rowCount)throw new LeaseLost();
    const slot=await c.query("SELECT 1 FROM atlas_control.processing_slot WHERE singleton AND holder_kind='intake' AND job_id=$1 AND token=$2 AND lease_until>clock_timestamp() FOR UPDATE",[claim.id,claim.token]);
    if(!slot.rowCount)throw new LeaseLost();
  }
  async bindRoot(rootSha:string):Promise<string>{
    hash(rootSha);return this.tx(async c=>{
      const row=(await c.query('SELECT id,root_sha256 FROM atlas_control.intake_instance WHERE singleton FOR UPDATE')).rows[0];
      if(row.root_sha256&&row.root_sha256!==rootSha)throw new IntakeError('database_bound_to_another_root');
      await c.query('UPDATE atlas_control.intake_instance SET root_sha256=$1 WHERE singleton',[rootSha]);return row.id;
    });
  }
  async rootBinding(rootSha:string):Promise<string>{
    const row=(await this.pool.query('SELECT id,root_sha256 FROM atlas_control.intake_instance WHERE singleton')).rows[0];
    if(!row||row.root_sha256!==rootSha)throw new IntakeError('control_root_binding_mismatch');return row.id;
  }
  async tokenLive(jobId:string,token:string):Promise<boolean>{
    return Boolean((await this.pool.query(`SELECT 1 FROM atlas_control.intake_jobs j JOIN atlas_control.processing_slot s ON s.singleton AND s.holder_kind='intake' AND s.job_id=j.id AND s.token=j.lease_token
      WHERE j.id=$1 AND j.lease_token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() AND s.lease_until>clock_timestamp()`,[jobId,token])).rowCount);
  }
  /** Called only after the intake reaper has stopped expired managed containers. */
  async releaseExpiredSlot():Promise<void>{await this.tx(async c=>{
    await c.query(`UPDATE atlas_control.processing_slot s SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL
      WHERE s.singleton AND s.holder_kind='intake' AND s.lease_until<=clock_timestamp()
      AND NOT EXISTS(SELECT FROM atlas_control.intake_jobs j WHERE j.id=s.job_id AND j.lease_token=s.token AND j.state='running' AND j.lease_until>clock_timestamp())`);
  });}
  async register(manifest:Submission,manifestSha256:string,specSha256:string):Promise<boolean>{
    hash(manifestSha256);hash(specSha256);id(manifest.id);
    return this.tx(async c=>{
      const r=await c.query('INSERT INTO atlas_control.intake_jobs(id,manifest_sha256,manifest,spec_sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
        [manifest.id,manifestSha256,JSON.stringify(manifest),specSha256]);
      if(r.rowCount){await this.event(c,'delivery_registered',manifest.id,null);return true;}
      const old=(await c.query('SELECT manifest_sha256,spec_sha256 FROM atlas_control.intake_jobs WHERE id=$1',[manifest.id])).rows[0];
      if(old.manifest_sha256!==manifestSha256||old.spec_sha256!==specSha256)throw new IntakeError('delivery_changed');
      return false;
    });
  }
  async admissionFailure(deliveryId:string,code:string):Promise<boolean>{
    id(deliveryId);if(!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(code))throw new IntakeError('invalid_failure_code');
    return this.tx(async c=>{
      const r=await c.query(`INSERT INTO atlas_control.intake_delivery_rejections(id,reason) VALUES($1,$2)
        ON CONFLICT(id) DO UPDATE SET reason=excluded.reason,recorded_at=clock_timestamp()
        WHERE intake_delivery_rejections.reason<>excluded.reason RETURNING id`,[deliveryId,code]);
      if(r.rowCount)await this.event(c,'delivery_not_admitted',deliveryId,null,{code});return Boolean(r.rowCount);
    });
  }
  async claim(specSha256:string):Promise<Claim|null>{
    hash(specSha256);
    return this.tx(async c=>{
      const expired=await c.query("SELECT id,lease_token,failures FROM atlas_control.intake_jobs WHERE state='running' AND lease_until<=clock_timestamp() LIMIT 100 FOR UPDATE");
      for(const row of expired.rows){
        await c.query("UPDATE atlas_control.intake_attempts SET state='abandoned',ended_at=clock_timestamp() WHERE token=$1 AND state='running'",[row.lease_token]);
        await c.query(`UPDATE atlas_control.intake_jobs SET state=CASE WHEN failures+1 >= $2 THEN 'failed' ELSE 'retry_wait' END,
          failures=failures+1,lease_token=NULL,lease_until=NULL,failure_code='lease_expired',
          next_attempt_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=$1`,[row.id,this.maxFailures]);
        await this.event(c,'attempt_expired',row.id,null);
      }
      // One bounded heavy worker across all coordinators sharing this database.
      if((await c.query("SELECT 1 FROM atlas_control.intake_jobs WHERE state='running' AND lease_until>clock_timestamp() LIMIT 1")).rowCount)return null;
      if((await c.query('SELECT 1 FROM atlas_control.processing_slot WHERE singleton AND holder_kind IS NOT NULL FOR UPDATE')).rowCount)return null;
      const r=await c.query(`SELECT id,manifest_sha256,manifest,spec_sha256,attempts,blob_verified FROM atlas_control.intake_jobs
        WHERE state IN ('queued','retry_wait') AND spec_sha256=$1 AND next_attempt_at<=clock_timestamp()
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[specSha256]);
      const row=r.rows[0];if(!row)return null;
      const token=nonce();
      await c.query("UPDATE atlas_control.processing_slot SET holder_kind='intake',job_id=$1,token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE singleton",[row.id,token,this.leaseMs]);
      await c.query(`UPDATE atlas_control.intake_jobs SET state='running',attempts=attempts+1,lease_token=$2,
        lease_until=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1`,[row.id,token,this.leaseMs]);
      await c.query("INSERT INTO atlas_control.intake_attempts(token,job_id,ordinal,state) VALUES($1,$2,$3,'running')",[token,row.id,row.attempts+1]);
      await this.event(c,'attempt_claimed',row.id,null,{attempt:row.attempts+1});
      return {id:row.id,token,manifest:row.manifest,manifestSha256:row.manifest_sha256,specSha256:row.spec_sha256,attempt:row.attempts+1,blobVerified:row.blob_verified};
    });
  }
  async heartbeat(claim:Claim):Promise<void>{
    await this.tx(async c=>{
      await this.live(c,claim);
      await c.query("UPDATE atlas_control.intake_jobs SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",[claim.id,this.leaseMs]);
      await c.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE singleton AND token=$1",[claim.token,this.leaseMs]);
    });
  }
  async assertLive(claim:Claim):Promise<void>{await this.tx(c=>this.live(c,claim));}
  async markBlobVerified(claim:Claim):Promise<void>{await this.tx(async c=>{await this.live(c,claim);await c.query('UPDATE atlas_control.intake_jobs SET blob_verified=true WHERE id=$1',[claim.id]);});}
  async known(ids:string[]):Promise<Set<string>>{return new Set((await this.pool.query('SELECT id FROM atlas_control.intake_jobs WHERE id=ANY($1::text[])',[ids])).rows.map(r=>r.id));}
  private async finish(c:PoolClient,claim:Claim,state:'completed'|'rejected'|'failed'|'retry_wait',code:string|null,validationId:string|null):Promise<void>{
    await c.query(`UPDATE atlas_control.intake_jobs SET state=$3,lease_token=NULL,lease_until=NULL,validation_id=$4,
      failure_code=$5,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2`,[claim.id,claim.token,state,validationId,code]);
    await c.query("UPDATE atlas_control.intake_attempts SET state=$2,ended_at=clock_timestamp() WHERE token=$1",[claim.token,state==='completed'?'completed':'failed']);
    await c.query("UPDATE atlas_control.processing_slot SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL WHERE singleton AND holder_kind='intake' AND token=$1",[claim.token]);
  }
  async fail(claim:Claim,code:string,retryable:boolean):Promise<void>{
    if(!/^[a-z][a-z0-9_]{0,79}$/.test(code))throw new IntakeError('invalid_failure_code');
    await this.tx(async c=>{
      await this.live(c,claim);
      const capacity=code==='capacity';
      const r=await c.query('UPDATE atlas_control.intake_jobs SET failures=failures+$2 WHERE id=$1 RETURNING failures',[claim.id,capacity?0:1]);
      const retry=retryable&&r.rows[0].failures<this.maxFailures;
      await c.query("UPDATE atlas_control.intake_jobs SET next_attempt_at=clock_timestamp()+$2*interval '1 second' WHERE id=$1",[claim.id,capacity?60:30*2**Math.max(0,r.rows[0].failures-1)]);
      await this.finish(c,claim,retry?'retry_wait':retryable?'failed':'rejected',code,null);
      await this.event(c,retry?'attempt_retry_scheduled':'delivery_failed',claim.id,null,{code});
    });
  }
  async beginValidation(claim:Claim):Promise<{validation:Validation;reused:boolean}>{
    return this.tx(async c=>{
      await this.live(c,claim);const validationId=nonce();
      const provenanceSha=sha256(JSON.stringify(claim.manifest.source));
      await c.query(`INSERT INTO atlas_control.intake_validations(id,source_sha256,source_bytes,spec_sha256,region,manifest,state,worker_token,provenance_sha256)
        VALUES($1,$2,$3,$4,$5,$6,'processing',$7,$8) ON CONFLICT(source_sha256,spec_sha256,provenance_sha256) DO NOTHING`,
        [validationId,claim.manifest.sha256,claim.manifest.bytes,claim.specSha256,claim.manifest.source.region,JSON.stringify(claim.manifest),claim.token,provenanceSha]);
      const v=(await c.query<Validation>('SELECT * FROM atlas_control.intake_validations WHERE source_sha256=$1 AND spec_sha256=$2 AND provenance_sha256=$3 FOR UPDATE',[claim.manifest.sha256,claim.specSha256,provenanceSha])).rows[0]!;
      if(Number(v.source_bytes)!==claim.manifest.bytes)throw new IntakeError('source_identity_conflict');
      if(v.state!=='processing'){
        await this.finish(c,claim,'completed',null,v.id);await this.event(c,'validation_reused',claim.id,v.id);return {validation:v,reused:true};
      }
      await c.query('UPDATE atlas_control.intake_validations SET worker_token=$2 WHERE id=$1',[v.id,claim.token]);
      await c.query('UPDATE atlas_control.intake_jobs SET validation_id=$2 WHERE id=$1',[claim.id,v.id]);
      return {validation:v,reused:false};
    });
  }
  async completeValidation(claim:Claim,validationId:string,reportSha256:string,decision:Decision):Promise<void>{
    id(validationId);hash(reportSha256);
    await this.tx(async c=>{
      await this.live(c,claim);
      const r=await c.query(`UPDATE atlas_control.intake_validations SET state=$3,report_sha256=$4,decision=$5,
        decision_sha256=$6,baseline_id=$7,validated_at=clock_timestamp(),worker_token=NULL
        WHERE id=$1 AND worker_token=$2 AND state='processing' RETURNING id`,
        [validationId,claim.token,decision.kind==='reject'?'rejected':decision.kind==='review'?'review_required':'signing_pending',
          reportSha256,JSON.stringify(decision),sha256(JSON.stringify(decision)),decision.baselineId]);
      if(!r.rowCount)throw new LeaseLost();
      await this.finish(c,claim,'completed',null,validationId);await this.event(c,'validation_completed',claim.id,validationId,{kind:decision.kind,reasons:decision.reasons});
    });
  }
  async baseline(region:string):Promise<Baseline|null>{
    const row=(await this.pool.query(`SELECT v.id,v.source_sha256,v.decision FROM atlas_control.intake_baselines b
      JOIN atlas_control.intake_validations v ON v.id=b.validation_id WHERE b.region=$1 AND v.state='accepted'`,[region])).rows[0];
    return row?{id:row.id,sourceSha256:row.source_sha256,snapshot:row.decision.snapshot,counts:row.decision.counts}:null;
  }
  async review(validationId:string,reportSha:string,decisionSha:string,action:'approve'|'reject',actor:string,rationale:string):Promise<void>{
    id(validationId);hash(reportSha);hash(decisionSha);text(actor,100);text(rationale,2000);
    if(rationale.trim().length<10)throw new IntakeError('review_reason_required');
    await this.tx(async c=>{
      const v=(await c.query<Validation>('SELECT * FROM atlas_control.intake_validations WHERE id=$1 FOR UPDATE',[validationId])).rows[0];
      if(!v||v.state!=='review_required'||v.report_sha256!==reportSha||v.decision_sha256!==decisionSha||v.decision?.kind!=='review')throw new IntakeError('stale_or_forbidden_review');
      await c.query('INSERT INTO atlas_control.intake_reviews(validation_id,report_sha256,decision_sha256,action,actor,rationale) VALUES($1,$2,$3,$4,$5,$6)',[validationId,reportSha,decisionSha,action,actor,rationale]);
      await c.query('UPDATE atlas_control.intake_validations SET state=$2 WHERE id=$1',[validationId,action==='approve'?'signing_pending':'rejected']);
      await this.event(c,'human_review',null,validationId,{action,actor,rationale,reportSha,decisionSha});
    });
  }
  async approvedReview(validationId:string,decisionSha:string,reportSha:string):Promise<Record<string,unknown>|null>{
    return (await this.pool.query("SELECT id::text,actor,rationale,report_sha256,decision_sha256,created_at FROM atlas_control.intake_reviews WHERE validation_id=$1 AND decision_sha256=$2 AND report_sha256=$3 AND action='approve'",[validationId,decisionSha,reportSha])).rows[0]??null;
  }
  async claimSigning(specSha:string|string[]):Promise<Validation|null>{
    const specs=typeof specSha==='string'?[specSha]:specSha;specs.forEach(hash);
    return this.tx(async c=>{
      const r=await c.query<Validation>(`SELECT * FROM atlas_control.intake_validations WHERE spec_sha256=ANY($1::text[]) AND
        ((state='signing_pending' AND sign_next_attempt_at<=clock_timestamp()) OR (state='signing' AND sign_lease_until<=clock_timestamp())) ORDER BY validated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[specs]);
      const v=r.rows[0];if(!v)return null;const token=nonce();
      await c.query("UPDATE atlas_control.intake_validations SET state='signing',sign_token=$2,sign_lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1",[v.id,token]);
      return {...v,state:'signing',sign_token:token};
    });
  }
  async finishSigning(v:Validation,payloadSha:string,bundleSha:string,keySha:string):Promise<void>{
    hash(payloadSha);hash(bundleSha);hash(keySha);
    await this.tx(async c=>{
      const r=await c.query(`UPDATE atlas_control.intake_validations SET state='accepted',payload_sha256=$3,bundle_sha256=$4,
        public_key_sha256=$5,accepted_at=clock_timestamp(),sign_token=NULL,sign_lease_until=NULL
        WHERE id=$1 AND state='signing' AND sign_token=$2 AND sign_lease_until>clock_timestamp() RETURNING id`,[v.id,v.sign_token,payloadSha,bundleSha,keySha]);
      if(!r.rowCount)throw new LeaseLost();
      await this.event(c,'source_accepted',null,v.id,{payloadSha,bundleSha,keySha});
    });
  }
  async signingFailed(v:Validation,code:string,newDecision?:Decision):Promise<void>{
    await this.tx(async c=>{
      const r=await c.query(`UPDATE atlas_control.intake_validations SET state=$3,sign_token=NULL,sign_lease_until=NULL,
        sign_failures=CASE WHEN $4::jsonb IS NULL THEN sign_failures+1 ELSE 0 END,
        sign_next_attempt_at=CASE WHEN $4::jsonb IS NULL THEN clock_timestamp()+least(600,5*power(2,least(sign_failures,7)))*interval '1 second' ELSE clock_timestamp() END,
        decision=coalesce($4::jsonb,decision),decision_sha256=coalesce($5,decision_sha256),baseline_id=CASE WHEN $4::jsonb IS NULL THEN baseline_id ELSE $4::jsonb->>'baselineId' END
        WHERE id=$1 AND state='signing' AND sign_token=$2 AND sign_lease_until>clock_timestamp() RETURNING id`,
        [v.id,v.sign_token,newDecision?newDecision.kind==='reject'?'rejected':newDecision.kind==='review'?'review_required':'signing_pending':'signing_pending',newDecision?JSON.stringify(newDecision):null,newDecision?sha256(JSON.stringify(newDecision)):null]);
      if(!r.rowCount)throw new LeaseLost();await this.event(c,'signing_failed',null,v.id,{code});
    });
  }
  async pinBaseline(validationId:string,expectedPrevious:string|null,actor:string,rationale:string):Promise<void>{
    id(validationId);text(actor,100);text(rationale,2000);if(rationale.trim().length<10)throw new IntakeError('review_reason_required');
    await this.tx(async c=>{
      const v=(await c.query<Validation>("SELECT * FROM atlas_control.intake_validations WHERE id=$1 AND state='accepted'",[validationId])).rows[0];
      if(!v)throw new IntakeError('baseline_not_accepted');
      const previous=(await c.query('SELECT validation_id FROM atlas_control.intake_baselines WHERE region=$1 FOR UPDATE',[v.region])).rows[0]?.validation_id??null;
      if(previous!==expectedPrevious)throw new IntakeError('baseline_generation_changed');
      await c.query(`INSERT INTO atlas_control.intake_baselines(region,validation_id,actor,rationale) VALUES($1,$2,$3,$4)
        ON CONFLICT(region) DO UPDATE SET validation_id=excluded.validation_id,actor=excluded.actor,rationale=excluded.rationale,updated_at=clock_timestamp()`,[v.region,v.id,actor,rationale]);
      await this.event(c,'baseline_pinned',null,v.id,{previous,actor,rationale});
    });
  }
  async abandoned():Promise<{job_id:string;token:string}[]>{return (await this.pool.query("SELECT job_id,token FROM atlas_control.intake_attempts WHERE state IN ('abandoned','failed','completed') ORDER BY started_at LIMIT 100")).rows;}
  async cleaned(token:string):Promise<void>{await this.pool.query("UPDATE atlas_control.intake_attempts SET state='cleaned' WHERE token=$1 AND state IN ('abandoned','failed','completed')",[token]);}
  async validation(validationId:string):Promise<Validation>{id(validationId);const row=(await this.pool.query<Validation>('SELECT * FROM atlas_control.intake_validations WHERE id=$1',[validationId])).rows[0];if(!row)throw new IntakeError('validation_not_found');return row;}
  async status():Promise<unknown[]>{
    const jobs=(await this.pool.query(`SELECT j.id,j.state AS job_state,j.attempts,j.failures,j.failure_code,j.spec_sha256,j.lease_until,v.id AS validation_id,
    v.state AS validation_state,v.source_sha256,v.report_sha256,v.decision_sha256,v.decision,v.payload_sha256,v.bundle_sha256,v.public_key_sha256
    FROM atlas_control.intake_jobs j LEFT JOIN atlas_control.intake_validations v ON v.id=j.validation_id ORDER BY j.created_at DESC LIMIT 100`)).rows;
    const rejected=(await this.pool.query(`SELECT r.id,'not_admitted' AS job_state,r.reason AS failure_code,r.recorded_at FROM atlas_control.intake_delivery_rejections r
      WHERE NOT EXISTS(SELECT FROM atlas_control.intake_jobs j WHERE j.id=r.id) ORDER BY r.recorded_at DESC LIMIT 100`)).rows;
    return [...jobs,...rejected];
  }
}
