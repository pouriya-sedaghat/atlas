import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {IntakeError,sha256} from '@atlas/ingest/contracts';
import {execute} from '@atlas/ingest/process';
import {secretFile} from '@atlas/ingest/config';
import {loadConfig,type Config} from './config.js';
import {BuildQueue,type GuardIncident,type GuardObservation} from './queue.js';
import {DataRuntime} from './data.js';

/** A trusted local observer, not a remotely callable publication or availability API. */
export class ServingGuard {
  readonly queue:BuildQueue;readonly root:string;readonly pipeline:string;
  constructor(readonly config:Config,readonly configPath:string,private readonly pool:Pool,readonly unit='atlas-candidate-worker.service'){
    this.queue=new BuildQueue(pool);this.root=sha256(config.root);
    if(!config.expectedPipelineSha256||resolve(configPath)!==configPath||/\s|[;{}]/.test(configPath)||/\s|[;{}]/.test(config.repo))throw new IntakeError('guard_worker_binding_required');
    this.pipeline=config.expectedPipelineSha256;
  }
  private async unitState():Promise<Record<string,string>>{
    const r=await execute('systemctl',['--user','show',this.unit,'-p','ExecStart','-p','ActiveState','-p','MainPID'],{timeoutMs:5000,maxOutput:65536});
    if(r.code!==0)throw new IntakeError('guard_unit_inspection_failed');
    return Object.fromEntries(r.stdout.toString().trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
  }
  async assertWorkerBinding():Promise<void>{
    const current=await loadConfig(this.configPath);
    if(sha256(current.root)!==this.root||current.expectedPipelineSha256!==this.pipeline||current.repo!==this.config.repo||current.controlDsnFile!==this.config.controlDsnFile)throw new IntakeError('guard_worker_binding_changed');
    if(this.pool.options.connectionString!==await secretFile(current.controlDsnFile))throw new IntakeError('guard_control_dsn_changed');
    for(const name of ['guard.js','data.js','queue.js']){
      const running=await readFile(new URL('./'+name,import.meta.url)),worker=await readFile(this.config.repo+'/apps/builder/dist/'+name);
      if(sha256(running)!==sha256(worker))throw new IntakeError('guard_worker_runtime_mismatch');
    }
    const state=await this.unitState(),expected=`${process.execPath} ${this.config.repo}/apps/builder/dist/cli.js work --config ${this.configPath}`;
    if(!state.ExecStart?.includes('argv[]='+expected+' ;'))throw new IntakeError('guard_unit_binding_mismatch');
  }
  async checkUnitPolicy():Promise<void>{
    if(this.unit==='atlas-candidate-worker.service')return;
    const name=(await this.pool.query('SELECT current_database() AS name')).rows[0].name;
    if(!/^atlas_test_ingest_e2e_[0-9a-f]{8}$/.test(name)||!/^atlas-guard-test-[0-9a-f]{8}\.service$/.test(this.unit))throw new IntakeError('guard_test_unit_forbidden');
  }
  async latch(job:string,token:string,observation:GuardObservation):Promise<GuardIncident>{
    await this.checkUnitPolicy();await this.assertWorkerBinding();
    // Nothing may stop the unit before this transaction commits. A stale token cannot stop a replacement.
    return this.queue.latchServingGuard(this.root,this.pipeline,job,token,observation);
  }
  async trip(job:string,token:string,observation:GuardObservation):Promise<GuardIncident>{
    const incident=await this.latch(job,token,observation);
    await this.recover(incident.id);return this.queue.servingGuard(incident.id,this.root,this.pipeline);
  }
  async recover(id:string):Promise<void>{
    await this.checkUnitPolicy();
    const incident=await this.queue.servingGuard(id,this.root,this.pipeline);if(incident.shutdown_confirmed_at)return;
    await this.assertWorkerBinding();
    const stopped=await execute('systemctl',['--user','stop',this.unit],{timeoutMs:55000,maxOutput:65536});
    if(stopped.code!==0)throw new IntakeError('guard_unit_stop_failed');
    const state=await this.unitState();if(!['inactive','failed'].includes(state.ActiveState??'')||state.MainPID!=='0')throw new IntakeError('guard_unit_still_running');
    await this.assertWorkerBinding();
    const data=new DataRuntime(this.config,incident.claim,this.queue),witness=await data.quiesceGuard(incident.claim.data_target);
    await this.queue.confirmServingGuard(id,this.root,this.pipeline,{unit_stopped:true,...witness,unit:this.unit});
  }
}
