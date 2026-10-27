import {fileURLToPath} from 'node:url';
import {execute} from './process.js';
import {IntakeError,sha256} from './contracts.js';

export class IntakeFiles {
  constructor(readonly root:string,readonly python='/usr/bin/python3',readonly helper=fileURLToPath(new URL('./secure_fs.py',import.meta.url))){}
  private async command(name:string,args:string[]=[],input?:Uint8Array,signal?:AbortSignal):Promise<Buffer>{
    const result=await execute(this.python,['-I',this.helper,name,this.root,...args],{input,signal,timeoutMs:10*60_000,maxOutput:8*1024*1024});
    if(result.code!==0){
      let code='filesystem_failure';
      try{const error=JSON.parse(result.stderr.toString('utf8'));if(typeof error.error==='string'&&/^[a-zA-Z_]{1,80}$/.test(error.error))code=error.error;}catch{}
      throw new IntakeError(code);
    }return result.stdout;
  }
  async init():Promise<void>{await this.command('init');}
  async bind(instance:string):Promise<void>{await this.command('bind',[instance]);}
  async inspect(id:string):Promise<unknown>{return JSON.parse((await this.command('inspect',[id])).toString('utf8'));}
  async submit(path:string,metadata:unknown):Promise<unknown>{return JSON.parse((await this.command('submit',[path],Buffer.from(JSON.stringify(metadata)))).toString('utf8'));}
  async snapshot(id:string,token:string,manifestSha:string,sourceSha:string,bytes:number,minFree:number,signal?:AbortSignal):Promise<void>{
    await this.command('snapshot',[id,token,manifestSha,sourceSha,String(bytes),String(minFree)],undefined,signal);
  }
  async verifyBlob(sourceSha:string,bytes:number):Promise<void>{await this.command('verify-blob',[sourceSha,String(bytes)]);}
  async consume(id:string,manifestSha:string):Promise<void>{await this.command('consume',[id,manifestSha]);}
  async cleanupAttempt(id:string,token:string):Promise<void>{await this.command('cleanup-attempt',[id,token]);}
  async putArtifact(bytes:Uint8Array):Promise<string>{const digest=sha256(bytes);await this.command('put-artifact',[digest],bytes);return digest;}
  async artifact(digest:string):Promise<Buffer>{return this.command('read-artifact',[digest]);}
}
