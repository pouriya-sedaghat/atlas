import { readFileSync,writeFileSync,renameSync } from 'node:fs';
import pg from 'pg';
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: inspect-catalog.mjs REPORT.json');
const c=new pg.Client({host:'db',database:'atlas_lab',user:'atlas_admin',
  password:readFileSync('/run/secrets/db_password','utf8').trim(),statement_timeout:120000});
await c.connect();
const report={schema:'atlas.catalog-inspection/1',layers:{}};
try {
  report.versions=(await c.query('SELECT version() AS postgres,postgis_full_version() AS postgis')).rows[0];
  for(const name of ['water','landcover','waterways','boundaries','transport','buildings','places','pois']) {
    report.layers[name]=(await c.query(`SELECT count(*)::integer AS rows,
      count(*) FILTER(WHERE ST_IsEmpty(geom))::integer AS empty_geometries,
      count(*) FILTER(WHERE NOT ST_IsValid(geom))::integer AS invalid_geometries
      FROM render.${name}`)).rows[0];
  }
  report.uncatalogued=(await c.query('SELECT osm_type,count(*)::integer AS objects FROM render.uncatalogued GROUP BY osm_type ORDER BY osm_type')).rows;
  // This inspects only ~100k relations and their referenced identities, not a bounding-box guess.
  report.incomplete_relations=(await c.query(`WITH members AS MATERIALIZED (
    SELECT r.osm_id,r.tags,m.type,m.ref FROM osm_raw.relations r,
      LATERAL jsonb_to_recordset(r.members) AS m(type text,ref bigint,role text)
  ), missing AS MATERIALIZED (
    SELECT * FROM members m WHERE
      (m.type='n' AND NOT EXISTS(SELECT FROM osm_raw.nodes n WHERE n.osm_id=m.ref)) OR
      (m.type='w' AND NOT EXISTS(SELECT FROM osm_raw.ways w WHERE w.osm_id=m.ref)) OR
      (m.type='r' AND NOT EXISTS(SELECT FROM osm_raw.relations r WHERE r.osm_id=m.ref))
  ) SELECT coalesce(tags->>'type','<missing>') AS relation_type,type AS member_type,
      count(*)::integer AS missing_references,count(DISTINCT osm_id)::integer AS affected_relations
    FROM missing GROUP BY tags->>'type',type ORDER BY count(*) DESC`)).rows;
  report.database_bytes=Number((await c.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
  report.production_publication_approved=false;
} finally {await c.end();}
writeFileSync(`${output}.partial`,JSON.stringify(report,null,2)+'\n');renameSync(`${output}.partial`,output);
console.log(JSON.stringify(report,null,2));
