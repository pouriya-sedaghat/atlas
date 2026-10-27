import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const directory=resolve('apps/ingest/dist');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=Object.fromEntries(readdirSync(directory).filter(n=>/\.(js|sql|py)$/.test(n)).sort().map(name=>[name,hash(readFileSync(join(directory,name)))]));
const identity={schema:'atlas.ingest-build/1',node_version:process.versions.node,package_lock_sha256:hash(readFileSync('package-lock.json')),files};
writeFileSync(join(directory,'build-id.json'),JSON.stringify({...identity,sha256:hash(JSON.stringify(identity))},null,2)+'\n');
