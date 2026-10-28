import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execute} from './process.js';
import {IntakeFiles} from './files.js';
import {evaluate,hex32,IntakeError,object,parseAudit,parseSubmission,sha256,validationSpec,type Decision,type IntakePolicy} from './contracts.js';
import {IntakeQueue,LeaseLost,type Claim} from './queue.js';
import {LeaseWatch} from './lease.js';

export interface WorkerConfig {validatorImage:string;controllerSha256:string;maxBytes:number;minFreeBytes:number;timeoutMs:number;memoryBytes:number;cpus:number;}
export class DockerValidator {
  constructor(private readonly files:IntakeFiles,private readonly config:WorkerConfig){}
  name(claim:{id:string;token:string}):string{return `atlas-audit-${claim.id}-${claim.token}`;}
  private async listed(name:string):Promise<boolean>{
    const r=await execute('docker',['container','ls','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}'],{maxOutput:65536});
    if(r.code!==0)throw new IntakeError('container_inspect_failed');return r.stdout.toString('utf8').trim().length>0;
  }
  async verifyImage():Promise<void>{
    if(!/^sha256:[0-9a-f]{64}$/.test(this.config.validatorImage))throw new IntakeError('immutable_validator_required');
    const r=await execute('docker',['image','inspect',this.config.validatorImage],{maxOutput:65536});
    if(r.code!==0)throw new IntakeError('validator_image_missing');
    const image=JSON.parse(r.stdout.toString('utf8'))[0];
    if(image.Id!==this.config.validatorImage||image.Os!=='linux'||image.Architecture!=='amd64')throw new IntakeError('validator_image_mismatch');
  }
  async stop(claim:{id:string;token:string}):Promise<void>{
    const name=this.name(claim);if(!await this.listed(name))return;
    const r=await execute('docker',['container','inspect',name],{maxOutput:65536});
    if(r.code!==0){if(!await this.listed(name))return;throw new IntakeError('container_inspect_failed');}
    const info=JSON.parse(r.stdout.toString('utf8'))[0],labels=info.Config.Labels??{};
    if(labels['atlas.intake.job']!==claim.id||labels['atlas.intake.token']!==claim.token||labels['atlas.intake.root']!==sha256(this.files.root))throw new IntakeError('foreign_container');
    const removed=await execute('docker',['rm','--force',name],{maxOutput:65536});
    if(removed.code!==0)throw new IntakeError('container_cleanup_failed');
  }
  async reapOrphans(queue:IntakeQueue):Promise<void>{
    const r=await execute('docker',['container','ls','--all','--filter',`label=atlas.intake.root=${sha256(this.files.root)}`,'--format','{{.Names}}'],{maxOutput:65536});
    if(r.code!==0)throw new IntakeError('container_inspect_failed');
    for(const name of r.stdout.toString('utf8').trim().split('\n').filter(Boolean)){
      const match=/^atlas-audit-([0-9a-f]{32})-([0-9a-f]{32})$/.exec(name);
      if(!match)throw new IntakeError('unexpected_managed_container');
      const job=match[1]!,token=match[2]!;
      if(!await queue.tokenLive(job,token))await this.stop({id:job,token});
    }
  }
  async audit(claim:Claim,signal:AbortSignal):Promise<{code:number;bytes:Buffer;stderr:Buffer}>{
    const name=this.name(claim);
    try{
      const r=await execute('docker',['run','--pull','never','--name',name,
        '--label',`atlas.intake.job=${claim.id}`,'--label',`atlas.intake.token=${claim.token}`,'--label',`atlas.intake.root=${sha256(this.files.root)}`,
        '--network','none','--log-driver','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--pids-limit','64','--memory',String(this.config.memoryBytes),'--memory-swap',String(this.config.memoryBytes),'--cpus',String(this.config.cpus),
        '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
        '--mount',`type=bind,src=${join(this.files.root,'sources',claim.manifest.sha256,'input.osm.pbf')},dst=/in/input.osm.pbf,readonly`,
        this.config.validatorImage],{signal,timeoutMs:this.config.timeoutMs,maxOutput:8*1024*1024});
      return {code:r.code,bytes:r.stdout,stderr:r.stderr};
    }finally{await this.stop(claim);}
  }
}

export class IntakeWorker {
  readonly specSha256:string;
  constructor(readonly files:IntakeFiles,readonly queue:IntakeQueue,readonly policy:IntakePolicy,readonly config:WorkerConfig,readonly validator:DockerValidator,
    private readonly log:(event:Record<string,unknown>)=>void=event=>process.stdout.write(JSON.stringify(event)+'\n')){
    this.specSha256=validationSpec(policy,config.validatorImage,config.controllerSha256);
  }
  async reconcile():Promise<number>{
    const ids=(await readdir(join(this.files.root,'incoming'))).filter(name=>hex32.test(name)).sort();
    if(ids.length>10000)throw new IntakeError('incoming_directory_limit');
    const known=await this.queue.known(ids);let added=0;
    for(const id of ids){
      if(known.has(id))continue;if(added>=100)break;
      try{
        const inspection=object(await this.files.inspect(id));if(inspection.status==='not_ready')continue;
        if(inspection.status!=='ready')throw new IntakeError('invalid_delivery');
        const manifest=parseSubmission(inspection.manifest,this.config.maxBytes);
        if(manifest.id!==id||manifest.bytes!==inspection.bytes||typeof inspection.manifestSha256!=='string')throw new IntakeError('delivery_identity_mismatch');
        if(await this.queue.register(manifest,inspection.manifestSha256,this.specSha256))added++;
      }catch(error){
        const code=error instanceof IntakeError?error.code:'filesystem_or_manifest_error';
        if(await this.queue.admissionFailure(id,code))this.log({event:'delivery_not_admitted',id,code});
      }
    }return added;
  }
  async reap():Promise<void>{
    await this.validator.reapOrphans(this.queue);
    for(const attempt of await this.queue.abandoned()){
      await this.validator.stop({id:attempt.job_id,token:attempt.token});
      await this.files.cleanupAttempt(attempt.job_id,attempt.token);
      await this.queue.cleaned(attempt.token);
    }
    await this.queue.releaseExpiredSlot();
  }
  async once(signal?:AbortSignal):Promise<boolean>{
    await this.reconcile();await this.reap();const started=performance.now(),claim=await this.queue.claim(this.specSha256);if(!claim)return false;
    const watch=new LeaseWatch(()=>this.queue.heartbeat(claim),this.queue.leaseMs,started,signal,()=>this.log({event:'control_heartbeat_retry',job:claim.id}));
    try{
      if(claim.blobVerified)await this.files.verifyBlob(claim.manifest.sha256,claim.manifest.bytes);
      else{
        await this.files.snapshot(claim.id,claim.token,claim.manifestSha256,claim.manifest.sha256,claim.manifest.bytes,this.config.minFreeBytes,watch.signal);
        await this.queue.markBlobVerified(claim);
      }
      await this.files.consume(claim.id,claim.manifestSha256);
      await this.queue.assertLive(claim);
      const {validation,reused}=await this.queue.beginValidation(claim);
      if(reused){this.log({event:'validation_reused',job:claim.id,validation:validation.id,state:validation.state});return true;}
      await this.queue.assertLive(claim);const result=await this.validator.audit(claim,watch.signal);
      if(watch.error)throw watch.error;
      if(![0,2,3].includes(result.code)){
        const diagnostic=await this.files.putArtifact(Buffer.from(JSON.stringify({schema:'atlas.validator-failure/1',exitCode:result.code,stderr:result.stderr.toString('utf8')})));
        this.log({event:'validator_failure',job:claim.id,exitCode:result.code,diagnosticSha256:diagnostic});
        throw new IntakeError(result.code===137?'validator_resource_limit':result.code===125?'docker_environment_failure':'validator_failed');
      }
      let parsed:unknown;
      try{parsed=JSON.parse(result.bytes.toString('utf8'));}catch{
        const diagnostic=await this.files.putArtifact(Buffer.from(JSON.stringify({schema:'atlas.validator-failure/1',exitCode:result.code,stderr:result.stderr.toString('utf8'),stdoutPrefix:result.bytes.subarray(0,2000).toString('utf8')})));
        this.log({event:'validator_output_invalid',job:claim.id,diagnosticSha256:diagnostic});throw new IntakeError('invalid_validator_output');
      }
      const baseline=await this.queue.baseline(this.policy.region);
      let decision:Decision;
      if(object(parsed).schema==='atlas.pbf-audit-failure/1'){
        if(result.code!==2)throw new IntakeError('validator_exit_mismatch');
        decision={kind:'reject',reasons:['invalid_osm_input'],counts:{node:0,way:0,relation:0},snapshot:null,baselineId:baseline?.id??null};
      }else{
        const report=parseAudit(parsed,claim.manifest);decision=evaluate(report,claim.manifest,this.policy,baseline);
        const expected=report.blockers.length?2:report.review_reasons.length?3:0;
        if(result.code!==expected)throw new IntakeError('validator_exit_mismatch');
      }
      await this.files.verifyBlob(claim.manifest.sha256,claim.manifest.bytes);
      const reportSha=await this.files.putArtifact(result.bytes);
      if(watch.signal.aborted)throw watch.error??new IntakeError('cancelled');
      await this.queue.completeValidation(claim,validation.id,reportSha,decision);
      this.log({event:'validation_completed',job:claim.id,validation:validation.id,kind:decision.kind,reasons:decision.reasons});
      return true;
    }catch(error){
      const cause=watch.error??error,code=cause instanceof IntakeError?cause.code:'worker_infrastructure_error';
      if(!['lease_lost','control_lease_deadline'].includes(code)){
        const permanent=['sha256_mismatch','manifest_changed','size_mismatch','source_grew','not_a_private_regular_file','file_changed','invalid_identifier','symlink_forbidden','unsafe_directory'];
        await this.queue.fail(claim,code, !permanent.includes(code)).catch(failure=>{if(!(failure instanceof LeaseLost))throw failure;});
      }
      this.log({event:'attempt_stopped',job:claim.id,code});
      return true;
    }finally{
      watch.stop();
      await this.validator.stop(claim);await this.reap();
    }
  }
}
