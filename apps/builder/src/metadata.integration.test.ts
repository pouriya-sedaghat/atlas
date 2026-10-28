import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {metadataTransaction} from './data.js';

const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('candidate metadata transactions on real PostgreSQL',()=>{
  const pool=new pg.Pool({connectionString,connectionTimeoutMillis:30000,statement_timeout:10000});
  const schema='metadata_regression';
  let ownsSchema=false;
  beforeAll(async()=>{
    const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    if(!String(name).startsWith('atlas_test'))throw Error('disposable database required');
    await pool.query(`CREATE SCHEMA ${schema}; CREATE MATERIALIZED VIEW ${schema}.snapshot AS SELECT 1 AS n; CREATE TABLE ${schema}.counter(n integer PRIMARY KEY); INSERT INTO ${schema}.counter VALUES(0)`);
    ownsSchema=true;
  });
  afterAll(async()=>{try{if(ownsSchema)await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}});
  async function waiting(pid:number):Promise<void>{
    for(let i=0;i<100;i++){
      const row=(await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
      if(row?.wait_event_type==='Lock')return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw Error('expected lock wait was not observed');
  }
  async function clients(){
    const ddl=await pool.connect(),maintenance=await pool.connect();
    await ddl.query("SET deadlock_timeout='100ms'");
    await maintenance.query("SET deadlock_timeout='8s'");
    const pid=(await maintenance.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {ddl,maintenance,pid};
  }
  it('reproduces the GRANT/catalog versus VACUUM ANALYZE lock cycle',async()=>{
    const {ddl,maintenance,pid}=await clients();let vacuum:Promise<unknown>|undefined;
    try{
      await ddl.query(`REVOKE SELECT ON ${schema}.snapshot FROM PUBLIC; BEGIN; GRANT SELECT ON ${schema}.snapshot TO PUBLIC`);
      vacuum=maintenance.query(`VACUUM ANALYZE ${schema}.snapshot`).then(()=>null,error=>error);
      await waiting(pid);
      await expect(ddl.query(`ANALYZE ${schema}.snapshot`)).rejects.toMatchObject({code:'40P01'});
      await ddl.query('ROLLBACK');
      expect(await vacuum).toBeNull();
    }finally{
      await ddl.query('ROLLBACK');if(vacuum)await vacuum;
      ddl.release();maintenance.release();
    }
  });
  it('lets concurrent maintenance finish when the DDL transaction commits before ANALYZE',async()=>{
    const {ddl,maintenance,pid}=await clients();let vacuum:Promise<unknown>|undefined;
    try{
      await ddl.query(`REVOKE SELECT ON ${schema}.snapshot FROM PUBLIC; BEGIN; GRANT SELECT ON ${schema}.snapshot TO PUBLIC`);
      vacuum=maintenance.query(`VACUUM ANALYZE ${schema}.snapshot`).then(()=>null,error=>error);
      await waiting(pid);
      await ddl.query('COMMIT');
      await metadataTransaction(ddl,`ANALYZE ${schema}.snapshot`,async()=>{});
      expect(await vacuum).toBeNull();
    }finally{
      await ddl.query('ROLLBACK');if(vacuum)await vacuum;
      ddl.release();maintenance.release();
    }
  });
  it('retries the entire implicit batch after a real deadlock with no duplicate mutation',async()=>{
    const {ddl,maintenance}=await clients();let task:Promise<unknown>|undefined;let assertions=0;
    const pid=(await ddl.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    try{
      await pool.query(`UPDATE ${schema}.counter SET n=0`);
      await maintenance.query('BEGIN; SELECT pg_advisory_xact_lock(782416)');
      task=metadataTransaction(ddl,`UPDATE ${schema}.counter SET n=n+1; SELECT pg_advisory_xact_lock(782416)`,async()=>{assertions++;}).then(()=>null,error=>error);
      await waiting(pid);
      // This waits on the batch's UPDATE while the batch waits on our advisory lock.
      await maintenance.query(`UPDATE ${schema}.counter SET n=n+10`);
      await maintenance.query('ROLLBACK');
      expect(await task).toBeNull();
      expect(assertions).toBe(2);
      expect((await pool.query(`SELECT n FROM ${schema}.counter`)).rows).toEqual([{n:1}]);
    }finally{
      await maintenance.query('ROLLBACK');if(task)await task;
      ddl.release();maintenance.release();
    }
  });
  it('does not retry other SQL errors and preserves implicit rollback',async()=>{
    const ddl=await pool.connect();let assertions=0;
    try{
      await pool.query(`TRUNCATE ${schema}.counter; INSERT INTO ${schema}.counter VALUES(0)`);
      await expect(metadataTransaction(ddl,`UPDATE ${schema}.counter SET n=2; INSERT INTO ${schema}.counter VALUES(2)`,async()=>{assertions++;})).rejects.toMatchObject({code:'23505'});
      expect(assertions).toBe(1);
      expect((await pool.query(`SELECT n FROM ${schema}.counter`)).rows).toEqual([{n:0}]);
    }finally{ddl.release();}
  });
});
