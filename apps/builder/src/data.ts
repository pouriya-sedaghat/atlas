import {randomBytes} from 'node:crypto';
import {readFile,writeFile,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {secretFile} from '@atlas/ingest/config';
import {IntakeError,sha256} from '@atlas/ingest/contracts';
import {execute} from '@atlas/ingest/process';
import {privateDirectory,type Config} from './config.js';
import type {BuildClaim,BuildQueue} from './queue.js';
import type {VerifiedSource} from './source.js';
import {layers} from './qa.js';
const q=(s:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(s))throw new IntakeError('invalid_managed_identifier');return '"'+s+'"';};
export function tileSqlForRole(sql:string,role:string):string{
  const marker='TO atlas_tile;';if(sql.split(marker).length!==4)throw new IntakeError('tile_grant_contract_changed');
  return sql.replaceAll(marker,'TO '+q(role)+';');
}
export function verifyIoMax(value:string,limits:Config['dataLimits']):void{
  const rows=new Map(value.trim().split('\n').filter(Boolean).map(line=>{const [id,...fields]=line.trim().split(/\s+/);return [id,Object.fromEntries(fields.map(s=>s.split('=')))];}));
  for(const device of limits.devices){const row=rows.get(device.majorMinor);if(!row||row.rbps!==String(limits.readBps)||row.wbps!==String(limits.writeBps))throw new IntakeError('data_io_limits_not_enforced');}
}
export interface Credentials {importPassword:string;tilePassword:string;qaPassword:string;}
// Each call is an implicit transaction. A deadlock rolls the whole batch back;
// retry only that metadata batch, never the completed bulk import.
export async function metadataTransaction(client:Pick<pg.Client,'query'>,sql:string,assertLive:()=>Promise<void>,signal?:AbortSignal):Promise<void>{
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted)throw new IntakeError('cancelled');
    await assertLive();
    try{await client.query(sql);return;}
    catch(error){
      if((error as {code?:string}).code!=='40P01')throw error;
      if(attempt===2)throw new IntakeError('candidate_metadata_deadlock');
      process.stderr.write(JSON.stringify({event:'candidate_metadata_transaction_retry',sqlstate:'40P01',retry:attempt+1})+'\n');
      await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));
    }
  }
}
export class DataRuntime {
  readonly directory:string;private readonly names:{importer:string;martin:string};
  private credentials!:Credentials;private adminUri!:URL;
  private target:Record<string,unknown>|null=null;
  constructor(readonly config:Config,readonly claim:BuildClaim,private readonly queue:BuildQueue,private readonly signal?:AbortSignal){
    this.directory=join(config.root,'attempts',claim.token);
    const suffix=claim.id.slice(0,12)+'-'+claim.token.slice(0,16);this.names={importer:'atlas-import-'+suffix,martin:'atlas-martin-'+suffix};
  }
  private identity():string{return `atlas.candidate/${this.claim.id}/${this.claim.token}`;}
  private uri(user:string,password:string,database=this.claim.database_name,host?:string):string{
    const uri=new URL(this.adminUri);uri.username=user;uri.password=password;uri.pathname='/'+database;if(host)uri.hostname=host;return uri.toString();
  }
  private async admin(database='postgres'):Promise<pg.Client>{
    if(this.signal?.aborted)throw new IntakeError('cancelled');
    const uri=new URL(await secretFile(this.config.dataAdminDsnFile));uri.pathname='/'+database;
    const client=new pg.Client({connectionString:uri.toString(),connectionTimeoutMillis:30000,statement_timeout:Math.min(this.config.timeoutMs,1800000),application_name:this.adminApplication()});
    await client.connect();
    const close=()=>void client.end().catch(()=>undefined);
    client.once('end',()=>this.signal?.removeEventListener('abort',close));
    this.signal?.addEventListener('abort',close,{once:true});
    if(this.signal?.aborted){await client.end();throw new IntakeError('cancelled');}
    return client;
  }
  async prepare():Promise<void>{
    await privateDirectory(join(this.config.root,'attempts'),true);await privateDirectory(this.directory,true);
    const capacity=await statfs(this.config.root,{bigint:true});if(capacity.bavail*capacity.bsize<BigInt(this.config.minFreeBytes))throw new IntakeError('capacity');
    this.adminUri=new URL(await secretFile(this.config.dataAdminDsnFile));
    if(this.adminUri.protocol!=='postgresql:'||!this.adminUri.hostname)throw new IntakeError('invalid_data_admin_dsn');
    const profile=await this.verifyDataProfile(),admin=await this.admin();
    try{const identifier=(await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
      this.target={kind:'postgresql',container:this.config.dataContainer,image:this.config.dataImage,system_identifier:identifier,volumes:profile.volumes};
      await this.queue.recordTarget(this.claim,this.target);
    }finally{await admin.end();}
    const disk=await execute('docker',['exec',this.config.dataContainer,'df','-B1','--output=avail','/var/lib/postgresql/data'],{maxOutput:65536});
    const available=disk.stdout.toString().trim().split('\n').at(-1)?.trim();
    if(disk.code!==0||!available||!/^\d+$/.test(available))throw new IntakeError('data_disk_capacity_unknown');
    if(BigInt(available)<BigInt(this.config.minFreeBytes))throw new IntakeError('capacity');
    this.credentials={importPassword:randomBytes(32).toString('hex'),tilePassword:randomBytes(32).toString('hex'),qaPassword:randomBytes(32).toString('hex')};
    await writeFile(join(this.directory,'credentials.json'),JSON.stringify(this.credentials),{flag:'wx',mode:0o600});
    const port=this.adminUri.port||'5432';
    await writeFile(join(this.directory,'import.pgpass'),`${this.config.dataHost}:${port}:${this.claim.database_name}:${this.claim.import_role}:${this.credentials.importPassword}\n`,{flag:'wx',mode:0o600});
    await writeFile(join(this.directory,'qa.dsn'),this.uri(this.claim.qa_role,this.credentials.qaPassword)+'\n',{flag:'wx',mode:0o600});
  }
  async verifyDataProfile():Promise<Record<string,unknown>>{
    const adminUri=new URL(await secretFile(this.config.dataAdminDsnFile)),controlUri=new URL(await secretFile(this.config.controlDsnFile));
    if(adminUri.hostname===controlUri.hostname&&(adminUri.port||'5432')===(controlUri.port||'5432'))throw new IntakeError('shared_data_and_control_cluster_forbidden');
    const inspected=await execute('docker',['inspect',this.config.dataContainer],{maxOutput:65536});if(inspected.code!==0)throw new IntakeError('data_server_inspection_failed');
    const data=JSON.parse(inspected.stdout.toString())[0],limits=this.config.dataLimits,h=data.HostConfig;
    if(data.Image!==this.config.dataImage||data.NetworkSettings.Networks[this.config.network]?.IPAddress!==adminUri.hostname||data.Config.Labels?.['atlas.role']!=='candidate-data')throw new IntakeError('data_server_identity_changed');
    if(h.Memory!==limits.memoryBytes||h.MemorySwap!==limits.memoryBytes||h.NanoCpus!==limits.cpus*1e9||h.CpuShares!==limits.cpuShares||Object.values(data.NetworkSettings.Ports??{}).some(v=>Array.isArray(v)&&v.length>0))throw new IntakeError('data_resource_profile_changed');
    for(const d of limits.devices){
      if(!h.BlkioDeviceReadBps?.some((r:any)=>r.Path===d.path&&r.Rate===limits.readBps)||!h.BlkioDeviceWriteBps?.some((r:any)=>r.Path===d.path&&r.Rate===limits.writeBps))throw new IntakeError('data_io_profile_missing');
    }
    const io=await execute('docker',['exec',this.config.dataContainer,'cat','/sys/fs/cgroup/io.max'],{maxOutput:65536});if(io.code!==0)throw new IntakeError('data_io_limits_unknown');
    verifyIoMax(io.stdout.toString(),limits);
    const kernel=await execute('docker',['exec',this.config.dataContainer,'cat','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.swap.max'],{maxOutput:65536});
    const [cpu,memory,swap]=kernel.stdout.toString().trim().split('\n'),parts=cpu?.trim().split(/\s+/).map(Number);
    if(kernel.code!==0||!parts||parts.length!==2||(parts[0]??NaN)/(parts[1]??NaN)!==limits.cpus||memory!==String(limits.memoryBytes)||swap!=='0')throw new IntakeError('data_kernel_limits_not_enforced');
    const stats=await execute('docker',['exec',this.config.dataContainer,'cat','/sys/fs/cgroup/io.stat'],{maxOutput:65536});
    const observed=stats.stdout.toString().trim().split('\n').filter(Boolean).map(line=>line.split(' ')[0]);
    if(stats.code!==0||!observed.length||observed.some(id=>!limits.devices.some(d=>d.majorMinor===id)))throw new IntakeError('data_io_accounting_not_bounded');
    const volumes=data.Mounts.filter((m:any)=>m.Destination==='/var/lib/postgresql/data').map((m:any)=>({name:m.Name,type:m.Type,destination:m.Destination}));
    if(volumes.length!==1||volumes[0].type!=='volume')throw new IntakeError('managed_data_volume_required');
    const volume=await execute('docker',['volume','inspect',volumes[0].name],{maxOutput:65536});
    if(volume.code!==0||JSON.parse(volume.stdout.toString())[0].Labels?.['atlas.role']!=='candidate-data')throw new IntakeError('foreign_data_volume');
    const database=await this.admin();let settings:Record<string,string>;
    try{settings=Object.fromEntries((await database.query("SELECT name,setting FROM pg_settings WHERE name IN ('client_connection_check_interval','fsync','synchronous_commit','full_page_writes')")).rows.map(r=>[r.name,r.setting]));}
    finally{await database.end();}
    if(settings.client_connection_check_interval!=='1000'||settings.fsync!=='on'||settings.synchronous_commit!=='on'||settings.full_page_writes!=='on')throw new IntakeError('data_server_prerequisites_changed');
    return {container:this.config.dataContainer,image:data.Image,limits,volumes,io_max:io.stdout.toString().trim(),cpu_max:cpu,memory_max:memory,memory_swap_max:swap,observed_io_devices:observed,postgres_prerequisites:settings,public_ports:[]};
  }
  async provision(source:VerifiedSource):Promise<void>{
    await this.queue.assertLive(this.claim);const c=await this.admin();
    try{
      for(const [role,password]of [[this.claim.owner_role,null],[this.claim.import_role,this.credentials.importPassword],[this.claim.tile_role,this.credentials.tilePassword],[this.claim.qa_role,this.credentials.qaPassword]] as const){
        await this.queue.assertLive(this.claim);
        if((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)throw new IntakeError('candidate_role_already_exists');
        await c.query(`CREATE ROLE ${q(role)} ${password?'LOGIN PASSWORD '+"'"+password+"'":'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
        await c.query(`COMMENT ON ROLE ${q(role)} IS '${this.identity()}'`);
      }
      await this.queue.assertLive(this.claim);
      if((await c.query('SELECT 1 FROM pg_database WHERE datname=$1',[this.claim.database_name])).rowCount)throw new IntakeError('candidate_database_already_exists');
      await c.query(`CREATE DATABASE ${q(this.claim.database_name)} OWNER ${q(this.claim.owner_role)} TEMPLATE template0`);
      await c.query(`REVOKE CONNECT ON DATABASE ${q(this.claim.database_name)} FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE ${q(this.claim.database_name)} TO ${q(this.claim.import_role)},${q(this.claim.tile_role)},${q(this.claim.qa_role)}`);
      for(const role of [this.claim.tile_role,this.claim.qa_role]){
        await c.query(`ALTER ROLE ${q(role)} SET default_transaction_read_only=on`);
        await c.query(`ALTER ROLE ${q(role)} SET statement_timeout='${role===this.claim.tile_role?'10s':'1800s'}'`);
      }
    }finally{await c.end();}
    const db=await this.admin(this.claim.database_name);
    try{
      await db.query('CREATE EXTENSION postgis; REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA atlas_build; REVOKE ALL ON SCHEMA atlas_build FROM PUBLIC');
      await db.query('CREATE TABLE atlas_build.identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),build_id text,token text,source_sha256 text,payload_sha256 text,pipeline_sha256 text)');
      await db.query('INSERT INTO atlas_build.identity VALUES(true,$1,$2,$3,$4,$5)',[this.claim.id,this.claim.token,source.validation.source_sha256,this.claim.payload_sha256,this.claim.pipeline_sha256]);
      for(const schema of ['osm_raw','render','import_work'])await db.query(`CREATE SCHEMA ${q(schema)} AUTHORIZATION ${q(this.claim.import_role)}; REVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC`);
      await db.query('CREATE SCHEMA tiles; REVOKE ALL ON SCHEMA tiles FROM PUBLIC');
    }finally{await db.end();}
  }
  private labels(kind:string):string[]{return ['--label',`atlas.candidate.root=${sha256(this.config.root)}`,'--label',`atlas.candidate.job=${this.claim.id}`,'--label',`atlas.candidate.token=${this.claim.token}`,'--label',`atlas.candidate.kind=${kind}`];}
  private common(name:string,kind:string):string[]{return ['--pull','never','--name',name,...this.labels(kind),'--network',this.config.network,'--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'];}
  async import(source:VerifiedSource,signal:AbortSignal):Promise<void>{
    await this.queue.assertLive(this.claim);
    const r=this.config.repo;
    try{
      const result=await execute('docker',['run',...this.common(this.names.importer,'importer'),'--log-driver','none','--memory',String(this.config.importMemoryBytes),'--memory-swap',String(this.config.importMemoryBytes),'--cpus',String(this.config.importCpus),'--cpu-shares','128',
        '--env','PGPASSFILE=/run/secrets/import.pgpass','--mount',`type=bind,src=${join(this.directory,'import.pgpass')},dst=/run/secrets/import.pgpass,readonly`,
        '--mount',`type=bind,src=${source.path},dst=/in/input.osm.pbf,readonly`,
        ...[['infra/atlas/raw.lua','raw.lua'],['infra/atlas/catalog-observed.lua','render.lua'],['infra/atlas/catalog-details.lua','catalog-details.lua'],['infra/atlas/catalog-core-v2.lua','catalog-core.lua']].flatMap(([src,dst])=>['--mount',`type=bind,src=${join(r,src!)},dst=/config/${dst},readonly`]),
        '--entrypoint','osm2pgsql',this.config.importerImage,'--create','--slim','--drop','--extra-attributes','--middle-schema=import_work','--output=flex','--style=/config/raw.lua','--cache=256','--number-processes=1',
        '-H',this.config.dataHost,'-P',this.adminUri.port||'5432','-U',this.claim.import_role,'-d',this.claim.database_name,'/in/input.osm.pbf'],{signal,timeoutMs:this.config.timeoutMs,maxOutput:4*1024*1024});
      await writeFile(join(this.directory,'import.log'),Buffer.concat([result.stdout,result.stderr]),{flag:'wx',mode:0o600});
      if(result.code!==0)throw new IntakeError('candidate_import_failed');
    }finally{await this.stop('importer');}
  }
  async assertOwned():Promise<void>{
    const c=await this.admin();try{
      const row=(await c.query(`SELECT r.rolname,shobj_description(r.oid,'pg_authid') AS marker FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1`,[this.claim.database_name])).rows[0];
      if(!row||row.rolname!==this.claim.owner_role||row.marker!==this.identity())throw new IntakeError('foreign_candidate_database');
    }finally{await c.end();}
    const db=await this.admin(this.claim.database_name);try{
      const i=(await db.query('SELECT * FROM atlas_build.identity WHERE singleton')).rows[0];
      if(!i||i.build_id!==this.claim.id||i.token!==this.claim.token||i.payload_sha256!==this.claim.payload_sha256||i.pipeline_sha256!==this.claim.pipeline_sha256)throw new IntakeError('candidate_identity_mismatch');
    }finally{await db.end();}
  }
  async finalize():Promise<Record<string,unknown>>{
    await this.queue.assertLive(this.claim);await this.assertOwned();const db=await this.admin(this.claim.database_name);
    try{
      const metadata=(sql:string)=>metadataTransaction(db,sql,()=>this.queue.assertLive(this.claim),this.signal);
      await metadata(await readFile(join(this.config.repo,'infra/atlas/raw-finalize.sql'),'utf8'));
      await metadata(await readFile(join(this.config.repo,'infra/atlas/catalog-topology.sql'),'utf8'));
      await metadata(tileSqlForRole(await readFile(join(this.config.repo,'infra/atlas/tiles-v2.sql'),'utf8'),this.claim.tile_role));
      await db.query(`REASSIGN OWNED BY ${q(this.claim.import_role)} TO ${q(this.claim.owner_role)}`);
      await db.query(`REVOKE ALL ON SCHEMA osm_raw,render,import_work FROM ${q(this.claim.import_role)}`);
      await db.query(`ALTER TABLE render.relation_topology OWNER TO ${q(this.claim.owner_role)}`);
      for(const layer of layers)await db.query(`ALTER MATERIALIZED VIEW tiles.${layer} OWNER TO ${q(this.claim.owner_role)}`);
      await db.query(`GRANT USAGE ON SCHEMA osm_raw,render,tiles,atlas_build TO ${q(this.claim.qa_role)}; GRANT SELECT ON ALL TABLES IN SCHEMA osm_raw,render,atlas_build TO ${q(this.claim.qa_role)}`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA tiles TO ${q(this.claim.qa_role)}; REVOKE ALL ON SCHEMA render FROM ${q(this.claim.tile_role)}; REVOKE ALL ON ALL TABLES IN SCHEMA render FROM ${q(this.claim.tile_role)}`);
      await db.query(`REVOKE EXECUTE ON FUNCTION tiles.basemap(integer,integer,integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION tiles.basemap(integer,integer,integer) TO ${q(this.claim.tile_role)},${q(this.claim.qa_role)}`);
      // DDL/GRANT must commit before statistics maintenance: autovacuum can hold
      // a relation lock while waiting for the catalog row changed by the GRANT.
      await metadata('ANALYZE');
      const version=(await db.query('SELECT version() AS postgres,postgis_full_version() AS postgis,pg_database_size(current_database())::text AS bytes')).rows[0];
      const admin=await this.admin();try{
        await admin.query(`ALTER ROLE ${q(this.claim.import_role)} NOLOGIN`);
        await admin.query(`REVOKE CONNECT ON DATABASE ${q(this.claim.database_name)} FROM ${q(this.claim.import_role)}`);
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()',[this.claim.database_name,this.claim.import_role]);
        await admin.query(`ALTER DATABASE ${q(this.claim.database_name)} SET default_transaction_read_only=on`);
      }finally{await admin.end();}
      return version;
    }finally{await db.end();}
  }
  async qaClient():Promise<pg.Client>{const client=new pg.Client({connectionString:await secretFile(join(this.directory,'qa.dsn')),connectionTimeoutMillis:30000,statement_timeout:Math.min(this.config.timeoutMs,1800000)});await client.connect();return client;}
  async martin(signal:AbortSignal):Promise<string>{
    await this.queue.assertLive(this.claim);
    const uri=this.uri(this.claim.tile_role,this.credentials.tilePassword,this.claim.database_name,this.config.dataHost);
    const cfg=`listen_addresses: '0.0.0.0:3000'\nworker_processes: 1\ncache_size_mb: 0\nweb_ui: disable\npostgres:\n  connection_string: ${JSON.stringify(uri)}\n  pool_size: 4\n  auto_publish: false\n  functions:\n    basemap:\n      schema: tiles\n      function: basemap\n      minzoom: 0\n      maxzoom: 16\n`;
    const path=join(this.directory,'martin.yml');await writeFile(path,cfg,{flag:'wx',mode:0o600});
    const result=await execute('docker',['run','--detach',...this.common(this.names.martin,'martin'),'--memory','512m','--memory-swap','512m','--cpus','1','--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=2',
      '--mount',`type=bind,src=${path},dst=/config/martin.yml,readonly`,this.config.martinImage,'--config','/config/martin.yml'],{signal,maxOutput:65536});
    if(result.code!==0)throw new IntakeError('candidate_martin_start_failed');
    const inspected=await execute('docker',['inspect',this.names.martin],{maxOutput:65536});
    if(inspected.code!==0)throw new IntakeError('candidate_martin_inspection_failed');
    const info=JSON.parse(inspected.stdout.toString())[0],ip=info.NetworkSettings.Networks[this.config.network]?.IPAddress;
    if(typeof ip!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(ip))throw new IntakeError('candidate_private_endpoint_missing');
    const url='http://'+ip+':3000';
    for(let i=0;i<40;i++){
      if(signal.aborted)throw new IntakeError('cancelled');
      try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(1500)});if(r.ok)return url;}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }throw new IntakeError('candidate_martin_unhealthy');
  }
  async stop(kind:'importer'|'martin'):Promise<void>{
    const name=this.names[kind],found=await execute('docker',['container','ls','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}'],{maxOutput:65536});
    if(found.code!==0)throw new IntakeError('candidate_inspection_failed');if(!found.stdout.toString().trim())return;
    const detail=await execute('docker',['inspect',name],{maxOutput:65536});if(detail.code!==0)throw new IntakeError('candidate_inspection_failed');
    const labels=JSON.parse(detail.stdout.toString())[0].Config.Labels??{};
    if(labels['atlas.candidate.job']!==this.claim.id||labels['atlas.candidate.token']!==this.claim.token||labels['atlas.candidate.root']!==sha256(this.config.root)||labels['atlas.candidate.kind']!==kind)throw new IntakeError('foreign_candidate_container');
    const removed=await execute('docker',['rm','--force',name],{maxOutput:65536});if(removed.code!==0)throw new IntakeError('candidate_container_removal_failed');
  }
  /** Only after a durable guard has fenced this exact failed attempt and stopped its worker. */
  async quiesceGuard(target:Record<string,unknown>|null):Promise<Record<string,unknown>>{
    await this.stop('importer');await this.stop('martin');
    const profile=await this.verifyDataProfile(),admin=await this.admin();
    const roles=[this.claim.owner_role,this.claim.import_role,this.claim.tile_role,this.claim.qa_role];
    try{
      const identifier=(await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
      const found=(await admin.query("SELECT rolname,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=ANY($1)",[roles])).rows;
      const exists=Boolean((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[this.claim.database_name])).rowCount);
      if(!target){
        // Target recording precedes all role/database allocation. Never guess where an unbound target lives.
        if(exists||found.length)throw new IntakeError('guard_unbound_data_resources');
        return {containers_stopped:true,backends_stopped:true,roles_disabled:true,data_allocated:false};
      }
      const volumeKeys=(v:unknown)=>Array.isArray(v)?v.map(r=>`${r.type}/${r.name}/${r.destination}`).sort().join('|'):null;
      if(target.kind!=='postgresql'||target.container!==this.config.dataContainer||target.image!==this.config.dataImage||target.system_identifier!==identifier||volumeKeys(target.volumes)!==volumeKeys(profile.volumes))throw new IntakeError('guard_data_target_changed');
      if(found.some(r=>r.marker!==this.identity()))throw new IntakeError('foreign_candidate_role');
      if(exists)await this.assertOwned();
      // A partially provisioned database without a valid identity remains held for explicit investigation.
      const loginRoles=found.filter(r=>r.rolname!==this.claim.owner_role).map(r=>r.rolname);
      await admin.query('BEGIN');
      try{
        for(const role of loginRoles){
          await admin.query(`ALTER ROLE ${q(role)} NOLOGIN PASSWORD NULL`);
          if(exists)await admin.query(`REVOKE CONNECT ON DATABASE ${q(this.claim.database_name)} FROM ${q(role)}`);
        }
        await admin.query('COMMIT');
      }catch(error){await admin.query('ROLLBACK').catch(()=>undefined);throw error;}
      const me=(await admin.query('SELECT current_user AS name')).rows[0].name;
      const terminated=(await admin.query(`SELECT pid,pg_terminate_backend(pid) AS signalled FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND ((datname=$1 AND usename=ANY($2)) OR (usename=$3 AND application_name=$4))`,[this.claim.database_name,loginRoles,me,this.adminApplication()])).rows;
      let remaining=1;
      for(let i=0;i<30;i++){
        remaining=(await admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND (datname=$1 OR (usename=$2 AND application_name=$3))",[this.claim.database_name,me,this.adminApplication()])).rows[0].n;
        if(!remaining)break;await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(remaining)throw new IntakeError('guard_backends_remain');
      const login=(await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1) AND rolcanlogin',[roles])).rows;
      if(login.length)throw new IntakeError('guard_roles_remain_enabled');
      return {containers_stopped:true,backends_stopped:true,roles_disabled:true,data_allocated:exists,system_identifier:identifier,terminated_backends:terminated.length};
    }finally{await admin.end();}
  }
  private adminApplication():string{return 'atlas-build/'+this.claim.id.slice(0,12)+'/'+this.claim.token;}
  endpointName():string{return this.names.martin;}
  dataTarget():Record<string,unknown>{if(!this.target)throw new IntakeError('data_target_not_bound');return this.target;}
}
