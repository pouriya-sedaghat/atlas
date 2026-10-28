-- Atlas core catalog v2, derived from the supplied Seyra catalog; legacy serving is separate.
--
-- Every row keeps the stable OSM identity (osm_type + osm_id), the original name strings and the
-- complete original tag set (jsonb) for inspection and re-import. Layer membership and native
-- minimum zoom follow docs/MAP_SERVICES_REQUIREMENTS.md "Map catalog v1". Objects carrying tags
-- that match no catalog layer are kept in render.uncatalogued so exclusions can be reported.
-- Geometries are stored in EPSG:3857 for MVT generation (osm2pgsql reprojects on insert).

local SRID = 3857
local SCHEMA = 'render'
local ANY_IDS = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' }

local function common_columns(geom_type, extra)
    local cols = {
        { column = 'feature_id', type = 'int8', not_null = true },
        { column = 'name', type = 'text' },
        { column = 'name_fa', type = 'text' },
        { column = 'name_en', type = 'text' },
        { column = 'min_zoom', type = 'int2', not_null = true },
    }
    for _, c in ipairs(extra or {}) do table.insert(cols, c) end
    table.insert(cols, { column = 'tags', type = 'jsonb', not_null = true })
    table.insert(cols, { column = 'geom', type = geom_type, projection = SRID, not_null = true })
    return cols
end

local function define(name, geom_type, extra)
    return osm2pgsql.define_table({
        name = name,
        schema = SCHEMA,
        ids = ANY_IDS,
        columns = common_columns(geom_type, extra),
        indexes = {
            { column = 'geom', method = 'gist' },
            { column = 'min_zoom', method = 'btree' },
        },
    })
end

local tables = {
    places = define('places', 'point', {
        { column = 'place', type = 'text', not_null = true },
        { column = 'population', type = 'int8' },
    }),
    boundaries = define('boundaries', 'multilinestring', {
        { column = 'admin_level', type = 'int2' },
    }),
    water = define('water', 'multipolygon', {
        { column = 'class', type = 'text', not_null = true },
    }),
    waterways = define('waterways', 'linestring', {
        { column = 'waterway', type = 'text', not_null = true },
    }),
    landcover = define('landcover', 'multipolygon', {
        { column = 'class', type = 'text', not_null = true },
        { column = 'subclass', type = 'text', not_null = true },
    }),
    transport = define('transport', 'linestring', {
        { column = 'class', type = 'text', not_null = true },
        { column = 'type', type = 'text', not_null = true },
        { column = 'ref', type = 'text' },
        { column = 'bridge', type = 'bool' },
        { column = 'tunnel', type = 'bool' },
        { column = 'layer', type = 'int2' },
        { column = 'oneway', type = 'text' },
        { column = 'access', type = 'text' },
        { column = 'motorcycle', type = 'text' },
        { column = 'motor_vehicle', type = 'text' },
        { column = 'foot', type = 'text' },
        { column = 'z_order', type = 'int4' },
    }),
    buildings = define('buildings', 'multipolygon', {
        { column = 'building', type = 'text', not_null = true },
        { column = 'housenumber', type = 'text' },
    }),
    pois = define('pois', 'point', {
        { column = 'key', type = 'text', not_null = true },
        { column = 'value', type = 'text', not_null = true },
        { column = 'major', type = 'bool', not_null = true },
    }),
    uncatalogued = osm2pgsql.define_table({
        name = 'uncatalogued',
        schema = SCHEMA,
        ids = ANY_IDS,
        columns = {
            { column = 'primary_key', type = 'text' },
            { column = 'tags', type = 'jsonb', not_null = true },
            { column = 'geom', type = 'point', projection = 4326 },
        },
        indexes = {},
    }),
}

-- ------------------------------------------------------------------------------------------
-- Catalog rules
-- ------------------------------------------------------------------------------------------

local POI_KEYS = { 'amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic', 'emergency', 'public_transport' }

local MAJOR_POIS = {
    amenity = { hospital = true, university = true, college = true, fuel = true, police = true, fire_station = true, townhall = true,
                bus_station = true, place_of_worship = true, mosque = true, courthouse = true, marketplace = true },
    healthcare = { hospital = true },
    tourism = { museum = true, attraction = true, hotel = true, zoo = true },
    public_transport = { station = true },
    leisure = { stadium = true },
    historic = { castle = true, monument = true, archaeological_site = true },
    emergency = { ambulance_station = true },
    shop = { mall = true, department_store = true },
}

local PLACE_ZOOM = {
    country = 0, state = 3, province = 3, region = 4, city = 4, county = 6, town = 7, island = 9, village = 9,
    municipality = 9, borough = 10, suburb = 11, quarter = 12, hamlet = 13, neighbourhood = 13, locality = 13,
    isolated_dwelling = 14, farm = 14, square = 14, plot = 15, city_block = 15,
}

local HIGHWAY_ZOOM = {
    motorway = 4, trunk = 4, primary = 4, motorway_link = 8, trunk_link = 8, primary_link = 8,
    secondary = 8, secondary_link = 10, tertiary = 10, tertiary_link = 12,
    unclassified = 12, residential = 12, living_street = 12, road = 12, busway = 12,
}
local HIGHWAY_DETAIL_ZOOM = 14 -- service, track, path, footway, cycleway, steps, pedestrian, ...

local Z_ORDER = { motorway = 90, trunk = 80, primary = 70, secondary = 60, tertiary = 50, residential = 40, unclassified = 40,
                  service = 30, track = 20, footway = 10, path = 10, cycleway = 10, steps = 5 }

local WATER_AREA = { water = true, bay = true }
local WATER_LANDUSE = { reservoir = true, basin = true }
local WATERWAY_ZOOM = { river = 8, canal = 8, stream = 12, drain = 12, ditch = 12, coastline = 0 }
local LEISURE_LANDCOVER = { park = true, garden = true, pitch = true, playground = true, golf_course = true,
                            nature_reserve = true, stadium = true, sports_centre = true, common = true, recreation_ground = true }
local NATURAL_LOWZOOM = { wood = true, forest = true, scrub = true, heath = true, grassland = true, sand = true, bare_rock = true,
                          scree = true, wetland = true, glacier = true, beach = true, desert = true, salt_pond = true, mud = true }
local NATURAL_AREAS = {shrubbery=true,shingle=true,rock=true,shoal=true,fell=true,reef=true,grass=true,land=true,dune=true,tundra=true}
for key in pairs(NATURAL_LOWZOOM) do NATURAL_AREAS[key]=true end

-- Tags that carry no map meaning on their own (not counted as uncatalogued content).
local META_KEYS = { ['created_by'] = true, ['source'] = true, ['note'] = true, ['fixme'] = true, ['FIXME'] = true,
                    ['seyra:fixture'] = true, ['type'] = true, ['area'] = true, ['layer'] = true }

local function has_content_tags(tags)
    for k, _ in pairs(tags) do
        if not META_KEYS[k] and not k:match('^source:') and not k:match('^note:') then return true end
    end
    return false
end

local TYPE_CODE = { N = 1, W = 2, R = 3 }

local function feature_id(otype, id)
    -- Stable MVT feature id: osm id * 10 + type code (node=1, way=2, relation=3).
    return id * 10 + TYPE_CODE[otype]
end

local function names(tags)
    return tags.name, tags['name:fa'], tags['name:en']
end

local function yes(v)
    return v == 'yes' or v == 'true' or v == '1'
end

local function int_or_nil(v)
    if v == nil then return nil end
    if not tostring(v):match('^%-?%d+$') then return nil end
    local n = tonumber(v)
    if n == nil then return nil end
    if n < -32768 or n > 32767 then return nil end
    return n
end

local function population(v)
    if v == nil then return nil end
    local digits = v:gsub('[%s,%.]', '')
    if not digits:match('^%d+$') or #digits > 12 then return nil end
    return tonumber(digits)
end

local function base_row(otype, id, tags, min_zoom)
    local n, nfa, nen = names(tags)
    return { feature_id = feature_id(otype, id), name = n, name_fa = nfa, name_en = nen, min_zoom = min_zoom, tags = tags }
end

local function primary_poi(tags)
    for _, k in ipairs(POI_KEYS) do
        local v = tags[k]
        if v ~= nil and v ~= '' and v ~= 'no' then return k, v end
    end
    return nil, nil
end

local function insert_poi(otype, id, tags, point)
    local k, v = primary_poi(tags)
    if k == nil or point == nil then return false end
    local major = MAJOR_POIS[k] ~= nil and MAJOR_POIS[k][v] == true
    local row = base_row(otype, id, tags, major and 12 or 16)
    row.key, row.value, row.major, row.geom = k, v, major, point
    return tables.pois:insert(row)
end

local function area_layers(otype, id, tags, geom)
    -- geom: polygon/multipolygon (EPSG:3857). Returns true when any catalog layer took it.
    local matched = false
    local nat, landuse = tags.natural, tags.landuse
    if WATER_AREA[nat] or tags.waterway == 'riverbank' or WATER_LANDUSE[landuse] then
        local row = base_row(otype, id, tags, 0)
        row.class = (nat == 'bay') and 'bay' or 'water'
        row.geom = geom
        matched = tables.water:insert(row) or matched
    else
        if NATURAL_AREAS[nat] then
            local row = base_row(otype, id, tags, NATURAL_LOWZOOM[nat] and 0 or 8)
            row.class, row.subclass, row.geom = 'natural', nat, geom
            matched = tables.landcover:insert(row) or matched
        end
        if landuse ~= nil then
            local row = base_row(otype, id, tags, 8)
            row.class, row.subclass, row.geom = 'landuse', landuse, geom
            matched = tables.landcover:insert(row) or matched
        end
        if LEISURE_LANDCOVER[tags.leisure] then
            local row = base_row(otype, id, tags, 8)
            row.class, row.subclass, row.geom = 'leisure', tags.leisure, geom
            matched = tables.landcover:insert(row) or matched
        end
    end
    if tags.building ~= nil and tags.building ~= 'no' then
        local row = base_row(otype, id, tags, 14)
        row.building, row.housenumber, row.geom = tags.building, tags['addr:housenumber'], geom
        matched = tables.buildings:insert(row) or matched
    end
    return matched
end

local function record_uncatalogued(otype, tags, point)
    if not has_content_tags(tags) then return end
    local first
    for k, _ in pairs(tags) do
        if not META_KEYS[k] and not k:match('^source:') and not k:match('^note:') and (first == nil or k < first) then first = k end
    end
    tables.uncatalogued:insert({ primary_key = first, tags = tags, geom = point })
end

-- ------------------------------------------------------------------------------------------
-- Callbacks
-- ------------------------------------------------------------------------------------------

function osm2pgsql.process_node(object)
    local tags = object.tags
    local matched = false
    if tags.place ~= nil then
        local row = base_row('N', object.id, tags, PLACE_ZOOM[tags.place] or 14)
        row.place, row.population, row.geom = tags.place, population(tags.population), object:as_point()
        tables.places:insert(row)
        matched = true
    end
    if insert_poi('N', object.id, tags, object:as_point()) then matched = true end
    if not matched then record_uncatalogued('N', tags, object:as_point()) end
end

local function process_line_way(object, tags)
    local matched = false
    local hw = tags.highway
    if hw ~= nil and not yes(tags.area) then
        local row = base_row('W', object.id, tags, HIGHWAY_ZOOM[hw] or HIGHWAY_DETAIL_ZOOM)
        row.class, row.type, row.ref = 'highway', hw, tags.ref
        row.bridge = tags.bridge ~= nil and tags.bridge ~= 'no'
        row.tunnel = tags.tunnel ~= nil and tags.tunnel ~= 'no'
        row.layer = int_or_nil(tags.layer)
        row.oneway, row.access, row.motorcycle, row.motor_vehicle, row.foot = tags.oneway, tags.access, tags.motorcycle, tags.motor_vehicle, tags.foot
        row.z_order = Z_ORDER[hw] or 0
        row.geom = object:as_linestring()
        tables.transport:insert(row)
        matched = true
    end
    local rw = tags.railway
    if rw ~= nil and rw ~= 'platform' and rw ~= 'station' and not yes(tags.area) then
        local row = base_row('W', object.id, tags, (rw == 'rail') and 4 or 10)
        row.class, row.type, row.ref = 'railway', rw, tags.ref
        row.bridge = tags.bridge ~= nil and tags.bridge ~= 'no'
        row.tunnel = tags.tunnel ~= nil and tags.tunnel ~= 'no'
        row.layer = int_or_nil(tags.layer)
        row.z_order = 85
        row.geom = object:as_linestring()
        tables.transport:insert(row)
        matched = true
    end
    local ww = tags.waterway
    if (ww ~= nil and WATERWAY_ZOOM[ww] ~= nil and ww ~= 'coastline') or tags.natural == 'coastline' then
        local kind = (tags.natural == 'coastline') and 'coastline' or ww
        local row = base_row('W', object.id, tags, WATERWAY_ZOOM[kind])
        row.waterway, row.geom = kind, object:as_linestring()
        tables.waterways:insert(row)
        matched = true
    end
    if tags.boundary == 'administrative' and tags.admin_level ~= nil then
        local lvl = int_or_nil(tags.admin_level)
        local row = base_row('W', object.id, tags, 0)
        row.admin_level = lvl
        row.min_zoom = (lvl == nil and 11) or (lvl <= 2 and 0) or (lvl <= 4 and 3) or (lvl <= 6 and 6) or (lvl <= 8 and 9) or 11
        row.geom = object:as_linestring()
        tables.boundaries:insert(row)
        matched = true
    end
    return matched
end

function osm2pgsql.process_way(object)
    local tags = object.tags
    local matched = process_line_way(object, tags)
    if object.is_closed then
        local is_area_highway = tags.highway ~= nil and yes(tags.area)
        if not (tags.highway ~= nil and not is_area_highway) or tags.building ~= nil then
            local poly = object:as_polygon()
            if not poly:is_null() then
                if area_layers('W', object.id, tags, poly) then matched = true end
                if insert_poi('W', object.id, tags, poly:pole_of_inaccessibility()) then matched = true end
            end
        end
    elseif insert_poi('W', object.id, tags, object:as_linestring():centroid()) then
        matched = true
    end
    if tags.place ~= nil then
        local row = base_row('W', object.id, tags, PLACE_ZOOM[tags.place] or 14)
        local poly = object.is_closed and object:as_polygon() or nil
        local pt = (poly ~= nil and not poly:is_null()) and poly:pole_of_inaccessibility() or object:as_linestring():centroid()
        row.place, row.population, row.geom = tags.place, population(tags.population), pt
        tables.places:insert(row)
        matched = true
    end
    if not matched then record_uncatalogued('W', tags, nil) end
end

function osm2pgsql.process_relation(object)
    local tags = object.tags
    local rtype = tags.type
    local matched = false
    if rtype == 'boundary' and tags.boundary == 'administrative' then
        local lvl = int_or_nil(tags.admin_level)
        local row = base_row('R', object.id, tags, 0)
        row.admin_level = lvl
        row.min_zoom = (lvl == nil and 11) or (lvl <= 2 and 0) or (lvl <= 4 and 3) or (lvl <= 6 and 6) or (lvl <= 8 and 9) or 11
        row.geom = object:as_multilinestring():line_merge()
        if not row.geom:is_null() then
            tables.boundaries:insert(row)
            matched = true
        end
    elseif rtype == 'multipolygon' then
        local mp = object:as_multipolygon()
        if not mp:is_null() then
            if area_layers('R', object.id, tags, mp) then matched = true end
            if insert_poi('R', object.id, tags, mp:centroid()) then matched = true end
            if tags.place ~= nil then
                local row = base_row('R', object.id, tags, PLACE_ZOOM[tags.place] or 14)
                row.place, row.population, row.geom = tags.place, population(tags.population), mp:centroid()
                tables.places:insert(row)
                matched = true
            end
        end
    end
    if not matched then record_uncatalogued('R', tags, nil) end
end
