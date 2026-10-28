import {readFileSync} from 'node:fs';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {layers} from './qa.js';
const connectionString=process.env.ATLAS_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('serving topology closure on real PostgreSQL',()=>{
  const pool=new pg.Pool({connectionString,connectionTimeoutMillis:5000,statement_timeout:10000});
  const member=(type:string,ref:number,role:string|null='')=>({type,ref,role});
  beforeAll(async()=>{
    const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    if(!String(db).startsWith('atlas_test'))throw Error('disposable database required');
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  });
  beforeEach(async()=>{
    await pool.query('DROP SCHEMA IF EXISTS osm_raw CASCADE; DROP SCHEMA IF EXISTS render CASCADE; DROP SCHEMA IF EXISTS tiles CASCADE; CREATE SCHEMA osm_raw; CREATE SCHEMA render; CREATE SCHEMA tiles');
    await pool.query('CREATE TABLE osm_raw.nodes(osm_id bigint PRIMARY KEY); CREATE TABLE osm_raw.ways(osm_id bigint PRIMARY KEY); CREATE TABLE osm_raw.relations(osm_id bigint PRIMARY KEY,tags jsonb,members jsonb); INSERT INTO osm_raw.nodes VALUES(20); INSERT INTO osm_raw.ways VALUES(10)');
    const relations=[
      [100,'boundary',[member('w',10),member('w',999)]],
      [101,'boundary',[member('w',10),member('r',100,'subarea')]],
      [102,'boundary',[member('w',10)]],
      [103,'boundary',[member('w',10),member('r',102,'outer')]],
      [104,'boundary',[member('w',10),member('r',102,'subarea')]],
      [105,'boundary',[member('w',10),member('r',102,null)]],
      [106,'multipolygon',[member('r',102,'label')]],
      [107,'route',[member('r',108)]],
      [108,'route',[member('r',107)]],
      [109,'boundary',[member('r',100),member('r',109)]],
    ];
    for(const [id,type,members]of relations)await pool.query('INSERT INTO osm_raw.relations VALUES($1,$2,$3)',[id,JSON.stringify({type}),JSON.stringify(members)]);
    for(const layer of layers){
      await pool.query(`CREATE TABLE render.${layer}(osm_type char(1),osm_id bigint,geom geometry(Point,3857)); INSERT INTO render.${layer} SELECT t, id, ST_SetSRID(ST_Point(1,1),3857) FROM (VALUES('N',20),('W',10),('R',999)) v(t,id)`);
      await pool.query(`INSERT INTO render.${layer} SELECT 'R',osm_id,ST_SetSRID(ST_Point(1,1),3857) FROM osm_raw.relations`);
    }
    await pool.query(readFileSync(new URL('../../../infra/atlas/catalog-topology.sql',import.meta.url),'utf8'));
  });
  afterAll(()=>pool.end());
  it('blocks direct and transitive missing references while retaining every raw/render row',async()=>{
    expect((await pool.query('SELECT osm_id::text FROM render.relation_topology WHERE blocked ORDER BY osm_id')).rows.map(r=>r.osm_id)).toEqual(['100','101','103','105','106','109']);
    expect((await pool.query('SELECT count(*)::integer n FROM osm_raw.relations')).rows[0].n).toBe(10);
    expect((await pool.query('SELECT count(*)::integer n FROM render.boundaries')).rows[0].n).toBe(13);
    for(const layer of layers)expect((await pool.query(`SELECT v.osm_id::text FROM tiles.${layer} v ORDER BY v.osm_id`)).rows.map(r=>r.osm_id)).toEqual(['10','20','102','104','107','108']);
  });
  it('treats unknown nested geometry conservatively and terminates relation cycles',async()=>{
    const rows=(await pool.query('SELECT osm_id::text,nested_geometry_members,blocked FROM render.relation_topology WHERE osm_id IN (103,104,105,106,107,108) ORDER BY osm_id')).rows;
    expect(rows.map(r=>[r.osm_id,r.nested_geometry_members,r.blocked])).toEqual([
      ['103',1,true],['104',0,false],['105',1,true],['106',1,true],['107',0,false],['108',0,false]]);
  });
  it('fails closed at snapshot construction for a relation missing its topology record',async()=>{
    expect((await pool.query("SELECT count(*)::integer n FROM tiles.boundaries WHERE osm_type='R' AND osm_id=999")).rows[0].n).toBe(0);
    // Test administrator rebuilds a snapshot; serving logins cannot refresh it.
    await pool.query('DELETE FROM render.relation_topology WHERE osm_id=102');
    await pool.query('REFRESH MATERIALIZED VIEW tiles.boundaries');
    expect((await pool.query("SELECT count(*)::integer n FROM tiles.boundaries WHERE osm_type='R' AND osm_id IN (102,999)")).rows[0].n).toBe(0);
  });
  it('uses the spatial index on the filtered snapshot for selective tile requests',async()=>{
    await pool.query("INSERT INTO render.transport SELECT 'N',1000+i,ST_SetSRID(ST_Point(i*1000,i*1000),3857) FROM generate_series(1,10000) i");
    await pool.query('REFRESH MATERIALIZED VIEW tiles.transport; ANALYZE tiles.transport');
    const plan=(await pool.query('EXPLAIN (FORMAT JSON) SELECT osm_id FROM tiles.transport WHERE geom && ST_MakeEnvelope(999900,999900,1000100,1000100,3857)')).rows[0]['QUERY PLAN'];
    expect(JSON.stringify(plan)).toContain('transport_geom_idx');
    expect((await pool.query('SELECT osm_id::text FROM tiles.transport WHERE geom && ST_MakeEnvelope(999900,999900,1000100,1000100,3857)')).rows).toEqual([{osm_id:'2000'}]);
  });
});
