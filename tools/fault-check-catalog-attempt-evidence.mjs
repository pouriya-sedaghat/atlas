// Exercise policy barriers after recomputing the corrupted evidence's checksum inventory.
// Uses disposable copies only. Does not connect to a server or change the source evidence.
import {readFile,writeFile,readdir,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]??'docs/evidence/2026-10-28-catalog-attempt');
if(process.argv[3]){
 const destination=relative(root,resolve(process.argv[3]));
 assert.ok(destination==='..'||destination.startsWith('..'+sep)||isAbsolute(destination),'report must be outside the read-only source evidence');
}
const checker=fileURLToPath(new URL('./verify-catalog-attempt-evidence.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=path=>spawnSync(process.execPath,[checker,path],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
const positive=run(root);assert.equal(positive.status,0,positive.stderr);assert.equal(JSON.parse(positive.stdout).passed,true);
const entries=await readdir(root,{withFileTypes:true});assert.ok(entries.every(e=>e.isFile()&&!e.isSymbolicLink()));
const prefix='atlas-catalog-evidence-negative-',scratch=await mkdtemp(join(tmpdir(),prefix)),cases=[];
try{
 for(const name of ['publication_flag_forged','serving_failure_erased','raw_count_changed']){
  const directory=join(scratch,name);await mkdir(directory);
  for(const e of entries)await copyFile(join(root,e.name),join(directory,e.name));
  const json=async file=>JSON.parse(await readFile(join(directory,file),'utf8'));
  const save=async(file,value)=>writeFile(join(directory,file),JSON.stringify(value,null,2)+'\n');
  const summary=await json('verification-summary.json');
  if(name==='publication_flag_forged')summary.publishable=true;
  if(name==='serving_failure_erased'){summary.errors=0;summary.failures=[];}
  if(name==='raw_count_changed'){
   const raw=await json('latest-raw-roundtrip.json');raw.results.node.count++;
   await save('latest-raw-roundtrip.json',raw);
  }
  await save('verification-summary.json',summary);
  const inventory=[];
  for(const e of entries.filter(e=>e.name!=='SHA256SUMS').sort((a,b)=>a.name.localeCompare(b.name,'en')))
   inventory.push(sha(await readFile(join(directory,e.name)))+'  '+e.name);
  await writeFile(join(directory,'SHA256SUMS'),inventory.join('\n')+'\n');
  const result=run(directory);assert.notEqual(result.status,0,name);assert.match(result.stderr,/ERR_ASSERTION/,name+': '+result.stderr);
  cases.push({name,refused:true,checksum_inventory_recomputed:true});
 }
}finally{
 // Only remove the directory created by mkdtemp, never a user-supplied source path.
 const target=resolve(scratch);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith(prefix));
 await rm(target,{recursive:true,force:false});
}
const report={schema:'atlas.catalog-attempt-evidence-fault-tests/1',passed:true,positive_control_passed:true,source_evidence_changed:false,
 checker_sha256:sha((await readFile(checker,'utf8')).replaceAll('\r\n','\n')),cases,count:cases.length,
 fault_harness_sha256:sha((await readFile(new URL(import.meta.url),'utf8')).replaceAll('\r\n','\n')),
 scope:'local synthetic evidence corruption tests; no database, source approval or publication'};
if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
