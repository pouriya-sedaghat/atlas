-- A drawable fragment is not proof that a relation is complete.
-- This table and the serving snapshots are built before freezing a fresh candidate.
-- Source/archive/render rows are never deleted or repaired by this policy.
CREATE TABLE render.relation_topology (
  osm_id bigint PRIMARY KEY,
  missing_members integer NOT NULL,
  nested_geometry_members integer NOT NULL,
  blocked boolean NOT NULL DEFAULT false
);
WITH members AS MATERIALIZED (
  SELECT r.osm_id,r.tags->>'type' AS relation_type,m.type,m.ref,m.role
  FROM osm_raw.relations r,
    LATERAL jsonb_to_recordset(r.members) AS m(type text,ref bigint,role text)
), counts AS (
  SELECT osm_id,
    count(*) FILTER (WHERE
      (type='n' AND NOT EXISTS(SELECT FROM osm_raw.nodes n WHERE n.osm_id=ref)) OR
      (type='w' AND NOT EXISTS(SELECT FROM osm_raw.ways w WHERE w.osm_id=ref)) OR
      (type='r' AND NOT EXISTS(SELECT FROM osm_raw.relations child WHERE child.osm_id=ref)))::integer AS missing_members,
    count(*) FILTER (WHERE type='r' AND
      (relation_type='multipolygon' OR (relation_type='boundary' AND coalesce(role,'') NOT IN ('subarea','admin_centre','label'))))::integer AS nested_geometry_members
  FROM members GROUP BY osm_id
)
INSERT INTO render.relation_topology(osm_id,missing_members,nested_geometry_members)
SELECT r.osm_id,coalesce(c.missing_members,0),coalesce(c.nested_geometry_members,0)
FROM osm_raw.relations r LEFT JOIN counts c USING(osm_id);

-- UNION terminates even when the source relation graph contains cycles.
WITH RECURSIVE parents AS MATERIALIZED (
  SELECT r.osm_id AS parent,m.ref AS child
  FROM osm_raw.relations r,LATERAL jsonb_to_recordset(r.members) AS m(type text,ref bigint,role text)
  WHERE m.type='r'
), affected(osm_id) AS (
  SELECT osm_id FROM render.relation_topology WHERE missing_members>0 OR nested_geometry_members>0
  UNION
  SELECT p.parent FROM parents p JOIN affected a ON a.osm_id=p.child
)
UPDATE render.relation_topology t SET blocked=true FROM affected a WHERE a.osm_id=t.osm_id;

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['water','landcover','waterways','boundaries','transport','buildings','places','pois','detail_points','detail_lines','detail_areas'] LOOP
    -- Persist the filtered rows. A security-barrier view prevents the non-leakproof
    -- PostGIS && predicate from reaching the base GiST index. A plain view would
    -- weaken isolation. These immutable snapshots contain no blocked rows at all.
    EXECUTE format('CREATE MATERIALIZED VIEW tiles.%I AS SELECT r.* FROM render.%I r
      WHERE r.osm_type IN (''N'',''W'') OR (r.osm_type=''R'' AND EXISTS
        (SELECT FROM render.relation_topology t WHERE t.osm_id=r.osm_id AND NOT t.blocked))',name,name);
    EXECUTE format('REVOKE ALL ON tiles.%I FROM PUBLIC',name);
    EXECUTE format('CREATE INDEX %I ON tiles.%I USING gist(geom)',name||'_geom_idx',name);
    EXECUTE format('ANALYZE tiles.%I',name);
  END LOOP;
END $$;
ANALYZE render.relation_topology;
