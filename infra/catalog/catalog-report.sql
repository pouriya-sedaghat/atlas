-- Catalog coverage report (counts of distinct source objects, never summed across tiles).
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
SELECT json_build_object(
  'layers', (SELECT json_object_agg(layer, n) FROM (
      SELECT 'places' AS layer, count(DISTINCT (osm_type, osm_id)) AS n FROM render.places
      UNION ALL SELECT 'boundaries', count(DISTINCT (osm_type, osm_id)) FROM render.boundaries
      UNION ALL SELECT 'water', count(DISTINCT (osm_type, osm_id)) FROM render.water
      UNION ALL SELECT 'waterways', count(DISTINCT (osm_type, osm_id)) FROM render.waterways
      UNION ALL SELECT 'landcover', count(DISTINCT (osm_type, osm_id)) FROM render.landcover
      UNION ALL SELECT 'transport', count(DISTINCT (osm_type, osm_id)) FROM render.transport
      UNION ALL SELECT 'buildings', count(DISTINCT (osm_type, osm_id)) FROM render.buildings
      UNION ALL SELECT 'pois', count(DISTINCT (osm_type, osm_id)) FROM render.pois) s),
  'pois_by_key', (SELECT json_object_agg(key, n) FROM (SELECT key, count(*) AS n FROM render.pois GROUP BY key) s),
  'uncatalogued_total', (SELECT count(*) FROM render.uncatalogued),
  'uncatalogued_by_key', (SELECT coalesce(json_object_agg(primary_key, n), '{}'::json) FROM (
      SELECT coalesce(primary_key, '(none)') AS primary_key, count(*) AS n FROM render.uncatalogued GROUP BY 1 ORDER BY 2 DESC LIMIT 50) s),
  'release', (SELECT row_to_json(r) FROM render.seyra_release r LIMIT 1)
);
