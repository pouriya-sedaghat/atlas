import {watch} from 'node:fs';
import {readFile as read} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {loadConfig,secretFile} from './config.js';
import {hash,id,IntakeError,parseSource,sha256,text} from './contracts.js';
import {IntakeFiles} from './files.js';
import {IntakeQueue} from './queue.js';
import {DockerValidator,IntakeWorker} from './worker.js';
import {SourceSigner} from './signer.js';
import {verifyBuild} from './build.js';

async function main():Promise<void>{
  const args=parseArgs({allowPositionals:true,strict:true,options:{config:{type:'string'},once:{type:'boolean'},file:{type:'string'},
    provider:{type:'string'},region:{type:'string'},url:{type:'string'},'expected-sha':{type:'string'},validation:{type:'string'},
    'report-sha':{type:'string'},'decision-sha':{type:'string'},action:{type:'string'},actor:{type:'string'},reason:{type:'string'},'previous-baseline':{type:'string'}}});
  const command=args.positionals[0];
  if(args.positionals.length!==1||!command||!['init','submit','work','reconcile','sign','status','review','baseline','verify-receipt'].includes(command)||!args.values.config)
    throw new IntakeError('usage_command_and_config_required');
  const config=await loadConfig(args.values.config),files=new IntakeFiles(config.root,config.python);
  await verifyBuild(config.worker.controllerSha256);
  const role=command==='init'?'admin':['sign','verify-receipt'].includes(command)?'signer':['review','baseline'].includes(command)?'reviewer':'worker';
  const connectionString=await secretFile(config.dsnFiles[role]);
  const pool=new pg.Pool({connectionString,max:4,connectionTimeoutMillis:5000,statement_timeout:10000,application_name:`atlas-intake-${role}`});
  const queue=new IntakeQueue(pool),validator=new DockerValidator(files,config.worker),worker=new IntakeWorker(files,queue,config.policy,config.worker,validator);
  const signer=new SourceSigner(files,queue,config.policy,config.worker,config.signer);
  const shutdown=new AbortController();
  process.once('SIGTERM',()=>shutdown.abort());process.once('SIGINT',()=>shutdown.abort());
  try{
    const database=String((await pool.query('SELECT current_database() AS name')).rows[0].name);
    if(!/^atlas_(ingest[a-z0-9_]*|test[a-z0-9_]*)$/.test(database))throw new IntakeError('dedicated_intake_database_required');
    if(command==='init'){
      await files.init();await pool.query(await read(new URL('./schema.sql',import.meta.url),'utf8'));
      const instance=await queue.bindRoot(sha256(config.root));await files.bind(instance);
      await pool.query(await read(new URL('./roles.sql',import.meta.url),'utf8'));
      process.stdout.write(JSON.stringify({initialized:true,instance,specSha256:worker.specSha256})+'\n');return;
    }
    await files.bind(await queue.rootBinding(sha256(config.root)));
    if(command==='submit'){
      const source=parseSource({provider:args.values.provider,region:args.values.region,url:args.values.url});
      const expected=args.values['expected-sha'];if(expected)hash(expected);
      const path=text(args.values.file,2000);
      if(!path.startsWith('/'))throw new IntakeError('absolute_source_required');
      process.stdout.write(JSON.stringify(await files.submit(path,{source,maxBytes:config.worker.maxBytes,minFreeBytes:config.worker.minFreeBytes,expectedSha256:expected}))+'\n');return;
    }
    if(command==='status'){process.stdout.write(JSON.stringify(await queue.status(),null,2)+'\n');return;}
    if(command==='reconcile'){process.stdout.write(JSON.stringify({registered:await worker.reconcile()})+'\n');return;}
    if(command==='review'){
      const action=args.values.action;if(action!=='approve'&&action!=='reject')throw new IntakeError('review_action_required');
      await queue.review(id(args.values.validation),hash(args.values['report-sha']),hash(args.values['decision-sha']),action,text(args.values.actor,100),text(args.values.reason,2000));
      process.stdout.write(JSON.stringify({reviewed:true,action})+'\n');return;
    }
    if(command==='baseline'){
      const validation=await queue.validation(id(args.values.validation));await signer.verify(validation);
      const previous=args.values['previous-baseline'];
      await queue.pinBaseline(validation.id,previous?id(previous):null,text(args.values.actor,100),text(args.values.reason,2000));
      process.stdout.write(JSON.stringify({baselinePinned:true,validation:validation.id})+'\n');return;
    }
    if(command==='verify-receipt'){
      const validation=await queue.validation(id(args.values.validation));await signer.verify(validation);
      process.stdout.write(JSON.stringify({verified:true,validation:validation.id,sourceSha256:validation.source_sha256})+'\n');return;
    }
    if(command==='sign')await signer.verifyConfiguration();else await validator.verifyImage();
    // Watch is a latency hint; the periodic full scan and durable queue are authoritative.
    let wake:(()=>void)|undefined;
    const watcher=command==='work'?watch(config.root+'/incoming',()=>wake?.()):undefined;
    watcher?.on('error',()=>undefined);
    try{
      do{
        try{const worked=command==='sign'?await signer.once():await worker.once(shutdown.signal);if(args.values.once)break;if(worked)continue;}
        catch(error){
          process.stderr.write(JSON.stringify({event:'controller_error',code:error instanceof IntakeError?error.code:'control_or_infrastructure_error'})+'\n');
          if(args.values.once)throw error;
        }
        if(shutdown.signal.aborted)break;
        await new Promise<void>(resolve=>{
          const finish=()=>{clearTimeout(timer);wake=undefined;shutdown.signal.removeEventListener('abort',finish);resolve();};
          const timer=setTimeout(finish,5000);wake=finish;shutdown.signal.addEventListener('abort',finish,{once:true});
        });
      }while(!shutdown.signal.aborted);
    }finally{watcher?.close();}
  }finally{await pool.end();}
}
main().catch(error=>{
  process.stderr.write(JSON.stringify({event:'intake_exit',code:error instanceof IntakeError?error.code:'controller_failure'})+'\n');process.exitCode=1;
});
