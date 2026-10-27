-- Same data and SQL for both engines. No client-supplied SQL, schema or relation name.
CREATE OR REPLACE FUNCTION tiles.basemap(z integer, x integer, y integer)
RETURNS bytea LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE SECURITY INVOKER
SET search_path = pg_catalog, public, render, tiles AS $$
DECLARE
    bounds geometry;
    buffered geometry;
    pixel double precision;
    result bytea := ''::bytea;
    tile_part bytea;
BEGIN
    IF z < 0 OR z > 16 OR x < 0 OR y < 0 OR x >= (1::bigint << z) OR y >= (1::bigint << z) THEN
        RAISE EXCEPTION 'invalid tile coordinates' USING ERRCODE = '22023';
    END IF;
    bounds := ST_TileEnvelope(z,x,y);
    buffered := ST_TileEnvelope(z,x,y,margin => 64.0/4096);
    pixel := 40075016.68557849 / (256.0 * (1::bigint << z));
    SELECT ST_AsMVT(t,'water',4096,'geom','feature_id') INTO tile_part FROM (
        SELECT ST_AsMVTGeom(CASE WHEN z < 14 THEN ST_SimplifyPreserveTopology(geom,pixel/2) ELSE geom END,bounds,4096,64) geom,
               feature_id,osm_type,osm_id,class,name,name_fa,name_en
        FROM render.water WHERE geom && buffered AND min_zoom <= z
          AND (z >= 12 OR ST_Area(geom) > 4*pixel*pixel)
    ) t; result := result || coalesce(tile_part,''::bytea);
    SELECT ST_AsMVT(t,'landcover',4096,'geom','feature_id') INTO tile_part FROM (
        SELECT ST_AsMVTGeom(CASE WHEN z < 14 THEN ST_SimplifyPreserveTopology(geom,pixel/2) ELSE geom END,bounds,4096,64) geom,
               feature_id,osm_type,osm_id,class,subclass,name,name_fa,name_en
        FROM render.landcover WHERE geom && buffered AND min_zoom <= z
          AND (z >= 12 OR ST_Area(geom) > 4*pixel*pixel)
    ) t; result := result || coalesce(tile_part,''::bytea);
    SELECT ST_AsMVT(t,'waterways',4096,'geom','feature_id') INTO tile_part FROM (
        SELECT ST_AsMVTGeom(CASE WHEN z < 14 THEN ST_Simplify(geom,pixel/2) ELSE geom END,bounds,4096,64) geom,
               feature_id,osm_type,osm_id,waterway,name,name_fa,name_en
        FROM render.waterways WHERE geom && buffered AND min_zoom <= z
    ) t; result := result || coalesce(tile_part,''::bytea);
    SELECT ST_AsMVT(t,'boundaries',4096,'geom','feature_id') INTO tile_part FROM (
        SELECT ST_AsMVTGeom(CASE WHEN z < 14 THEN ST_Simplify(geom,pixel/2) ELSE geom END,bounds,4096,64) geom,
               feature_id,osm_type,osm_id,admin_level,name,name_fa,name_en
        FROM render.boundaries WHERE geom && buffered AND min_zoom <= z
    ) t; result := result || coalesce(tile_part,''::bytea);
    IF z >= 4 THEN
        SELECT ST_AsMVT(t,'transport',4096,'geom','feature_id') INTO tile_part FROM (
            SELECT ST_AsMVTGeom(CASE WHEN z < 14 THEN ST_Simplify(geom,pixel/2) ELSE geom END,bounds,4096,64) geom,
                   feature_id,osm_type,osm_id,class,type,ref,bridge,tunnel,layer,oneway,access,motorcycle,motor_vehicle,foot,z_order,name,name_fa,name_en
            FROM render.transport WHERE geom && buffered AND min_zoom <= z ORDER BY z_order,feature_id
        ) t; result := result || coalesce(tile_part,''::bytea);
    END IF;
    IF z >= 14 THEN
        SELECT ST_AsMVT(t,'buildings',4096,'geom','feature_id') INTO tile_part FROM (
            SELECT ST_AsMVTGeom(geom,bounds,4096,64) geom,feature_id,osm_type,osm_id,building,housenumber,name,name_fa,name_en
            FROM render.buildings WHERE geom && buffered AND min_zoom <= z
        ) t; result := result || coalesce(tile_part,''::bytea);
    END IF;
    SELECT ST_AsMVT(t,'places',4096,'geom','feature_id') INTO tile_part FROM (
        SELECT ST_AsMVTGeom(geom,bounds,4096,64) geom,feature_id,osm_type,osm_id,place,population,name,name_fa,name_en
        FROM render.places WHERE geom && buffered AND min_zoom <= z ORDER BY population DESC NULLS LAST,feature_id
    ) t; result := result || coalesce(tile_part,''::bytea);
    IF z >= 12 THEN
        SELECT ST_AsMVT(t,'pois',4096,'geom','feature_id') INTO tile_part FROM (
            SELECT ST_AsMVTGeom(geom,bounds,4096,64) geom,feature_id,osm_type,osm_id,key,value,major,name,name_fa,name_en
            FROM render.pois WHERE geom && buffered AND min_zoom <= z ORDER BY major DESC,feature_id
        ) t; result := result || coalesce(tile_part,''::bytea);
    END IF;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION tiles.basemap(integer,integer,integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA tiles,render TO atlas_tile;
GRANT SELECT ON ALL TABLES IN SCHEMA render TO atlas_tile;
GRANT EXECUTE ON FUNCTION tiles.basemap(integer,integer,integer) TO atlas_tile;
COMMENT ON FUNCTION tiles.basemap(integer,integer,integer) IS
'{"description":"Atlas controlled basemap, catalog v1; canonical primitives retained separately","minzoom":0,"maxzoom":16,"attribution":"© OpenStreetMap contributors"}';
ANALYZE;
