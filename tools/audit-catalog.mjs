// Read-only diagnosis of a sealed experimental candidate; never alters its manifest or data.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
const [manifestPath,output]=process.argv.slice(2),dsnPath=process.env.ATLAS_CATALOG_CONNECTION_FILE;
if(!manifestPath||!output||!dsnPath)throw Error('usage: ATLAS_CATALOG_CONNECTION_FILE=private-qa.dsn node tools/audit-catalog.mjs MANIFEST REPORT');
const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes),uri=(await readFile(dsnPath,'utf8')).trim();
const database=new URL(uri).pathname.slice(1);
if(!/^atlas_candidate_[0-9a-f]{24}_[0-9a-f]{16}$/.test(database)||database!==manifest.postgis.database||manifest.scope!=='experimental_source_only')throw Error('sealed experimental candidate required');
const client=new pg.Client({connectionString:uri,connectionTimeoutMillis:5000,statement_timeout:1800000,application_name:'atlas-catalog-audit'});
const sha=b=>createHash('sha256').update(b).digest('hex');
const raw=`SELECT 'N'::char(1) AS osm_type,osm_id,tags FROM osm_raw.nodes WHERE tags<>'{}'::jsonb
 UNION ALL SELECT 'W'::char(1),osm_id,tags FROM osm_raw.ways WHERE tags<>'{}'::jsonb
 UNION ALL SELECT 'R'::char(1),osm_id,tags FROM osm_raw.relations WHERE tags<>'{}'::jsonb`;
const domains=['power','barrier','natural','man_made','aeroway','aerialway','highway','railway','waterway','boundary','landuse','building','type','route','entrance','traffic_calming','crossing','public_transport','emergency'];
const started=performance.now();await client.connect();let report;
try{
 if((await client.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only!=='on')throw Error('read-only QA role required');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const identity=(await client.query('SELECT * FROM atlas_build.identity WHERE singleton')).rows[0];
 if(identity.build_id!==manifest.id||identity.token!==manifest.attempt||identity.source_sha256!==manifest.source.sha256||identity.pipeline_sha256!==manifest.pipeline_sha256)throw Error('database identity mismatch');
 console.log('auditing all tag keys');
 const keys=(await client.query(`WITH objects AS MATERIALIZED (${raw})
 SELECT r.osm_type,k.key,count(*)::integer AS objects,
 count(*) FILTER(WHERE o.status='rendered')::integer AS with_rendered_object,
 count(*) FILTER(WHERE o.status='uncatalogued')::integer AS uncatalogued_object
 FROM objects r JOIN render.object_outcomes o USING(osm_type,osm_id),LATERAL jsonb_object_keys(r.tags) k(key)
 GROUP BY r.osm_type,k.key ORDER BY r.osm_type,k.key`)).rows;
 if(keys.length>50000)throw Error('key inventory export bound exceeded');
 console.log('auditing semantic values across all objects, including already rendered objects');
 const values=(await client.query(`WITH objects AS MATERIALIZED (${raw}), grouped AS (
 SELECT r.osm_type,k.key,k.value,count(*)::integer AS objects,
 count(*) FILTER(WHERE o.status='rendered')::integer AS with_rendered_object,
 count(*) FILTER(WHERE o.status='uncatalogued')::integer AS uncatalogued_object
 FROM objects r JOIN render.object_outcomes o USING(osm_type,osm_id),LATERAL jsonb_each_text(r.tags) k(key,value)
 WHERE k.key=ANY($1) GROUP BY r.osm_type,k.key,k.value)
 SELECT *,count(*) OVER()::integer AS total_groups FROM grouped ORDER BY osm_type,key,objects DESC,value LIMIT 20000`,[domains])).rows;
 const geometry=(await client.query(`WITH objects AS MATERIALIZED (${raw})
 SELECT r.osm_type,r.osm_id::text,r.tags,o.status,o.outputs,o.issues,o.geometry_probes,
 CASE WHEN r.osm_type='W' THEN (SELECT count(*)::integer FROM osm_raw.ways w,LATERAL unnest(w.nodes) id JOIN osm_raw.nodes n ON n.osm_id=id WHERE w.osm_id=r.osm_id) END AS available_node_references,
 CASE WHEN r.osm_type='W' THEN (SELECT count(DISTINCT ST_AsEWKB(n.geom))::integer FROM osm_raw.ways w,LATERAL unnest(w.nodes) id JOIN osm_raw.nodes n ON n.osm_id=id WHERE w.osm_id=r.osm_id) END AS distinct_coordinates,
 CASE WHEN r.osm_type='R' THEN (SELECT count(*)::integer FROM osm_raw.relations a,LATERAL jsonb_array_elements(a.members) m WHERE a.osm_id=r.osm_id) END AS relation_members
 FROM objects r JOIN render.object_outcomes o USING(osm_type,osm_id) WHERE o.status IN ('partial','geometry_rejected') ORDER BY r.osm_type,r.osm_id LIMIT 1000`)).rows;
 console.log('auditing nested relation roles');
 const nested=(await client.query(`SELECT coalesce(r.tags->>'type','<missing>') AS relation_type,m->>'role' AS role,count(*)::integer AS members,count(DISTINCT r.osm_id)::integer AS relations,
 count(*) FILTER(WHERE EXISTS(SELECT FROM osm_raw.relations child WHERE child.osm_id=(m->>'ref')::bigint))::integer AS available
 FROM osm_raw.relations r,LATERAL jsonb_array_elements(r.members) m WHERE m->>'type'='r'
 GROUP BY r.tags->>'type',m->>'role' ORDER BY relation_type,role`)).rows;
 const overlaps=(await client.query(`WITH objects AS MATERIALIZED (${raw}) SELECT r.osm_type,count(*)::integer AS objects,
 count(*) FILTER(WHERE o.status='rendered')::integer AS already_rendered
 FROM objects r JOIN render.object_outcomes o USING(osm_type,osm_id)
 WHERE (r.tags ?| ARRAY['power','barrier','aeroway','aerialway','man_made','entrance','traffic_calming','crossing'])
 GROUP BY r.osm_type ORDER BY r.osm_type`)).rows;
 await client.query('COMMIT');
 const truncated=(values[0]?.total_groups??0)>values.length;for(const row of values)delete row.total_groups;
 report={schema:'atlas.catalog-audit/1',tool_sha256:sha(await readFile(new URL(import.meta.url))),source_sha256:identity.source_sha256,manifest_sha256:sha(bytes),database_identity:identity,
 keys,semantic_values:{domains,groups:values,truncated},geometry_issues:{examples:geometry,limit:1000},nested_relation_roles:nested,detail_family_overlap:overlaps,
 elapsed_s:Math.round((performance.now()-started)/10)/100,read_only:true,interpretation:'object-level rendered status does not prove that each semantic tag family is supported',production_publication_approved:false};
}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client.end();}
if(Buffer.byteLength(JSON.stringify(report))>8*1024*1024)throw Error('inventory report export bound exceeded');
await writeFile(output+'.partial',JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(output+'.partial',output);
console.log(JSON.stringify({completed:true,keys:report.keys.length,semantic_groups:report.semantic_values.groups.length,truncated:report.semantic_values.truncated,geometry_examples:report.geometry_issues.examples.length}));
