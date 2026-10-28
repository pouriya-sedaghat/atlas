import type {Client} from 'pg';
import {IntakeError,type AuditReport} from '@atlas/ingest/contracts';
export const layers=['water','landcover','waterways','boundaries','transport','buildings','places','pois','detail_points','detail_lines','detail_areas'] as const;
/** All layer counters share one scan of the outcome archive; casts retain fail-closed validation. */
export async function observedLayerInserts(client:Pick<Client,'query'>):Promise<Record<typeof layers[number],number>>{
  // Identifiers and JSON keys come only from the fixed catalog, never from source tags or config.
  const columns=layers.map(name=>`coalesce(sum((outputs->>'${name}')::bigint),0)::integer AS ${name}`).join(',');
  return (await client.query(`SELECT ${columns} FROM render.object_outcomes`)).rows[0];
}
const tagged=`SELECT 'N'::char(1) AS osm_type,osm_id FROM osm_raw.nodes WHERE tags<>'{}'::jsonb
  UNION ALL SELECT 'W'::char(1),osm_id FROM osm_raw.ways WHERE tags<>'{}'::jsonb
  UNION ALL SELECT 'R'::char(1),osm_id FROM osm_raw.relations WHERE tags<>'{}'::jsonb`;
const missing=`WITH members AS MATERIALIZED (
  SELECT r.osm_id,r.tags,m.type,m.ref FROM osm_raw.relations r,LATERAL jsonb_to_recordset(r.members) AS m(type text,ref bigint,role text)
), missing AS MATERIALIZED (
  SELECT * FROM members m WHERE (m.type='n' AND NOT EXISTS(SELECT FROM osm_raw.nodes n WHERE n.osm_id=m.ref))
    OR (m.type='w' AND NOT EXISTS(SELECT FROM osm_raw.ways w WHERE w.osm_id=m.ref))
    OR (m.type='r' AND NOT EXISTS(SELECT FROM osm_raw.relations r WHERE r.osm_id=m.ref))
)`;
export interface Coverage {
  schema:string;accounting:{missing_outcomes:number;orphan_outcomes:number};outcomes:any[];layers:Record<string,any>;
  uncatalogued:any[];incomplete_relations:any[];incomplete_relation_examples:any[];relation_impact:any;
  review_reasons:string[];source_sha256:string;geographic_truth_verified:false;
  serving_integrity?:any;detail_facets?:any[];
}
export function reviewReasons(report:Omit<Coverage,'review_reasons'>):string[]{
  if(report.accounting.missing_outcomes||report.accounting.orphan_outcomes)throw new IntakeError('outcome_accounting_failed');
  const reasons:string[]=[];
  if(report.outcomes.some(r=>['geometry_rejected','partial'].includes(r.status)&&r.objects>0))reasons.push('geometry_conversion_issues');
  if(report.outcomes.some(r=>r.status==='unaccounted'&&r.objects>0))throw new IntakeError('unexplained_catalog_loss');
  if(report.outcomes.some(r=>['uncatalogued','catalog_policy_excluded'].includes(r.status)&&r.objects>0))reasons.push('catalog_coverage_incomplete');
  if(report.incomplete_relations.some(r=>r.missing_references>0))reasons.push('incomplete_source_topology');
  if(report.detail_facets?.some(r=>['unsupported_geometry','unknown_value_or_primitive'].includes(r.status)&&r.objects>0))reasons.push('detail_family_coverage_incomplete');
  if(report.serving_integrity){
    const s=report.serving_integrity;
    if(s.missing_topology_rows||s.blocked_rows_exposed)throw new IntakeError('serving_topology_integrity_failed');
    if(s.nested_geometry_relations>0)reasons.push('unsupported_nested_geometry');
  }
  for(const row of Object.values(report.layers)){
    if(row.invalid_geometries||row.empty_geometries||row.rows!==row.observed_inserts)throw new IntakeError('layer_integrity_failed');
    if(row.expected_served_rows!==undefined&&row.expected_served_rows!==row.served_rows)throw new IntakeError('serving_topology_integrity_failed');
  }
  return reasons;
}
export async function coverage(client:Client,audit:AuditReport):Promise<Coverage>{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const accounting=(await client.query(`WITH raw AS MATERIALIZED (${tagged})
      SELECT count(*) FILTER(WHERE o.osm_id IS NULL)::integer AS missing_outcomes,count(*) FILTER(WHERE r.osm_id IS NULL)::integer AS orphan_outcomes
      FROM raw r FULL JOIN render.object_outcomes o USING(osm_type,osm_id)`)).rows[0];
    const outcomes=(await client.query(`SELECT osm_type,status,count(*)::integer AS objects FROM render.object_outcomes GROUP BY osm_type,status ORDER BY osm_type,status`)).rows;
    const layerRows:Record<string,any>={},observed=await observedLayerInserts(client);
    for(const name of layers){
      layerRows[name]=(await client.query(`SELECT count(*)::integer AS rows,count(*) FILTER(WHERE ST_IsEmpty(geom))::integer AS empty_geometries,
        count(*) FILTER(WHERE NOT ST_IsValid(geom))::integer AS invalid_geometries,
        (SELECT count(*)::integer FROM tiles.${name}) AS served_rows,
        count(*) FILTER(WHERE osm_type IN ('N','W') OR (osm_type='R' AND EXISTS
          (SELECT FROM render.relation_topology t WHERE t.osm_id=render.${name}.osm_id AND NOT t.blocked)))::integer AS expected_served_rows,
        (SELECT count(*)::integer FROM tiles.${name} v JOIN render.relation_topology t ON v.osm_type='R' AND t.osm_id=v.osm_id WHERE t.blocked) AS blocked_rows_exposed
        FROM render.${name}`)).rows[0];
      layerRows[name].observed_inserts=observed[name];
      layerRows[name].withheld_rows=layerRows[name].rows-layerRows[name].served_rows;
      if(layerRows[name].withheld_rows<0)throw new IntakeError('serving_topology_integrity_failed');
    }
    const uncatalogued=(await client.query(`SELECT osm_type,coalesce(primary_key,'<none>') AS primary_key,count(*)::integer AS objects
      FROM render.uncatalogued GROUP BY osm_type,primary_key ORDER BY objects DESC,osm_type,primary_key LIMIT 80`)).rows;
    const incomplete=(await client.query(missing+` SELECT coalesce(tags->>'type','<missing>') AS relation_type,type AS member_type,
      count(*)::integer AS missing_references,count(DISTINCT osm_id)::integer AS affected_relations FROM missing
      GROUP BY tags->>'type',type ORDER BY count(*) DESC,relation_type,member_type`)).rows;
    const expected=Object.entries(audit.references.missing).filter(([k])=>k.startsWith('relation_to_')).reduce((sum,[,n])=>sum+n,0);
    if(incomplete.reduce((sum,r)=>sum+r.missing_references,0)!==expected)throw new IntakeError('missing_reference_accounting_failed');
    const examples=(await client.query(missing+`, affected AS (SELECT osm_id,tags,count(*)::integer AS missing_references FROM missing GROUP BY osm_id,tags)
      SELECT a.osm_id::text,a.tags->>'type' AS relation_type,a.tags->>'name' AS name,a.tags->>'admin_level' AS admin_level,
      a.missing_references,o.status,o.outputs,o.issues,o.geometry_probes FROM affected a LEFT JOIN render.object_outcomes o ON o.osm_type='R' AND o.osm_id=a.osm_id
      ORDER BY CASE a.tags->>'type' WHEN 'multipolygon' THEN 0 WHEN 'boundary' THEN 1 WHEN 'route' THEN 2 ELSE 3 END,a.osm_id LIMIT 40`)).rows;
    // UNION (not UNION ALL) reaches parents and terminates on relation cycles.
    const relationImpact=(await client.query(`WITH RECURSIVE members AS MATERIALIZED (
      SELECT r.osm_id,m.type,m.ref FROM osm_raw.relations r,LATERAL jsonb_to_recordset(r.members) AS m(type text,ref bigint,role text)
    ), direct AS MATERIALIZED (
      SELECT DISTINCT osm_id FROM members m WHERE (m.type='n' AND NOT EXISTS(SELECT FROM osm_raw.nodes n WHERE n.osm_id=m.ref))
        OR (m.type='w' AND NOT EXISTS(SELECT FROM osm_raw.ways w WHERE w.osm_id=m.ref))
        OR (m.type='r' AND NOT EXISTS(SELECT FROM osm_raw.relations r WHERE r.osm_id=m.ref))
    ), impacted(osm_id) AS (SELECT osm_id FROM direct UNION SELECT m.osm_id FROM members m JOIN impacted p ON m.type='r' AND m.ref=p.osm_id)
    SELECT (SELECT count(*)::integer FROM direct) AS directly_incomplete,(SELECT count(*)::integer FROM impacted) AS including_ancestor_relations,
      (SELECT count(*)::integer FROM impacted i JOIN render.object_outcomes o ON o.osm_type='R' AND o.osm_id=i.osm_id WHERE o.outputs<>'{}'::jsonb) AS with_some_rendered_output`)).rows[0];
    const topology=(await client.query(`SELECT count(*) FILTER(WHERE t.osm_id IS NULL)::integer AS missing_topology_rows,
      count(*) FILTER(WHERE t.blocked)::integer AS withheld_relations,
      count(*) FILTER(WHERE t.nested_geometry_members>0)::integer AS nested_geometry_relations
      FROM osm_raw.relations r LEFT JOIN render.relation_topology t USING(osm_id)`)).rows[0];
    const facets=(await client.query(`SELECT o.osm_type,f.key AS family,f.value->>'status' AS status,count(*)::integer AS objects
      FROM render.object_outcomes o,LATERAL jsonb_each(o.detail_facets) f(key,value)
      GROUP BY o.osm_type,f.key,f.value->>'status' ORDER BY o.osm_type,f.key,status`)).rows;
    const serving={...topology,blocked_rows_exposed:Object.values(layerRows).reduce((sum,r)=>sum+r.blocked_rows_exposed,0),
      policy:'withhold incomplete relations, their ancestors and unsupported geometric relation members; raw/render data retained'};
    const base={schema:'atlas.feature-coverage/2',source_sha256:audit.source.sha256,accounting,outcomes,layers:layerRows,uncatalogued,
      serving_integrity:serving,detail_facets:facets,
      incomplete_relations:incomplete,incomplete_relation_examples:examples,relation_impact:relationImpact,geographic_truth_verified:false as const};
    await client.query('COMMIT');return {...base,review_reasons:reviewReasons(base)};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
}
export async function tileSites(client:Client,region:string,bbox:AuditReport['bbox']):Promise<Record<string,[number,number]>>{
  if(region==='iran')return {tehran:[51.389,35.6892],mashhad:[59.6062,36.2605],shiraz:[52.5311,29.5918],tabriz:[46.2919,38.0962],ahvaz:[48.6692,31.3183],rural:[58.5,32.4]};
  const sites:Record<string,[number,number]>={};
  for(const name of ['pois','transport','water','buildings','places','landcover','detail_points','detail_lines','detail_areas']){
    const r=(await client.query(`SELECT ST_X(g) AS lon,ST_Y(g) AS lat FROM (SELECT ST_Transform(ST_PointOnSurface(geom),4326) g FROM tiles.${name} ORDER BY osm_id LIMIT 1) p`)).rows[0];
    if(r&&Number.isFinite(r.lon)&&Number.isFinite(r.lat)&&Math.abs(r.lat)<85.0511)sites[name]=[r.lon,r.lat];
  }
  if(!Object.keys(sites).length&&bbox)sites.extent=[(bbox[0]+bbox[2])/2,Math.max(-85,Math.min(85,(bbox[1]+bbox[3])/2))];
  return sites;
}
