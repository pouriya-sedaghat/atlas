import {randomBytes} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {hash,IntakeError,sha256} from '@atlas/ingest/contracts';
import {LeaseLost} from '@atlas/ingest/queue';
export interface Candidate {id:string;source_validation_id:string;payload_sha256:string;pipeline_sha256:string;specification:Record<string,unknown>;state:string;attempts:number;manifest_sha256:string|null;}
export interface BuildClaim extends Candidate {token:string;database_name:string;owner_role:string;import_role:string;tile_role:string;qa_role:string;}
export class BuildQueue {
  constructor(private readonly pool:Pool,readonly leaseMs=90000){if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000)throw new IntakeError('invalid_build_lease');}
  private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
    const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s'");await c.query("SET LOCAL lock_timeout='3s'");
      // Same admission lock as intake; a heavy parser and importer cannot race into the slot.
      await c.query('SELECT pg_advisory_xact_lock(70620528)');const value=await fn(c);await c.query('COMMIT');return value;
    }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
  }
  private async event(c:PoolClient,id:string,token:string|null,event:string,detail:unknown={}):Promise<void>{
    await c.query('INSERT INTO atlas_control.candidate_events(job_id,token,event,detail) VALUES($1,$2,$3,$4)',[id,token,event,JSON.stringify(detail)]);
  }
  async bind(rootSha:string,initialize=false):Promise<string>{
    hash(rootSha);
    if(initialize)await this.pool.query('INSERT INTO atlas_control.candidate_instance(singleton,root_sha256) VALUES(true,$1) ON CONFLICT DO NOTHING',[rootSha]);
    const row=(await this.pool.query('SELECT root_sha256,id FROM atlas_control.candidate_instance WHERE singleton')).rows[0];
    if(!row||row.root_sha256!==rootSha)throw new IntakeError('candidate_root_binding_mismatch');return row.id;
  }
  async enqueue(source:{id:string;payload_sha256:string},pipelineSha:string,spec:Record<string,unknown>):Promise<string>{
    hash(source.payload_sha256);hash(pipelineSha);const buildId=sha256(JSON.stringify({schema:'atlas.candidate-id/1',sourceReceipt:source.payload_sha256,pipelineSha}));
    await this.tx(async c=>{
      const accepted=await c.query("SELECT 1 FROM atlas_control.intake_validations WHERE id=$1 AND state='accepted' AND payload_sha256=$2",[source.id,source.payload_sha256]);
      if(!accepted.rowCount)throw new IntakeError('source_acceptance_changed');
      const r=await c.query('INSERT INTO atlas_control.candidate_jobs(id,source_validation_id,payload_sha256,pipeline_sha256,specification) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[buildId,source.id,source.payload_sha256,pipelineSha,JSON.stringify(spec)]);
      if(r.rowCount)await this.event(c,buildId,null,'enqueued');
    });return buildId;
  }
  async rejectSource(source:{id:string;payload_sha256:string},pipelineSha:string,spec:Record<string,unknown>,code:string):Promise<void>{
    hash(source.payload_sha256);hash(pipelineSha);const id=sha256(JSON.stringify({schema:'atlas.candidate-id/1',sourceReceipt:source.payload_sha256,pipelineSha}));
    await this.tx(async c=>{const r=await c.query(`INSERT INTO atlas_control.candidate_jobs(id,source_validation_id,payload_sha256,pipeline_sha256,specification,state,stage,failure_code)
      SELECT $1,$2,$3,$4,$5,'failed','source_verification',$6 WHERE EXISTS(SELECT FROM atlas_control.intake_validations WHERE id=$2 AND state='accepted' AND payload_sha256=$3)
      ON CONFLICT DO NOTHING RETURNING id`,[id,source.id,source.payload_sha256,pipelineSha,JSON.stringify(spec),code]);
      if(r.rowCount)await this.event(c,id,null,'source_refused',{code});
    });
  }
  async waitCapacity(pipelineSha:string):Promise<void>{
    hash(pipelineSha);await this.tx(async c=>{await c.query("UPDATE atlas_control.candidate_jobs SET stage='capacity_wait',failure_code='capacity',next_attempt_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE pipeline_sha256=$1 AND state IN ('queued','retry_wait') AND next_attempt_at<=clock_timestamp()",[pipelineSha]);});
  }
  private async live(c:PoolClient,claim:BuildClaim):Promise<void>{
    const r=await c.query(`SELECT 1 FROM atlas_control.candidate_jobs j JOIN atlas_control.processing_slot s ON s.singleton
      AND s.holder_kind='candidate' AND s.job_id=j.id AND s.token=j.token
      WHERE j.id=$1 AND j.token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() AND s.lease_until>clock_timestamp() FOR UPDATE OF j,s`,[claim.id,claim.token]);
    if(!r.rowCount)throw new LeaseLost();
  }
  async claim(pipelineSha:string):Promise<BuildClaim|null>{
    hash(pipelineSha);return this.tx(async c=>{
      const expired=(await c.query("SELECT id,token,failures FROM atlas_control.candidate_jobs WHERE state='running' AND lease_until<=clock_timestamp() FOR UPDATE")).rows;
      for(const row of expired){
        await c.query("UPDATE atlas_control.candidate_attempts SET state='abandoned',ended_at=clock_timestamp() WHERE token=$1 AND state='running'",[row.token]);
        await c.query("UPDATE atlas_control.candidate_jobs SET state=CASE WHEN failures+1>=2 THEN 'failed' ELSE 'retry_wait' END,failures=failures+1,token=NULL,lease_until=NULL,failure_code='lease_expired',next_attempt_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=$1",[row.id]);
        await this.event(c,row.id,row.token,'attempt_expired');
      }
      if((await c.query('SELECT 1 FROM atlas_control.processing_slot WHERE singleton AND holder_kind IS NOT NULL FOR UPDATE')).rowCount)return null;
      // Also protect an older intake build during a controlled drain/migration.
      if((await c.query("SELECT 1 FROM atlas_control.intake_jobs WHERE state='running' AND lease_until>clock_timestamp() LIMIT 1")).rowCount)return null;
      const job=(await c.query<Candidate>("SELECT * FROM atlas_control.candidate_jobs WHERE pipeline_sha256=$1 AND state IN ('queued','retry_wait') AND next_attempt_at<=clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE",[pipelineSha])).rows[0];
      if(!job)return null;
      const token=randomBytes(16).toString('hex'),suffix=job.id.slice(0,24)+'_'+token.slice(0,16);
      const claim={...job,token,database_name:'atlas_candidate_'+suffix,owner_role:'atlas_own_'+suffix,import_role:'atlas_imp_'+suffix,tile_role:'atlas_tile_'+suffix,qa_role:'atlas_qa_'+suffix,attempts:job.attempts+1};
      await c.query("UPDATE atlas_control.processing_slot SET holder_kind='candidate',job_id=$1,token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE singleton",[job.id,token,this.leaseMs]);
      await c.query("UPDATE atlas_control.candidate_jobs SET state='running',token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',attempts=attempts+1,stage='claimed',failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1",[job.id,token,this.leaseMs]);
      await c.query("INSERT INTO atlas_control.candidate_attempts(token,job_id,ordinal,database_name,owner_role,import_role,tile_role,qa_role,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')",[token,job.id,claim.attempts,claim.database_name,claim.owner_role,claim.import_role,claim.tile_role,claim.qa_role]);
      await this.event(c,job.id,token,'claimed');return claim;
    });
  }
  async heartbeat(claim:BuildClaim):Promise<void>{await this.tx(async c=>{
    await this.live(c,claim);await c.query("UPDATE atlas_control.candidate_jobs SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",[claim.id,this.leaseMs]);
    await c.query("UPDATE atlas_control.processing_slot SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE singleton AND token=$1",[claim.token,this.leaseMs]);
  });}
  async assertLive(claim:BuildClaim):Promise<void>{await this.tx(c=>this.live(c,claim));}
  async recordTarget(claim:BuildClaim,target:Record<string,unknown>):Promise<void>{await this.tx(async c=>{
    await this.live(c,claim);const value=JSON.stringify(target);
    const r=await c.query('UPDATE atlas_control.candidate_attempts SET data_target=$2 WHERE token=$1 AND (data_target IS NULL OR data_target=$2::jsonb) RETURNING token',[claim.token,value]);
    if(!r.rowCount)throw new IntakeError('candidate_data_target_changed');await this.event(c,claim.id,claim.token,'data_target_bound',target);
  });}
  async stage(claim:BuildClaim,stage:string):Promise<void>{
    if(!/^[a-z_]{1,40}$/.test(stage))throw new IntakeError('invalid_build_stage');
    await this.tx(async c=>{await this.live(c,claim);await c.query('UPDATE atlas_control.candidate_jobs SET stage=$2,updated_at=clock_timestamp() WHERE id=$1',[claim.id,stage]);await this.event(c,claim.id,claim.token,'stage',{stage});});
  }
  async finish(claim:BuildClaim,manifestSha:string,review:boolean):Promise<void>{hash(manifestSha);await this.tx(async c=>{
    await this.live(c,claim);const state=review?'review_required':'component_verified';
    await c.query("UPDATE atlas_control.candidate_jobs SET state=$3,manifest_sha256=$4,token=NULL,lease_until=NULL,stage='complete',failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND token=$2",[claim.id,claim.token,state,manifestSha]);
    await c.query("UPDATE atlas_control.candidate_attempts SET state='completed',ended_at=clock_timestamp() WHERE token=$1",[claim.token]);
    await this.release(c,claim);await this.event(c,claim.id,claim.token,state,{manifestSha,publishable:false});
  });}
  private async release(c:PoolClient,claim:BuildClaim):Promise<void>{await c.query("UPDATE atlas_control.processing_slot SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL WHERE singleton AND holder_kind='candidate' AND token=$1",[claim.token]);}
  async fail(claim:BuildClaim,code:string,retryable=true):Promise<void>{
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(code))throw new IntakeError('invalid_failure_code');
    await this.tx(async c=>{await this.live(c,claim);const capacity=code==='capacity';
      const f=(await c.query('UPDATE atlas_control.candidate_jobs SET failures=failures+$2 WHERE id=$1 RETURNING failures',[claim.id,capacity?0:1])).rows[0].failures;
      await c.query("UPDATE atlas_control.candidate_jobs SET state=$3,token=NULL,lease_until=NULL,failure_code=$4,next_attempt_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1 AND token=$2",[claim.id,claim.token,retryable&&f<2?'retry_wait':'failed',code]);
      await c.query("UPDATE atlas_control.candidate_attempts SET state='failed',ended_at=clock_timestamp() WHERE token=$1",[claim.token]);
      await this.release(c,claim);await this.event(c,claim.id,claim.token,'failed',{code});
    });
  }
  async tokenLive(job:string,token:string):Promise<boolean>{return Boolean((await this.pool.query(`SELECT 1 FROM atlas_control.candidate_jobs j JOIN atlas_control.processing_slot s ON s.singleton AND s.holder_kind='candidate' AND s.job_id=j.id AND s.token=j.token
    WHERE j.id=$1 AND j.token=$2 AND j.state='running' AND j.lease_until>clock_timestamp() AND s.lease_until>clock_timestamp()`,[job,token])).rowCount);}
  /** Capacity is not released merely because a lease expired: the owning reaper must run first. */
  async releaseExpiredSlot():Promise<void>{await this.tx(async c=>{
    await c.query(`UPDATE atlas_control.processing_slot s SET holder_kind=NULL,job_id=NULL,token=NULL,lease_until=NULL
      WHERE s.singleton AND s.holder_kind='candidate' AND s.lease_until<=clock_timestamp()
      AND NOT EXISTS(SELECT FROM atlas_control.candidate_jobs j WHERE j.id=s.job_id AND j.token=s.token AND j.state='running' AND j.lease_until>clock_timestamp())`);
  });}
  async resourceKept(job:string,token:string):Promise<boolean>{return Boolean((await this.pool.query(`SELECT 1 FROM atlas_control.candidate_jobs j JOIN atlas_control.candidate_attempts a ON a.job_id=j.id
    WHERE j.id=$1 AND a.token=$2 AND a.state='completed' AND j.state IN ('component_verified','review_required') AND j.manifest_sha256 IS NOT NULL`,[job,token])).rowCount);}
  async status():Promise<unknown[]>{return (await this.pool.query('SELECT id,source_validation_id,payload_sha256,pipeline_sha256,state,stage,attempts,failures,manifest_sha256,failure_code FROM atlas_control.candidate_jobs ORDER BY created_at DESC LIMIT 100')).rows;}
}
