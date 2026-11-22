SELECT r.ordinal,r.kind,r.osm_id,r.block_no,r.record_line,r.record_sha256,r.semantic_sha256,
 i.info_present,i.missing_fields,i.version,i.timestamp_ticks,i.timestamp_ms,i.changeset,i.uid,i.user_sid,i.user_utf8,
 n.encoded_lat,n.encoded_lon,n.lat_nd,n.lon_nd,w.locations_present,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(t.position,encode(t.key_utf8,'hex'),encode(t.value_utf8,'hex')) ORDER BY t.position)
   FROM raw.tag t WHERE (t.source_id,t.ordinal)=(r.source_id,r.ordinal)),'[]') AS tags,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(f.position,f.node_id::text,f.lat_nd::text,f.lon_nd::text) ORDER BY f.position)
   FROM raw.way_ref f WHERE (f.source_id,f.ordinal)=(r.source_id,r.ordinal)),'[]') AS refs,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(m.position,m.target_kind,m.target_id::text,encode(m.role_utf8,'hex')) ORDER BY m.position)
   FROM raw.member m WHERE (m.source_id,m.ordinal)=(r.source_id,r.ordinal)),'[]') AS members
 FROM raw.object_record r LEFT JOIN raw.info i USING(source_id,ordinal)
 LEFT JOIN raw.node_value n USING(source_id,ordinal) LEFT JOIN raw.way_state w USING(source_id,ordinal)
 WHERE r.source_id=%s ORDER BY r.ordinal
