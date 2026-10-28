import {readFile,writeFile,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {IntakeFiles} from '@atlas/ingest/files';
import {IntakeError,sha256} from '@atlas/ingest/contracts';
import {execute} from '@atlas/ingest/process';
import {LeaseWatch} from '@atlas/ingest/lease';
import {BuildQueue,type BuildClaim} from './queue.js';
import {SourceGate} from './source.js';
import {DataRuntime} from './data.js';
import {coverage,tileSites,layers} from './qa.js';
import {pipeline,type Config,type Pipeline} from './config.js';
export class CandidateWorker {
  readonly files:IntakeFiles;readonly gate:SourceGate;
  constructor(readonly config:Config,private readonly pool:Pool,readonly queue:BuildQueue,readonly spec:Pipeline){
    this.files=new IntakeFiles(config.root,config.source.python);this.gate=new SourceGate(config,pool);
  }
  async reconcile():Promise<number>{
    let n=0;
    for(const row of await this.gate.candidates(this.pool,this.spec.sha256)){
      try{await this.gate.verify(row.id,row.payload_sha256);await this.queue.enqueue(row,this.spec.sha256,this.spec.specification);n++;}
      catch(error){const code=error instanceof IntakeError?error.code:'source_verification_error';await this.queue.rejectSource(row,this.spec.sha256,this.spec.specification,code);}
    }return n;
  }
  private async artifact(value:unknown):Promise<string>{return this.files.putArtifact(Buffer.from(JSON.stringify(value,null,2)+'\n'));}
  async reap():Promise<void>{
    const listed=await execute('docker',['container','ls','--all','--filter',`label=atlas.candidate.root=${sha256(this.config.root)}`,'--format','{{.Names}}'],{maxOutput:65536});
    if(listed.code!==0)throw new IntakeError('candidate_inspection_failed');
    for(const name of listed.stdout.toString().trim().split('\n').filter(Boolean)){
      const r=await execute('docker',['inspect',name],{maxOutput:65536});if(r.code!==0)throw new IntakeError('candidate_inspection_failed');
      const labels=JSON.parse(r.stdout.toString())[0].Config.Labels??{},id=labels['atlas.candidate.job'],token=labels['atlas.candidate.token'],kind=labels['atlas.candidate.kind'];
      if(!/^[0-9a-f]{64}$/.test(id)||!/^[0-9a-f]{32}$/.test(token)||!['importer','martin'].includes(kind))throw new IntakeError('unexpected_candidate_container');
      if(await this.queue.tokenLive(id,token)||kind==='martin'&&await this.queue.resourceKept(id,token))continue;
      const row=(await this.pool.query('SELECT * FROM atlas_control.candidate_attempts WHERE job_id=$1 AND token=$2',[id,token])).rows[0];
      if(!row)throw new IntakeError('unregistered_candidate_container');
      const runtime=new DataRuntime(this.config,{...row,id,token} as BuildClaim,this.queue);await runtime.stop(kind);
    }
    await this.queue.releaseExpiredSlot();
  }
  async once(parentSignal:AbortSignal):Promise<boolean>{
    if((await pipeline(this.config)).sha256!==this.spec.sha256)throw new IntakeError('candidate_pipeline_changed');
    await this.reconcile();await this.reap();
    const free=await statfs(this.config.root,{bigint:true});if(free.bavail*free.bsize<BigInt(this.config.minFreeBytes)){await this.queue.waitCapacity(this.spec.sha256);return false;}
    const started=performance.now(),claim=await this.queue.claim(this.spec.sha256);if(!claim)return false;
    const watch=new LeaseWatch(()=>this.queue.heartbeat(claim),this.queue.leaseMs,started,parentSignal,()=>process.stderr.write(JSON.stringify({event:'control_heartbeat_retry',job:claim.id})+'\n'));
    const data=new DataRuntime(this.config,claim,this.queue,watch.signal);let completed=false;
    try{
      if(watch.signal.aborted)throw watch.error??new IntakeError('cancelled');
      await this.queue.stage(claim,'source_verification');const source=await this.gate.verify(claim.source_validation_id,claim.payload_sha256);
      await data.prepare();await this.queue.stage(claim,'provision');await data.provision(source);
      await this.queue.stage(claim,'import');await data.import(source,watch.signal);
      await this.queue.stage(claim,'finalize');const database=await data.finalize();
      await this.queue.stage(claim,'raw_roundtrip');
      const auditPath=join(data.directory,'audit.json'),rawPath=join(data.directory,'raw-roundtrip.json');
      await writeFile(auditPath,await this.gate.files.artifact(source.validation.report_sha256!),{flag:'wx',mode:0o600});
      const rawRun=await execute(process.execPath,[join(this.config.repo,'tools/verify-raw.mjs'),auditPath,rawPath],{
        signal:watch.signal,timeoutMs:this.config.timeoutMs,maxOutput:1024*1024,
        env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',ATLAS_RAW_CONNECTION_FILE:join(data.directory,'qa.dsn')}});
      await writeFile(join(data.directory,'raw-roundtrip.log'),Buffer.concat([rawRun.stdout,rawRun.stderr]),{mode:0o600,flag:'wx'});
      if(rawRun.code!==0)throw new IntakeError('canonical_roundtrip_failed');
      const raw=JSON.parse(await readFile(rawPath,'utf8'));if(raw.passed!==true||raw.source_sha256!==source.validation.source_sha256)throw new IntakeError('canonical_roundtrip_failed');
      const rawSha=await this.artifact(raw);
      await this.queue.stage(claim,'feature_coverage');const qa=await data.qaClient();
      let featureReport,sites;
      const closeQa=()=>void qa.end().catch(()=>undefined);watch.signal.addEventListener('abort',closeQa,{once:true});
      try{featureReport=await coverage(qa,source.audit);sites=await tileSites(qa,source.validation.region,source.audit.bbox);}
      finally{watch.signal.removeEventListener('abort',closeQa);await qa.end().catch(()=>undefined);}
      const coverageSha=await this.artifact(featureReport);
      await this.queue.stage(claim,'martin_qa');const endpoint=await data.martin(watch.signal);
      const tileConfig=join(data.directory,'tile-check.json'),tileReport=join(data.directory,'tile-parity.json');
      await writeFile(tileConfig,JSON.stringify({connectionFile:join(data.directory,'qa.dsn'),martin:endpoint,sites,warmup:true,layers}),{flag:'wx',mode:0o600});
      const tilesRun=await execute(process.execPath,[join(this.config.repo,'tools/verify-tiles.mjs'),tileReport,'2'],{signal:watch.signal,timeoutMs:this.config.timeoutMs,maxOutput:1024*1024,
        env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',ATLAS_TILE_CHECK_CONFIG_FILE:tileConfig}});
      await writeFile(join(data.directory,'tile-check.log'),Buffer.concat([tilesRun.stdout,tilesRun.stderr]),{flag:'wx',mode:0o600});
      let tiles;
      try{tiles=JSON.parse(await readFile(tileReport,'utf8'));}catch{throw new IntakeError('candidate_tile_check_failed');}
      if(tiles.failure)throw new IntakeError('candidate_tile_check_failed');
      if(!Array.isArray(tiles.samples)||!tiles.samples.length||!tiles.samples.every((s:any)=>s.parity===true))throw new IntakeError('candidate_tile_contract_failed');
      if(tilesRun.code!==0&&tiles.passed!==false)throw new IntakeError('candidate_tile_check_failed');
      const tileSha=await this.artifact(tiles),review=[...featureReport.review_reasons];if(!tiles.passed)review.push('no_rendered_features');
      await this.queue.stage(claim,'seal');
      await this.gate.verify(claim.source_validation_id,claim.payload_sha256);await data.assertOwned();const dataProfile=await data.verifyDataProfile();await this.queue.assertLive(claim);
      if((await pipeline(this.config)).sha256!==this.spec.sha256)throw new IntakeError('candidate_pipeline_changed');
      const manifest={schema:'atlas.candidate-manifest/1',id:claim.id,attempt:claim.token,scope:'experimental_source_only',publishable:false,map_release_ready:false,
        source:{validation_id:source.validation.id,sha256:source.validation.source_sha256,payload_sha256:claim.payload_sha256,bundle_sha256:source.validation.bundle_sha256,public_key_sha256:source.validation.public_key_sha256},
        pipeline_sha256:this.spec.sha256,specification:this.spec.specification,
        postgis:{database:claim.database_name,identity_token:claim.token,read_only:true,target:data.dataTarget(),runtime_profile:dataProfile,...database},
        serving:{engine:'Martin',image:this.config.martinImage,container:data.endpointName(),endpoint:'http://'+data.endpointName()+':3000',network:this.config.network,public_ports:[]},
        qa:{canonical_roundtrip:rawSha,feature_coverage:coverageSha,tile_parity:tileSha,review_reasons:review},
        components:{postgis:'verified',tiles:tiles.passed?'verified':'review_required',search:'missing',routing:'missing',poi:'missing',assets:'missing'},
        created_at:new Date().toISOString()};
      const manifestSha=await this.artifact(manifest);if(watch.signal.aborted)throw watch.error??new IntakeError('cancelled');await this.queue.finish(claim,manifestSha,review.length>0);completed=true;
      process.stdout.write(JSON.stringify({event:'candidate_component_built',id:claim.id,manifestSha,review,publishable:false})+'\n');return true;
    }catch(error){
      const cause=watch.error??error,code=cause instanceof IntakeError?cause.code:'candidate_infrastructure_error';
      await writeFile(join(data.directory,'failure.json'),JSON.stringify({code,name:cause instanceof Error?cause.name:'unknown',message:cause instanceof Error?cause.message.slice(0,2000):'',stack:cause instanceof Error?cause.stack?.slice(0,6000):''},null,2)+'\n',{flag:'wx',mode:0o600}).catch(()=>undefined);
      if(['lease_lost','control_lease_deadline'].includes(code))throw cause;
      await data.stop('importer');await data.stop('martin');
      await this.queue.fail(claim,code,!['canonical_roundtrip_failed','outcome_accounting_failed','unexplained_catalog_loss','layer_integrity_failed','serving_topology_integrity_failed','candidate_tile_contract_failed','candidate_tile_check_failed','source_receipt_changed','candidate_metadata_deadlock'].includes(code));
      process.stderr.write(JSON.stringify({event:'candidate_attempt_failed',id:claim.id,code})+'\n');throw error;
    }finally{
      watch.stop();
      if(!completed){await data.stop('importer');await data.stop('martin');}
    }
  }
}
