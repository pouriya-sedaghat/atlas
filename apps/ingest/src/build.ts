import {readFile} from 'node:fs/promises';
import {IntakeError,object,sha256} from './contracts.js';
const expected=['build.js','cli.js','config.js','contracts.js','files.js','process.js','queue.js','roles.sql','schema.sql','secure_fs.py','signer.js','worker.js'];
export async function verifyBuild(expectedSha:string):Promise<void>{
  const record=object(JSON.parse(await readFile(new URL('./build-id.json',import.meta.url),'utf8'))),files=object(record.files);
  if(record.schema!=='atlas.ingest-build/1'||record.sha256!==expectedSha||Object.keys(files).sort().join('|')!==expected.sort().join('|')||
    record.node_version!==process.versions.node||record.package_lock_sha256!==sha256(await readFile(new URL('../../../package-lock.json',import.meta.url)))||
    sha256(JSON.stringify({schema:record.schema,node_version:record.node_version,package_lock_sha256:record.package_lock_sha256,files}))!==expectedSha)throw new IntakeError('controller_build_mismatch');
  for(const[name,digest]of Object.entries(files))if(sha256(await readFile(new URL(name,import.meta.url)))!==digest)throw new IntakeError('controller_file_mismatch');
}
