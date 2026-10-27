-- Flex serializes an empty Lua table as {}, whereas an empty member list is [].
-- Normalize only that representation, without removing or reordering any member.
UPDATE osm_raw.relations SET members='[]'::jsonb WHERE members='{}'::jsonb;
ALTER TABLE osm_raw.relations ADD CONSTRAINT ordered_members_array CHECK(jsonb_typeof(members)='array');
ALTER TABLE osm_raw.nodes ADD CONSTRAINT raw_node_tags_object CHECK(jsonb_typeof(tags)='object');
ALTER TABLE osm_raw.ways ADD CONSTRAINT raw_way_tags_object CHECK(jsonb_typeof(tags)='object');
ALTER TABLE osm_raw.relations ADD CONSTRAINT raw_relation_tags_object CHECK(jsonb_typeof(tags)='object');
