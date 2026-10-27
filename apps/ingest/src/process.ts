import {spawn} from 'node:child_process';
import {IntakeError} from './contracts.js';

export interface ProcessResult {code:number;stdout:Buffer;stderr:Buffer;}
/** No shell. Output and wall time are bounded even when the child is hostile. */
export function execute(file:string,args:string[],options:{input?:Uint8Array;env?:NodeJS.ProcessEnv;signal?:AbortSignal;timeoutMs?:number;maxOutput?:number;cwd?:string}={}):Promise<ProcessResult>{
  return new Promise((resolve,reject)=>{
    if(options.signal?.aborted){reject(new IntakeError('cancelled'));return;}
    const child=spawn(file,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:options.env??process.env,cwd:options.cwd});
    const chunks:Buffer[]=[],errors:Buffer[]=[];let size=0,errorSize=0,problem:Error|undefined;
    const terminate=(error:Error)=>{problem??=error;child.kill('SIGKILL');};
    const abort=()=>terminate(new IntakeError('cancelled'));
    const timer=setTimeout(()=>terminate(new IntakeError('process_deadline')),options.timeoutMs??30000);
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>(options.maxOutput??8*1024*1024))terminate(new IntakeError('output_limit'));else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{if(errorSize<65536){errors.push(chunk.subarray(0,65536-errorSize));errorSize+=Math.min(chunk.length,65536-errorSize);}});
    child.on('error',()=>{problem??=new IntakeError('process_start_failed');});
    child.on('close',code=>{
      clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
      if(problem)reject(problem);else resolve({code:code??-1,stdout:Buffer.concat(chunks),stderr:Buffer.concat(errors)});
    });
    // Broken pipes are handled by the child's exit code, not an unhandled event.
    child.stdin.on('error',()=>undefined);
    child.stdin.end(options.input);
  });
}
