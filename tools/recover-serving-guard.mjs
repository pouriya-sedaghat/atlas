// Resume a committed guard incident; never enqueue or promote a failed build.
import pg from 'pg';
import {loadConfig} from '../apps/builder/dist/config.js';
import {ServingGuard} from '../apps/builder/dist/guard.js';
import {secretFile} from '../apps/ingest/dist/config.js';
const [path,id,unit='atlas-candidate-worker.service']=process.argv.slice(2);
if(!path||!id||!/^([0-9a-f]{64})$/.test(id))throw Error('usage: recover-serving-guard.mjs BUILD_CONFIG INCIDENT_SHA [FIXTURE_UNIT]');
const config=await loadConfig(path),pool=new pg.Pool({connectionString:await secretFile(config.controlDsnFile),connectionTimeoutMillis:5000,statement_timeout:10000,max:2});
try{const guard=new ServingGuard(config,path,pool,unit);await guard.recover(id);console.log(JSON.stringify({recovered:true,incident:id,failed_candidate_requeued:false}));}
catch(error){console.error(JSON.stringify({recovered:false,incident:id,code:error.code??'guard_recovery_failed',admission_must_remain_held:true}));process.exitCode=1;}
finally{await pool.end();}
