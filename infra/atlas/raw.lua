-- Atlas canonical primitive archive. Never delete it with osm2pgsql's temporary middle.
-- Tags and ordered references are retained even if no display layer classifies an object.
local function metadata_columns()
    return {
        {column='tags', type='jsonb', not_null=true},
        {column='source_version', type='int4'},
        {column='source_timestamp', type='timestamptz'},
        {column='source_changeset', type='int8'},
        {column='source_uid', type='int4'},
        {column='source_user', type='text'},
    }
end

local function define(name, kind, extra)
    local columns = metadata_columns()
    for _, column in ipairs(extra) do table.insert(columns, column) end
    return osm2pgsql.define_table({name=name, schema='osm_raw',
        ids={type=kind, id_column='osm_id', create_index='always'}, columns=columns,
        indexes={{column='osm_id', method='btree', unique=true}}})
end

local nodes = define('nodes', 'node', {{column='geom', type='point', projection=4326, not_null=true}})
local ways = define('ways', 'way', {{column='nodes', sql_type='bigint[]', not_null=true}})
local relations = define('relations', 'relation', {{column='members', type='jsonb', not_null=true}})

local function metadata(object)
    local function present(value) return value and value ~= 0 and value ~= '' and value or nil end
    return {tags=object.tags, source_version=present(object.version), source_timestamp=present(object.timestamp),
        source_changeset=present(object.changeset), source_uid=present(object.uid), source_user=present(object.user)}
end

local function node(object)
    local row = metadata(object)
    row.geom = object:as_point()
    nodes:insert(row)
end

local function way(object)
    local row = metadata(object)
    -- sql_type alone uses flex's text conversion, so serialize the PostgreSQL array
    -- explicitly. IDs are numeric and validated before this script is executed.
    row.nodes = '{' .. table.concat(object.nodes, ',') .. '}'
    ways:insert(row)
end

local function relation(object)
    local row = metadata(object)
    -- JSONB arrays preserve the member order, role and nested relation references.
    row.members = object.members
    relations:insert(row)
end

-- Reuse the existing display catalog during the engine comparison. Its exclusions
-- no longer imply loss of source data: the canonical tables above are independent.
dofile('/config/render.lua')
local render_node = osm2pgsql.process_node
local render_way = osm2pgsql.process_way
local render_relation = osm2pgsql.process_relation
osm2pgsql.process_node = function(o) node(o); render_node(o) end
osm2pgsql.process_way = function(o) way(o); render_way(o) end
osm2pgsql.process_relation = function(o) relation(o); render_relation(o) end
osm2pgsql.process_untagged_node = node
osm2pgsql.process_untagged_way = way
osm2pgsql.process_untagged_relation = relation
