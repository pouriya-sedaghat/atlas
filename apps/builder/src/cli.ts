import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import pg from 'pg';
import {IntakeError,sha256} from '@atlas/ingest/contracts';
import {secretFile} from '@atlas/ingest/config';
import {loadConfig,pipeline,privateDirectory} from './config.js';
import {BuildQueue} from './queue.js';
import {CandidateWorker} from './worker.js';
async function main():Promise<void>{
  const args=parseArgs({allowPositionals:true,strict:true,options:{config:{type:'string'},once:{type:'boolean'},mode:{type:'string'},'fixture-unguarded':{type:'boolean'}}}),command=args.positionals[0];
  if(args.positionals.length!==1||!['init','inspect-spec','reconcile','work','status','admission'].includes(command??'')||!args.values.config)throw new IntakeError('build_command_and_config_required');
  if((args.values.mode!==undefined&&command!=='admission')||(command==='admission'&&!['paused','guarded'].includes(args.values.mode??''))||(args.values['fixture-unguarded']&&command!=='init'))throw new IntakeError('invalid_admission_command');
  const config=await loadConfig(args.values.config),spec=await pipeline(config);
  if(command==='inspect-spec'){process.stdout.write(JSON.stringify(spec,null,2)+'\n');return;}
  if(!config.expectedPipelineSha256&&command!=='init')throw new IntakeError('pipeline_pin_required');
  await privateDirectory(config.root,command==='init');
  const pool=new pg.Pool({connectionString:await secretFile(['init','admission'].includes(command!)?config.controlAdminDsnFile:config.controlDsnFile),connectionTimeoutMillis:5000,max:4,statement_timeout:10000,application_name:'atlas-candidate-control'});
  const queue=new BuildQueue(pool),worker=new CandidateWorker(config,pool,queue,spec);
  const shutdown=new AbortController();process.once('SIGTERM',()=>shutdown.abort());process.once('SIGINT',()=>shutdown.abort());
  try{
    const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    if(!/^atlas_(ingest[a-z0-9_]*|test[a-z0-9_]*)$/.test(name))throw new IntakeError('dedicated_control_database_required');
    if(command==='init'){
      if(args.values['fixture-unguarded']&&(!/^atlas_test_ingest_e2e_[0-9a-f]{8}$/.test(name)||config.source.policy.provider!=='fixture'))throw new IntakeError('fixture_admission_forbidden');
      if((await pool.query('SELECT holder_kind FROM atlas_control.processing_slot WHERE singleton')).rows[0]?.holder_kind)throw new IntakeError('build_schema_upgrade_requires_drain');
      await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
      await worker.files.init();await worker.files.bind(await queue.bind(sha256(config.root),true));
      await pool.query('UPDATE atlas_control.candidate_instance SET admission_enabled=false,serving_watch_required=true WHERE singleton');
      if(args.values['fixture-unguarded'])await queue.fixtureAdmission(sha256(config.root));
      process.stdout.write(JSON.stringify({initialized:true,pipelineSha256:spec.sha256,admission:await queue.admissionStatus()})+'\n');return;
    }
    await worker.files.bind(await queue.bind(sha256(config.root)));
    if(command==='status'){process.stdout.write(JSON.stringify(await queue.status(),null,2)+'\n');return;}
    if(command==='admission'){await queue.setAdmission(sha256(config.root),spec.sha256,args.values.mode==='guarded');process.stdout.write(JSON.stringify(await queue.admissionStatus())+'\n');return;}
    if(command==='reconcile'){process.stdout.write(JSON.stringify({enqueued:await worker.reconcile()})+'\n');return;}
    do{
      try{const worked=await worker.once(shutdown.signal);if(args.values.once||shutdown.signal.aborted)break;if(worked)continue;}
      catch(error){process.stderr.write(JSON.stringify({event:'builder_error',code:error instanceof IntakeError?error.code:'candidate_infrastructure_error'})+'\n');if(args.values.once)throw error;}
      if(shutdown.signal.aborted)break;
      await new Promise<void>(resolve=>{const timer=setTimeout(finish,5000);function finish(){clearTimeout(timer);shutdown.signal.removeEventListener('abort',finish);resolve();}shutdown.signal.addEventListener('abort',finish,{once:true});});
    }while(!shutdown.signal.aborted);
  }finally{await pool.end();}
}
main().catch(error=>{process.stderr.write(JSON.stringify({event:'builder_exit',code:error instanceof IntakeError?error.code:'candidate_failure'})+'\n');process.exitCode=1;});
