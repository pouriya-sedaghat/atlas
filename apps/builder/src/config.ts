import {readFile,readdir,open,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,integer,IntakeError,object,sha256,text} from '@atlas/ingest/contracts';
import {loadConfig as intakeConfig,secretFile,type Config as IntakeConfig} from '@atlas/ingest/config';
import {verifyBuild} from '@atlas/ingest/build';
import {execute} from '@atlas/ingest/process';
export interface Config {
  root:string;repo:string;sourceConfigPath:string;source:IntakeConfig;
  controlAdminDsnFile:string;controlDsnFile:string;dataAdminDsnFile:string;
  network:string;dataHost:string;dataContainer:string;dataImage:string;importerImage:string;martinImage:string;expectedPipelineSha256:string|null;
  minFreeBytes:number;importMemoryBytes:number;importCpus:number;timeoutMs:number;
  dataLimits:{memoryBytes:number;cpus:number;cpuShares:number;readBps:number;writeBps:number;devices:{path:string;majorMinor:string}[]};
}
export interface Pipeline {sha256:string;specification:Record<string,unknown>;}
function absolute(value:unknown):string{const p=text(value,2000);if(!isAbsolute(p)||resolve(p)!==p||p==='/'||/[\r\n,\u0000]/.test(p))throw new IntakeError('invalid_build_path');return p;}
function image(value:unknown):string{const s=text(value,71);if(!/^sha256:[0-9a-f]{64}$/.test(s))throw new IntakeError('immutable_build_image_required');return s;}
export async function loadConfig(path:string):Promise<Config>{
  if(process.platform!=='linux'||process.versions.node!=='24.21.0')throw new IntakeError('build_runtime_not_supported');
  const raw=object(JSON.parse(await secretFile(path))),sourceConfigPath=absolute(raw.sourceConfigPath),source=await intakeConfig(sourceConfigPath);
  const root=absolute(raw.root),repo=absolute(raw.repo),network=text(raw.network,100),dataHost=text(raw.dataHost,100);
  if(root===source.root||root.startsWith(source.root+'/')||source.root.startsWith(root+'/'))throw new IntakeError('build_root_must_be_separate');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)||!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(dataHost))throw new IntakeError('invalid_private_build_network');
  const dataContainer=text(raw.dataContainer,100);if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(dataContainer))throw new IntakeError('invalid_data_container');
  const cpus=raw.importCpus;if(typeof cpus!=='number'||!Number.isFinite(cpus)||cpus<.25||cpus>2)throw new IntakeError('invalid_build_cpu_limit');
  const limit=object(raw.dataLimits),dataCpus=limit.cpus;
  if(typeof dataCpus!=='number'||!Number.isFinite(dataCpus)||dataCpus<.25||dataCpus>2)throw new IntakeError('invalid_data_cpu_limit');
  if(!Array.isArray(limit.devices)||limit.devices.length<1||limit.devices.length>4)throw new IntakeError('data_io_devices_required');
  const devices=limit.devices.map(value=>{const v=object(value),path=text(v.path,100),majorMinor=text(v.majorMinor,30);
    if(!/^\/dev\/(sd[a-z]+[0-9]*|vd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(?:p[0-9]+)?|dm-[0-9]+)$/.test(path)||!/^\d+:\d+$/.test(majorMinor))throw new IntakeError('invalid_io_device');return {path,majorMinor};});
  if(new Set(devices.map(d=>d.path)).size!==devices.length||new Set(devices.map(d=>d.majorMinor)).size!==devices.length)throw new IntakeError('duplicate_io_device');
  return {root,repo,sourceConfigPath,source,network,dataHost,controlAdminDsnFile:absolute(raw.controlAdminDsnFile),controlDsnFile:absolute(raw.controlDsnFile),dataAdminDsnFile:absolute(raw.dataAdminDsnFile),
    dataContainer,dataImage:image(raw.dataImage),importerImage:image(raw.importerImage),martinImage:image(raw.martinImage),expectedPipelineSha256:raw.expectedPipelineSha256?hash(raw.expectedPipelineSha256):null,
    minFreeBytes:integer(raw.minFreeBytes,2*1024**3),importMemoryBytes:integer(raw.importMemoryBytes,512*1024**2,4*1024**3),importCpus:cpus,timeoutMs:integer(raw.timeoutMs,60000,4*3600_000),
    dataLimits:{memoryBytes:integer(limit.memoryBytes,1024**3,4*1024**3),cpus:dataCpus,cpuShares:integer(limit.cpuShares,2,1024),readBps:integer(limit.readBps,1024**2,64*1024**2),writeBps:integer(limit.writeBps,1024**2,64*1024**2),devices}};
}
export async function privateDirectory(path:string,create=false):Promise<void>{
  const parent=dirname(path);if(parent!==path&&parent!=='/')await privateDirectory(parent,false);
  if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const fd=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();if(!st.isDirectory()||(st.mode&0o022)!==0)throw new IntakeError('unsafe_build_directory');
    if(create&&(st.uid!==process.getuid?.()||(st.mode&0o077)!==0))throw new IntakeError('private_build_directory_required');
  }finally{await fd.close();}
}
export async function pipeline(config:Config):Promise<Pipeline>{
  await verifyBuild(config.source.worker.controllerSha256);
  const files:Record<string,string>={};
  for(const name of ['infra/atlas/raw.lua','infra/atlas/raw-finalize.sql','infra/atlas/tiles.sql','infra/atlas/catalog-observed.lua','infra/catalog/seyra-flex.lua','tools/verify-raw.mjs','tools/verify-tiles.mjs'])
    files[name]=sha256(await readFile(join(config.repo,name)));
  const dist=fileURLToPath(new URL('.',import.meta.url));
  for(const name of (await readdir(dist)).filter(n=>/\.(js|sql)$/.test(n)).sort())files['builder/'+name]=sha256(await readFile(join(dist,name)));
  files['package-lock.json']=sha256(await readFile(join(config.repo,'package-lock.json')));
  const images:Record<string,unknown>={};
  for(const [name,expected]of [['data',config.dataImage],['importer',config.importerImage],['martin',config.martinImage]] as const){
    const r=await execute('docker',['image','inspect',expected!],{maxOutput:65536});if(r.code!==0)throw new IntakeError('build_image_missing');
    const record=JSON.parse(r.stdout.toString())[0];if(record.Id!==expected||record.Architecture!=='amd64'||record.Os!=='linux')throw new IntakeError('build_image_mismatch');
    images[name]={id:record.Id,repository_digests:record.RepoDigests??[]};
  }
  const specification={schema:'atlas.candidate-spec/1',node:process.versions.node,files,images,
    source_verifier_build:config.source.worker.controllerSha256,trusted_source_key:config.source.signer.publicKeySha256,
    scope:'experimental_source_only',component:'postgis_and_martin',catalog_contract:'seyra-catalog-1.0.0-observed-1',publication_supported:false,
    resources:{import_cpus:config.importCpus,import_memory_bytes:config.importMemoryBytes,import_cpu_shares:128,min_free_bytes:config.minFreeBytes,timeout_ms:config.timeoutMs,heavy_slot:'shared_with_intake',
      isolation:'separate_data_cluster',data_limits:config.dataLimits,warmup_sql_timeout_ms:120000,serving_sql_timeout_ms:10000}};
  const digest=sha256(JSON.stringify(specification));
  if(config.expectedPipelineSha256&&config.expectedPipelineSha256!==digest)throw new IntakeError('candidate_pipeline_changed');
  return {sha256:digest,specification};
}
