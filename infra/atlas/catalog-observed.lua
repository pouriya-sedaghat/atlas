-- Observe core display rules plus explicit detail overlays; legacy runtime stays separate.
-- Each tagged primitive gets exactly one outcome; an attempted INSERT is not a success.
local native_define = osm2pgsql.define_table
local layers = {places=true,boundaries=true,water=true,waterways=true,landcover=true,transport=true,buildings=true,pois=true,
    detail_points=true,detail_lines=true,detail_areas=true}
local outcome = native_define({name='object_outcomes',schema='render',cluster='no',
    ids={type='any',id_column='osm_id',type_column='osm_type',create_index='primary_key'},
    columns={{column='status',type='text',not_null=true},{column='has_content',type='bool',not_null=true},
        {column='outputs',type='jsonb',not_null=true},{column='uncatalogued',type='bool',not_null=true},
        {column='issues',type='jsonb',not_null=true},{column='geometry_probes',type='jsonb',not_null=true},
        {column='detail_facets',type='jsonb',not_null=true}},indexes={}})
local current
osm2pgsql.define_table = function(definition)
    local real = native_define(definition)
    if definition.schema ~= 'render' then return real end
    return setmetatable({}, {__index=function(_,method)
        if method ~= 'insert' then return function(_,...) return real[method](real,...) end end
        return function(_,row)
            if definition.name=='uncatalogued' then
                current.deferred_uncatalogued={table=real,row=row}
                return true
            end
            local inserted,message,column = real:insert(row)
            if not current then error('catalog insert outside an observed callback') end
            local name=definition.name
            if inserted then
                if layers[name] then current.outputs[name]=(current.outputs[name] or 0)+1
                elseif name=='uncatalogued' then current.uncatalogued=true end
            else
                current.issues['insert:'..name..':'..tostring(column)]={code='insert_refused',layer=name,column=column,message=message}
            end
            return inserted,message,column
        end
    end})
end
dofile('/config/catalog-core.lua')
local details=dofile('/config/catalog-details.lua')
osm2pgsql.define_table = native_define

local metadata={created_by=true,source=true,note=true,fixme=true,FIXME=true,['seyra:fixture']=true}
local structural={type=true,area=true,layer=true}
local waterways={river=true,canal=true,stream=true,drain=true,ditch=true}
local poi_keys={'amenity','shop','tourism','leisure','office','healthcare','craft','historic','emergency','public_transport'}
local leisure_area={park=true,garden=true,pitch=true,playground=true,golf_course=true,nature_reserve=true,stadium=true,sports_centre=true,common=true,recreation_ground=true}
local function content(tags,legacy)
    for k,_ in pairs(tags) do
        if not metadata[k] and not (legacy and structural[k]) and not k:match('^source:') and not k:match('^note:') then return true end
    end
    return false
end
local function wants_area(t)
    return (t.natural and t.natural~='coastline') or t.waterway=='riverbank' or t.landuse or leisure_area[t.leisure] or (t.building and t.building~='no')
end
local function wants_poi(t)
    for _,k in ipairs(poi_keys) do if t[k] and t[k]~='' and t[k]~='no' then return true end end
    return false
end
local function probe(name,geometry)
    local missing=geometry:is_null()
    current.geometry_probes[name]=missing and 'null' or 'available'
    if missing then current.issues['geometry:'..name]={code='null_geometry',operation=name} end
end
local function observe(callback,kind)
    return function(object)
        if current then error('nested catalog callback') end
        current={outputs={},uncatalogued=false,issues={},geometry_probes={}}
        callback(object)
        local detail_facets=details(object,kind,current.outputs)
        for family,facet in pairs(detail_facets) do
            if facet.status=='geometry_rejected' then current.issues['detail:'..family]={code='detail_geometry_rejected',family=family} end
        end
        if not next(current.outputs) and current.deferred_uncatalogued then
            local pending=current.deferred_uncatalogued
            local inserted=pending.table:insert(pending.row)
            if not inserted then error('failed to persist uncatalogued object') end
            current.uncatalogued=true
        end
        -- Probe only otherwise unmapped objects for geometry operations implied by catalog tags.
        -- Geometry availability is not a proof of complete relation topology.
        local t=object.tags
        local area_output=current.outputs.water or current.outputs.landcover or current.outputs.buildings or current.outputs.places or current.outputs.pois
            if kind=='W' then
                if not area_output and object.is_closed and (wants_area(t) or t.place or wants_poi(t)) then probe('polygon',object:as_polygon()) end
                local line_output=current.outputs.transport or current.outputs.waterways or current.outputs.boundaries or current.outputs.places or current.outputs.pois
                if not line_output and ((t.highway and t.area~='yes' and t.area~='true' and t.area~='1') or (t.railway and t.railway~='platform' and t.railway~='station') or waterways[t.waterway] or t.natural=='coastline' or t.place or (not object.is_closed and wants_poi(t))) then
                    probe('linestring',object:as_linestring())
                end
            elseif kind=='R' then
                if not area_output and t.type=='multipolygon' and (wants_area(t) or t.place or wants_poi(t)) then probe('multipolygon',object:as_multipolygon()) end
                if not current.outputs.boundaries and t.type=='boundary' and t.boundary=='administrative' then probe('boundary_lines',object:as_multilinestring():line_merge()) end
            end
        local mapped=next(current.outputs)~=nil
        local issue=next(current.issues)~=nil
        local has_content=content(t)
        local status=issue and (mapped and 'partial' or 'geometry_rejected') or mapped and 'rendered' or current.uncatalogued and 'uncatalogued' or
          has_content and (content(t,true) and 'unaccounted' or 'catalog_policy_excluded') or 'metadata_only'
        local ok=outcome:insert({status=status,has_content=has_content,outputs=current.outputs,uncatalogued=current.uncatalogued,
            issues=current.issues,geometry_probes=current.geometry_probes,detail_facets=detail_facets})
        current=nil
        if not ok then error('failed to persist catalog outcome') end
    end
end
osm2pgsql.process_node=observe(osm2pgsql.process_node,'N')
osm2pgsql.process_way=observe(osm2pgsql.process_way,'W')
osm2pgsql.process_relation=observe(osm2pgsql.process_relation,'R')
