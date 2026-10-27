import {constants} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {isAbsolute,normalize} from 'node:path';
import {hash,integer,IntakeError,object,parsePolicy,text,type IntakePolicy} from './contracts.js';
import type {WorkerConfig} from './worker.js';
export interface SignConfig {binary:string;binarySha256:string;privateKey:string;passwordFile:string;publicKey:string;publicKeySha256:string;trustedCollectorBuilds:string[];}
export interface Config {root:string;python:string;policy:IntakePolicy;worker:WorkerConfig;dsnFiles:{admin:string;worker:string;reviewer:string;signer:string};signer:SignConfig;}
function absolute(value:unknown):string{
  const path=text(value,2000);
  if(!isAbsolute(path)||normalize(path)!==path||/[\r\n,\u0000]/.test(path)||path==='/')throw new IntakeError('invalid_config_path');return path;
}
export async function secretFile(path:string):Promise<string>{
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const st=await fd.stat();
    if(!st.isFile()||st.size>16384||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new IntakeError('insecure_secret_file');
    return (await fd.readFile({encoding:'utf8'})).trim();
  }finally{await fd.close();}
}
export async function loadConfig(path:string):Promise<Config>{
  if(process.platform!=='linux')throw new IntakeError('linux_required');
  const raw=object(JSON.parse(await readFile(path,'utf8'))),dsn=object(raw.dsnFiles),w=object(raw.worker),s=object(raw.signer);
  const cpus=w.cpus;if(typeof cpus!=='number'||!Number.isFinite(cpus)||cpus<0.25||cpus>4)throw new IntakeError('invalid_cpu_limit');
  const validatorImage=text(w.validatorImage,71);if(!/^sha256:[0-9a-f]{64}$/.test(validatorImage))throw new IntakeError('immutable_validator_required');
  const policy=parsePolicy(JSON.parse(await readFile(absolute(raw.policyFile),'utf8')));
  const trusted=s.trustedCollectorBuilds??[w.controllerSha256];
  if(!Array.isArray(trusted)||trusted.length<1||trusted.length>10)throw new IntakeError('invalid_trusted_collectors');
  return {root:absolute(raw.root),python:absolute(raw.python),policy,
    worker:{validatorImage,controllerSha256:hash(w.controllerSha256),maxBytes:integer(w.maxBytes,1,10*1024**3),minFreeBytes:integer(w.minFreeBytes,256*1024**2),
      timeoutMs:integer(w.timeoutMs,1000,4*3600_000),memoryBytes:integer(w.memoryBytes,256*1024**2,8*1024**3),cpus},
    dsnFiles:{admin:absolute(dsn.admin),worker:absolute(dsn.worker),reviewer:absolute(dsn.reviewer),signer:absolute(dsn.signer)},
    signer:{binary:absolute(s.binary),binarySha256:hash(s.binarySha256),privateKey:absolute(s.privateKey),passwordFile:absolute(s.passwordFile),publicKey:absolute(s.publicKey),publicKeySha256:hash(s.publicKeySha256),trustedCollectorBuilds:[...new Set(trusted.map(hash))]}};
}
