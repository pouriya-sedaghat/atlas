import type {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {IntakeFiles} from '@atlas/ingest/files';
import {IntakeQueue,type Validation} from '@atlas/ingest/queue';
import {SourceSigner} from '@atlas/ingest/signer';
import {hash,id,IntakeError,parseAudit,sha256,type AuditReport} from '@atlas/ingest/contracts';
import type {Config} from './config.js';
export interface VerifiedSource {validation:Validation;payload:Record<string,any>;audit:AuditReport;path:string;}
export class SourceGate {
  readonly files:IntakeFiles;private readonly queue:IntakeQueue;private readonly verifier:SourceSigner;
  constructor(private readonly config:Config,pool:Pool){
    this.files=new IntakeFiles(config.source.root,config.source.python);this.queue=new IntakeQueue(pool);
    this.verifier=new SourceSigner(this.files,this.queue,config.source.policy,config.source.worker,config.source.signer);
  }
  async verify(validationId:string,expectedPayload?:string):Promise<VerifiedSource>{
    id(validationId);if(expectedPayload)hash(expectedPayload);
    await this.files.bind(await this.queue.rootBinding(sha256(this.config.source.root)));
    const v=await this.queue.validation(validationId);
    if(expectedPayload&&v.payload_sha256!==expectedPayload)throw new IntakeError('source_receipt_changed');
    await this.verifier.verify(v);
    const payload=JSON.parse((await this.files.artifact(v.payload_sha256!)).toString()),audit=parseAudit(JSON.parse((await this.files.artifact(v.report_sha256!)).toString()),v.manifest);
    if(payload.usage_scope!=='experimental_source_only'||audit.blockers.length||payload.decision.kind==='reject')throw new IntakeError('source_scope_or_quality_not_accepted');
    if(payload.decision.kind==='review'&&(!payload.review||payload.review.report_sha256!==v.report_sha256||payload.review.decision_sha256!==v.decision_sha256))throw new IntakeError('source_review_not_bound');
    return {validation:v,payload,audit,path:this.config.source.root+'/sources/'+v.source_sha256+'/input.osm.pbf'};
  }
  async candidates(pool:Pool,pipelineSha:string):Promise<{id:string;payload_sha256:string}[]>{
    return (await pool.query(`SELECT v.id,v.payload_sha256 FROM atlas_control.intake_validations v WHERE v.state='accepted' AND v.public_key_sha256=$1
      AND NOT EXISTS(SELECT FROM atlas_control.candidate_jobs j WHERE j.source_validation_id=v.id AND j.payload_sha256=v.payload_sha256 AND j.pipeline_sha256=$2)
      ORDER BY v.accepted_at,v.id LIMIT 100`,[this.config.source.signer.publicKeySha256,pipelineSha])).rows;
  }
}
