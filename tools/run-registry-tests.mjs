import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const password = readFileSync(process.env.ATLAS_TEST_DB_PASSWORD_FILE ?? '/run/secrets/db_password','utf8').trim();
const database = process.env.ATLAS_TEST_DB_NAME ?? 'atlas_test_registry';
if (!/^atlas_test[a-z0-9_]*$/.test(database)) throw new Error('a dedicated atlas_test* database is required');
const uri = new URL(`postgresql://atlas_admin@db/${database}`);
uri.password = password;
const run = spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--root','packages/releases'],{
  env:{...process.env,ATLAS_TEST_DATABASE_URL:uri.toString()},stdio:'inherit',
});
process.exit(run.status ?? 1);
