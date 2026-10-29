import {mkdtemp,cp,readFile,writeFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const source=resolve('docs/evidence/2026-10-29-admission'),checker=resolve('tools/verify-admission-evidence.mjs'),prefix=join(tmpdir(),'atlas-admission-evidence-'),root=await mkdtemp(prefix),results=[];
try{for(const [name,file,change]of [
 ['failed_io_erased','long-io.json',r=>{r.errors=0;}],
 ['admission_forged','postfix-main-state.json',r=>{r.policy.admission_enabled=true;}],
 ['unknown_collector_errors_forged','postfix-watch-death.json',r=>{r.collector_http_error_count=0;}]
]){const dir=join(root,name);await cp(source,dir,{recursive:true});const report=JSON.parse(await readFile(join(dir,file),'utf8'));change(report);await writeFile(join(dir,file),JSON.stringify(report,null,2)+'\n');let sums='';for(const f of (await readdir(dir)).filter(n=>n!=='SHA256SUMS').sort())sums+=createHash('sha256').update(await readFile(join(dir,f))).digest('hex')+'  '+f+'\n';await writeFile(join(dir,'SHA256SUMS'),sums);const test=spawnSync(process.execPath,[checker,dir],{encoding:'utf8',timeout:20000});assert.equal(test.error,undefined);assert.ok(test.status!==0);results.push({name,refused:true,checksum_inventory_recomputed:true});}
console.log(JSON.stringify({passed:true,source_evidence_modified:false,cases:results}));
}finally{assert.ok(root.startsWith(prefix));await rm(root,{recursive:true,force:true});}
