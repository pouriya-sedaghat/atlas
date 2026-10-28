// Real PostgreSQL/HTTP failure reporting tests on one owned disposable database.
import pg from 'pg';import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const connectionString=process.env.ATLAS_TEST_DATABASE_URL;assert(connectionString);
const admin=new pg.Client({connectionString,connectionTimeoutMillis:30000,statement_timeout:10000});await admin.connect();
const nonce=randomBytes(20).toString('hex'),name='atlas_candidate_'+nonce.slice(0,24)+'_'+nonce.slice(24),marker='atlas-tile-check-fixture:'+nonce;
assert.match(name,/^atlas_candidate_[0-9a-f]{24}_[0-9a-f]{16}$/);
const scratch=await mkdtemp(join(tmpdir(),'atlas-tile-failure-')),repo=fileURLToPath(new URL('..',import.meta.url));
const verifier=fileURLToPath(new URL('./verify-tiles.mjs',import.meta.url));const sha=b=>createHash('sha256').update(b).digest('hex');
let marked=false,fixture,httpStatus=503,requests=0;const cases=[];
const server=createServer((req,res)=>{requests++;res.writeHead(httpStatus);res.end();});
try{
 assert.ok(String((await admin.query('SELECT current_database() AS name')).rows[0].name).startsWith('atlas_test'),'explicit test parent required');
 await admin.query('CREATE DATABASE '+name+' TEMPLATE template0');await admin.query(`COMMENT ON DATABASE ${name} IS '${marker}'`);marked=true;
 const uri=new URL(connectionString);uri.pathname='/'+name;
 fixture=new pg.Client({connectionString:uri.toString(),connectionTimeoutMillis:30000,statement_timeout:10000});await fixture.connect();
 await fixture.query('CREATE SCHEMA tiles');await server.listen(0,'127.0.0.1');await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
 await writeFile(join(scratch,'connection.dsn'),uri.toString(),{mode:0o600});
 await writeFile(join(scratch,'options.json'),JSON.stringify({connectionFile:join(scratch,'connection.dsn'),martin:'http://127.0.0.1:'+server.address().port,sites:{fixture:[0,0]},warmup:false}),{mode:0o600});
 async function run(kind){
  const output=join(scratch,kind+'.json'),child=spawn(process.execPath,[verifier,output,'1'],{cwd:repo,env:{...process.env,ATLAS_TILE_CHECK_CONFIG_FILE:join(scratch,'options.json')},stdio:'ignore'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),30000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);assert.equal(code,1);
  const report=JSON.parse(await readFile(output,'utf8'));assert.equal(report.passed,false);return report;
 }
 await fixture.query("CREATE FUNCTION tiles.basemap(integer,integer,integer) RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture SQL deadline' USING ERRCODE='57014'; END $$");
 const sql=await run('sql_error');assert.equal(sql.failure.code,'57014');assert.equal(sql.failure.phase,'comparison_sql');assert.equal(requests,0);
 cases.push({name:'sql_error_report_persisted',passed:true,phase:sql.failure.phase,sqlstate:sql.failure.code,http_requests:0});
 await fixture.query("CREATE OR REPLACE FUNCTION tiles.basemap(integer,integer,integer) RETURNS bytea LANGUAGE sql AS $$ SELECT ''::bytea $$");
 const http=await run('http_error');assert.equal(http.failure.phase,'comparison_http');assert.match(http.failure.message,/HTTP 503/);assert.equal(requests,1);
 cases.push({name:'http_error_report_persisted',passed:true,phase:http.failure.phase,http_status:503});
 httpStatus=204;const empty=await run('empty_parity');assert.equal(empty.failure,null);assert.equal(empty.samples.length,4);assert.ok(empty.samples.every(r=>r.parity));assert.equal(requests,5);
 cases.push({name:'valid_empty_tiles_remain_quality_review',passed:true,technical_failure:false,samples:4});
}finally{
 await new Promise(resolve=>server.listening?server.close(resolve):resolve());if(fixture)await fixture.end().catch(()=>{});
 try{if(marked){assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[name])).rows[0]?.marker,marker);await admin.query('DROP DATABASE '+name+' WITH (FORCE)');}}finally{await admin.end();}
 const target=resolve(scratch);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('atlas-tile-failure-'));await rm(target,{recursive:true,force:false});
}
const report={schema:'atlas.tile-check-failure-tests/1',passed:true,count:cases.length,cases,owned_fixture_removed:true,
 verifier_sha256:sha((await readFile(verifier,'utf8')).replaceAll('\r\n','\n')),tool_sha256:sha((await readFile(new URL(import.meta.url),'utf8')).replaceAll('\r\n','\n'))};
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
