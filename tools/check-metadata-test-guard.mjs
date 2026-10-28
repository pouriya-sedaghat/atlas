// Regression for a test hook: a refused database must never be cleaned up.
// Creates only its own disposable fixture on the already-authorized test server.
import pg from 'pg';import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
assert(connectionString,'ATLAS_TEST_DATABASE_URL required');
const admin=new pg.Client({connectionString,connectionTimeoutMillis:30000,statement_timeout:10000});await admin.connect();
const repo=fileURLToPath(new URL('..',import.meta.url)),token=randomBytes(8).toString('hex');
const name='atlas_guard_cleanup_'+token,marker='atlas-metadata-cleanup-guard:'+token;
assert.match(name,/^atlas_guard_cleanup_[0-9a-f]{16}$/);
const sha=b=>createHash('sha256').update(b).digest('hex');
let marked=false,report;
try{
 const parent=(await admin.query('SELECT current_database() AS name')).rows[0].name;
 assert.ok(String(parent).startsWith('atlas_test'),'parent must be an explicit disposable test database');
 await admin.query('CREATE DATABASE '+name+' TEMPLATE template0');
 await admin.query(`COMMENT ON DATABASE ${name} IS '${marker}'`);marked=true;
 const uri=new URL(connectionString);uri.pathname='/'+name;
 const fixture=new pg.Client({connectionString:uri.toString(),connectionTimeoutMillis:30000,statement_timeout:10000});await fixture.connect();
 try{
  await fixture.query('CREATE SCHEMA metadata_regression; CREATE TABLE metadata_regression.guardian(n integer PRIMARY KEY); INSERT INTO metadata_regression.guardian VALUES(42)');
  const before=(await fixture.query("SELECT 'metadata_regression.guardian'::regclass::oid AS oid")).rows[0].oid;
  const child=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--no-cache','--no-fsModuleCache','--root','apps/builder','src/metadata.integration.test.ts'],{
   cwd:repo,env:{...process.env,ATLAS_TEST_DATABASE_URL:uri.toString()},encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
  assert.equal(child.status,1,'the integration file must refuse this misnamed disposable fixture');
  assert.match(child.stdout+child.stderr,/disposable database required/);
  const after=(await fixture.query("SELECT 'metadata_regression.guardian'::regclass::oid AS oid")).rows[0].oid;
  assert.equal(after,before);assert.deepEqual((await fixture.query('SELECT n FROM metadata_regression.guardian')).rows,[{n:42}]);
  report={schema:'atlas.metadata-test-cleanup-guard/1',passed:true,misnamed_disposable_fixture:true,
   fixture_database:name,expected_integration_exit:1,original_table_oid_unchanged:true,original_rows_unchanged:true,
   metadata_test_sha256:sha((await readFile(new URL('../apps/builder/src/metadata.integration.test.ts',import.meta.url),'utf8')).replaceAll('\r\n','\n')),
   tool_sha256:sha((await readFile(new URL(import.meta.url),'utf8')).replaceAll('\r\n','\n')),
   scope:'test-hook refusal and cleanup regression on an owned disposable fixture; no production database targeted'};
 }finally{await fixture.end();}
}finally{
 try{if(marked){
  const row=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[name])).rows[0];
  assert.equal(row?.marker,marker,'refuse cleanup if fixture ownership marker changed');
  await admin.query('DROP DATABASE '+name+' WITH (FORCE)');
 }}finally{await admin.end();}
}
assert(report);report.owned_fixture_removed=true;
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
