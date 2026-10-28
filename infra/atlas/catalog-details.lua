-- Atlas detail overlays v1. Source geometry and tag values are retained literally.
-- Generic point annotations are not inferred lines/areas or a claim of semantic truth.
-- Family IDs are persistent MVT identity components and must never be reassigned.
local family_ids={power=1,barrier=2,aeroway=3,aerialway=4,man_made=5,natural=6,transport=7,entrance=8,address=9}
local tables={}
for _,kind in ipairs({'point','linestring','multipolygon'}) do
    local name=({point='detail_points',linestring='detail_lines',multipolygon='detail_areas'})[kind]
    tables[kind]=osm2pgsql.define_table({name=name,schema='render',ids={type='any',id_column='osm_id',type_column='osm_type'},
        columns={{column='feature_id',type='int8',not_null=true},{column='family',type='text',not_null=true},
            {column='kind',type='text',not_null=true},{column='min_zoom',type='int2',not_null=true},
            {column='name',type='text'},{column='name_fa',type='text'},{column='name_en',type='text'},
            {column='ref',type='text'},{column='housenumber',type='text'},
            {column='tags',type='jsonb',not_null=true},{column='geom',type=kind,projection=3857,not_null=true}},
        indexes={{column='geom',method='gist'},{column='min_zoom',method='btree'}}})
end
local function set(values)local r={} for word in values:gmatch('%S+') do r[word]=true end return r end
local lines={power=set('line minor_line cable portal'),barrier=true,
    aeroway=set('runway taxiway'),aerialway=true,
    man_made=set('pipeline pier breakwater groyne embankment cutline dyke'),natural=set('cliff ridge arete earth_bank tree_row valley gorge gully flower_row')}
local areas={power=set('substation plant generator switchgear'),aeroway=set('aerodrome apron helipad heliport runway taxiway'),
    man_made=set('works wastewater_plant water_works storage_tank covered_reservoir')}
local points={power=set('tower pole portal generator transformer terminal connection switch catenary_mast inverter plant substation busbar compensator converter insulator switchgear voltage_regulator bay'),
    barrier=set('bollard gate lift_gate swing_gate sliding_gate kissing_gate stile cycle_barrier cattle_grid motorcycle_barrier block chain bus_trap border_control toll_booth fence wall hedge kerb entrance yes'),
    aeroway=set('aerodrome heliport helipad gate parking_position holding_position windsock navigationaid terminal beacon hangar'),
    aerialway=set('station pylon'),
    man_made=set('tower mast lighthouse water_tower chimney windmill communications_tower monitoring_station survey_point manhole water_well water_tap pumping_station cross mineshaft adit cairn beacon flagpole works storage_tank wastewater_plant water_works covered_reservoir silo telescope antenna obelisk gasometer petroleum_well'),
    natural=set('peak volcano saddle spring hot_spring tree stone rock boulder cave_entrance sinkhole waterfall hill cape promontory'),
    entrance=set('yes main service exit emergency staircase home garage'),address=true}
local transport_points={highway=set('traffic_signals crossing stop give_way motorway_junction turning_circle turning_loop bus_stop mini_roundabout emergency_access_point elevator street_lamp milestone speed_camera passing_place services rest_area trailhead toll_gantry traffic_mirror'),
    railway=set('crossing level_crossing halt station stop tram_stop buffer_stop signal switch rail_crossover milestone derail'),
    traffic_calming=set('bump hump table cushion chicane rumble_strip dip choker island yes mini_bumps double_dip'),
    crossing=set('traffic_signals uncontrolled unmarked zebra marked pelican toucan puffin yes island informal'),noexit=set('yes true 1')}
local barrier_lines=set('fence wall retaining_wall hedge ditch kerb city_wall guard_rail handrail chain gate lift_gate swing_gate sliding_gate yes')
local aerialway_lines=set('cable_car gondola chair_lift drag_lift t_bar j_bar platter rope_tow magic_carpet zip_line goods mixed_lift')
local function present(value)return value and value~='' and value~='no' end
local function geometry(object,osm_type,family,value,key)
    if osm_type=='N' then
        local accepted=family=='transport' and transport_points[key] or points[family]
        if accepted==true or type(accepted)=='table' and accepted[value] then return 'point',object:as_point(),16 end
        return nil,nil,nil,'unknown_value_or_primitive'
    end
    local explicit_area=object.tags.area=='yes' or object.tags.area=='true' or object.tags.area=='1'
    if family=='transport' and object.tags.highway and explicit_area then
        if osm_type=='W' and object.is_closed then return 'multipolygon',object:as_polygon(),14 end
        if osm_type=='R' and object.tags.type=='multipolygon' then return 'multipolygon',object:as_multipolygon(),14 end
        return nil,nil,nil
    end
    local area=areas[family] and areas[family][value]
    if osm_type=='R' then
        if object.tags.type=='multipolygon' and area then return 'multipolygon',object:as_multipolygon(),14 end
        return nil,nil,nil
    end
    local explicit_line=object.tags.area=='no'
    local is_line=(family=='barrier' and barrier_lines[value]) or (family~='barrier' and (lines[family]==true or type(lines[family])=='table' and lines[family][value]))
    if family=='aerialway' then is_line=aerialway_lines[value] end
    if area and object.is_closed and not explicit_line and (explicit_area or not is_line) then
        return 'multipolygon',object:as_polygon(),14
    end
    if is_line and not explicit_area then
        local zoom=(family=='aerialway' or family=='power' and value=='line') and 12 or 14
        return 'linestring',object:as_linestring(),zoom
    end
    return nil,nil,nil
end
return function(object,osm_type,core_outputs)
    local tags=object.tags
    local facets={}
    local selected={}
    for _,key in ipairs({'power','barrier','aeroway','aerialway','man_made','natural'}) do
        if present(tags[key]) then selected[#selected+1]={family=key,key=key,value=tags[key]} end
    end
    -- A family can have several qualifiers; choose a deterministic source key without
    -- implying those qualifiers are separately understood. All original tags stay in PostGIS.
    for _,key in ipairs({'highway','railway','traffic_calming','crossing','noexit'}) do
        if present(tags[key]) then selected[#selected+1]={family='transport',key=key,value=tags[key]};break end
    end
    if present(tags.entrance) then selected[#selected+1]={family='entrance',key='entrance',value=tags.entrance} end
    if present(tags['addr:housenumber']) then selected[#selected+1]={family='address',key='addr:housenumber',value=tags['addr:housenumber']} end
    for _,selection in ipairs(selected) do
        local family,value=selection.family,selection.value
        local shape,geom,zoom,reason=geometry(object,osm_type,family,value,selection.key)
        local facet={key=selection.key,value=value,status=reason or 'unsupported_geometry',scope='detail_overlay'}
        if not shape and ((family=='natural' and (core_outputs.water or core_outputs.landcover)) or
            (family=='transport' and core_outputs.transport) or (family=='address' and core_outputs.buildings)) then
            facet.status='core_layer_or_attribute'
        end
        if shape then
            facet.geometry=shape
            if geom:is_null() then facet.status='geometry_rejected'
            else
                -- Avoid MVT/JavaScript identity precision loss, even for hostile future inputs.
                if object.id>9007199254740 then error('detail feature identity exceeds safe integer range') end
                local code=({N=1,W=2,R=3})[osm_type]
                local inserted=tables[shape]:insert({feature_id=object.id*1000+code*100+family_ids[family],
                    family=family,kind=value,min_zoom=zoom,name=tags.name,name_fa=tags['name:fa'],name_en=tags['name:en'],
                    ref=tags.ref,housenumber=family=='address' and value or nil,tags=tags,geom=geom})
                facet.status=inserted and 'inserted' or 'geometry_rejected'
            end
        end
        facets[family]=facet
    end
    return facets
end
