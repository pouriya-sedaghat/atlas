import {constants} from 'node:fs';
import {open,readFile,mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {evaluate,hash,IntakeError,parseAudit,parsePolicy,sha256,validationSpec,type IntakePolicy} from './contracts.js';
import {secretFile,type SignConfig} from './config.js';
import {execute} from './process.js';
import {IntakeFiles} from './files.js';
import {IntakeQueue,type Validation} from './queue.js';

export class SourceSigner {
  private readonly collectors:Map<string,string>;
  constructor(private readonly files:IntakeFiles,private readonly queue:IntakeQueue,private readonly policy:IntakePolicy,
    private readonly processing:{validatorImage:string;controllerSha256:string},private readonly config:SignConfig){
    this.collectors=new Map(config.trustedCollectorBuilds.map(build=>[validationSpec(policy,processing.validatorImage,build),build]));
  }
  private async checkedBinary():Promise<void>{
    const fd=await open(this.config.binary,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const st=await fd.stat();if(!st.isFile()||(st.mode&0o022)!==0)throw new IntakeError('insecure_cosign_binary');
      const h=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
      for(;;){const{bytesRead}=await fd.read(buffer,0,buffer.length,null);if(!bytesRead)break;h.update(buffer.subarray(0,bytesRead));}
      if(h.digest('hex')!==this.config.binarySha256)throw new IntakeError('cosign_binary_mismatch');
    }finally{await fd.close();}
  }
  async verifyConfiguration():Promise<void>{
    await this.checkedBinary();
    const key=await readFile(this.config.publicKey);
    if(sha256(key)!==this.config.publicKeySha256)throw new IntakeError('public_key_mismatch');
    await secretFile(this.config.privateKey);await secretFile(this.config.passwordFile);
  }
  private async cosign(args:string[],password?:string):Promise<void>{
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',COSIGN_EXPERIMENTAL:'0'};
    if(password!==undefined)env.COSIGN_PASSWORD=password;
    const r=await execute(this.config.binary,args,{env,timeoutMs:30000,maxOutput:65536});
    if(r.code!==0)throw new IntakeError('cosign_verification_or_signing_failed');
  }
  private async temporary<T>(v:Validation,fn:(payload:string,bundle:string)=>Promise<T>):Promise<T>{
    const dir=await mkdtemp(join(this.files.root,'signing',`${v.id}-`));
    const payload=join(dir,'payload.json'),bundle=join(dir,'bundle.sigstore.json');
    try{return await fn(payload,bundle);}finally{
      for(const path of [payload,bundle])await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await rmdir(dir);
    }
  }
  async once():Promise<boolean>{
    const v=await this.queue.claimSigning([...this.collectors.keys()]);if(!v)return false;
    try{
      if(!v.report_sha256||!v.decision||!v.decision_sha256)throw new IntakeError('validation_incomplete');
      const reportBytes=await this.files.artifact(v.report_sha256);
      const report=parseAudit(JSON.parse(reportBytes.toString('utf8')),v.manifest);
      const baseline=await this.queue.baseline(this.policy.region),decision=evaluate(report,v.manifest,this.policy,baseline);
      if(sha256(JSON.stringify(decision))!==v.decision_sha256){await this.queue.signingFailed(v,'quality_context_changed',decision);return true;}
      if(decision.kind==='reject')throw new IntakeError('hard_rejection_cannot_sign');
      const review=decision.kind==='review'?await this.queue.approvedReview(v.id,v.decision_sha256,v.report_sha256):null;
      if(decision.kind==='review'&&!review){await this.queue.signingFailed(v,'human_review_missing',decision);return true;}
      await this.files.verifyBlob(v.source_sha256,Number(v.source_bytes));
      const payload=Buffer.from(JSON.stringify({schema:'atlas.source-acceptance/1',validation_id:v.id,
        subject:{sha256:v.source_sha256,bytes:Number(v.source_bytes)},source:{...v.manifest.source,provenance:'operator_declared',publisher_signature_verified:false},
        spec_sha256:v.spec_sha256,report_sha256:v.report_sha256,decision_sha256:v.decision_sha256,decision,
        processing:{validator_image:this.processing.validatorImage,collector_build_sha256:this.collectors.get(v.spec_sha256),
          signer_build_sha256:this.processing.controllerSha256,policy:this.policy},
        validated_at:v.validated_at!.toISOString(),review,signing_profile:'cosign-local-key-offline-v1',public_key_sha256:this.config.publicKeySha256})+'\n');
      await this.checkedBinary();
      if(sha256(await readFile(this.config.publicKey))!==this.config.publicKeySha256)throw new IntakeError('public_key_mismatch');
      const password=await secretFile(this.config.passwordFile);await secretFile(this.config.privateKey);
      await this.temporary(v,async(payloadPath,bundlePath)=>{
        await writeFile(payloadPath,payload,{flag:'wx',mode:0o600});
        await this.cosign(['sign-blob','--yes','--key',this.config.privateKey,'--tlog-upload=false','--use-signing-config=false','--bundle',bundlePath,payloadPath],password);
        await this.cosign(['verify-blob','--offline','--insecure-ignore-tlog=true','--key',this.config.publicKey,'--bundle',bundlePath,payloadPath]);
        const payloadSha=await this.files.putArtifact(payload),bundleSha=await this.files.putArtifact(await readFile(bundlePath));
        await this.queue.finishSigning(v,payloadSha,bundleSha,this.config.publicKeySha256);
      });return true;
    }catch(error){
      const code=error instanceof IntakeError?error.code:'signer_infrastructure_error';
      await this.queue.signingFailed(v,code);throw new IntakeError(code);
    }
  }
  async verify(v:Validation):Promise<void>{
    if(v.state!=='accepted'||!v.payload_sha256||!v.bundle_sha256||v.public_key_sha256!==this.config.publicKeySha256)throw new IntakeError('unaccepted_or_untrusted_receipt');
    await this.checkedBinary();
    if(sha256(await readFile(this.config.publicKey))!==v.public_key_sha256)throw new IntakeError('public_key_mismatch');
    const payload=await this.files.artifact(v.payload_sha256),bundle=await this.files.artifact(v.bundle_sha256);
    const parsed=JSON.parse(payload.toString('utf8'));
    const context=parsed.processing,policy=parsePolicy(context?.policy);
    hash(context.signer_build_sha256);
    if(validationSpec(policy,context.validator_image,context.collector_build_sha256)!==v.spec_sha256)throw new IntakeError('receipt_processing_mismatch');
    if(parsed.schema!=='atlas.source-acceptance/1'||parsed.validation_id!==v.id||parsed.subject.sha256!==v.source_sha256||parsed.subject.bytes!==Number(v.source_bytes)||
      parsed.spec_sha256!==v.spec_sha256||parsed.report_sha256!==v.report_sha256||parsed.public_key_sha256!==v.public_key_sha256||
      // PostgreSQL JSONB can reorder object keys. Bind its values to the exact signed representation.
      parsed.decision_sha256!==v.decision_sha256||!isDeepStrictEqual(parsed.decision,v.decision)||sha256(JSON.stringify(parsed.decision))!==v.decision_sha256||
      parsed.source.provider!==v.manifest.source.provider||parsed.source.region!==v.manifest.source.region||parsed.source.url!==v.manifest.source.url||
      parsed.source.publisher_signature_verified!==false||parsed.signing_profile!=='cosign-local-key-offline-v1')throw new IntakeError('receipt_identity_mismatch');
    await this.files.artifact(v.report_sha256!);
    await this.files.verifyBlob(v.source_sha256,Number(v.source_bytes));
    await this.temporary(v,async(p,b)=>{
      await writeFile(p,payload,{flag:'wx',mode:0o600});await writeFile(b,bundle,{flag:'wx',mode:0o600});
      await this.cosign(['verify-blob','--offline','--insecure-ignore-tlog=true','--key',this.config.publicKey,'--bundle',b,p]);
    });
  }
}
