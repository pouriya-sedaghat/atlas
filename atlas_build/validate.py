"""Independent reconstruction from SQL columns, then actual spatial/reader checks.

No projection is recovered from record_line. Source-bearing SQL JSON aggregates
contain only numeric values and hexadecimal bytea; arbitrary text never enters
PostgreSQL's JSON domain. Named cursors fetch one bounded object at a time.
"""
import hashlib,json
from itertools import zip_longest
from pathlib import Path
from uuid import UUID,uuid5
import psycopg
from psycopg.rows import dict_row
from django.core.exceptions import ValidationError
from atlas_verification.control import canonical
from atlas_verification.records import canonical_line
from .stream import DecodeBudget,iter_ir
from .inputs import CheckedSpool
from .catalog import snapshot as schema_snapshot,fingerprint as schema_fingerprint,TABLES

KINDS=('node','way','relation')
PROJECTION=(Path(__file__).parent/'projection.sql').read_text()


def require(condition,message):
    if not condition:raise ValidationError(message)


def blob(value):return bytes(value) if value is not None else None

def decoded(value):return blob(value).decode('utf8')

def positioned(rows):
    require([x[0] for x in rows]==list(range(1,len(rows)+1)),'SQL child positions are not contiguous.')
    return [x[1:] for x in rows]


def reconstruct(row):
    require(row['info_present'] is not None,'SQL metadata row is absent.')
    info={'present':row['info_present'],'missing':row['missing_fields']}
    for column,key in [('version','version'),('timestamp_ticks','timestamp_ticks'),('timestamp_ms','timestamp_ms'),
                       ('changeset','changeset'),('uid','uid'),('user_sid','user_sid')]:
        if row[column] is not None:info[key]=str(row[column])
    if row['user_utf8'] is not None:info['user']=decoded(row['user_utf8'])
    record={'schema_version':1,'type':KINDS[row['kind']],'id':str(row['osm_id']),
            'ordinal':row['ordinal'],'block':row['block_no'],'metadata':info,
            'tags':[[bytes.fromhex(k).decode('utf8'),bytes.fromhex(v).decode('utf8')] for k,v in positioned(row['tags'])]}
    refs=positioned(row['refs']);members=positioned(row['members'])
    if row['kind']==0:
        require(row['encoded_lat'] is not None and row['encoded_lon'] is not None and row['lat_nd'] is not None and row['lon_nd'] is not None,'SQL node values are absent.')
        for column,key in [('encoded_lat','encoded_lat'),('encoded_lon','encoded_lon'),('lat_nd','lat_nanodegrees'),('lon_nd','lon_nanodegrees')]:
            record[key]=str(row[column])
        require(not refs and not members and row['locations_present'] is None,'SQL children disagree with node type.')
    elif row['kind']==1:
        require(row['locations_present'] is not None,'SQL optional-location state is absent.')
        record['refs']=[x[0] for x in refs]
        record['locations']=[{'lat_nanodegrees':x[1],'lon_nanodegrees':x[2]} for x in refs] if row['locations_present'] else None
        if not row['locations_present']:require(all(x[1] is None and x[2] is None for x in refs),'Absent SQL locations have values.')
        require(row['encoded_lat'] is None and not members,'SQL children disagree with way type.')
    else:
        record['members']=[{'type':KINDS[kind],'id':identity,'role':bytes.fromhex(role).decode('utf8')} for kind,identity,role in members]
        require(row['encoded_lat'] is None and row['locations_present'] is None and not refs,'SQL children disagree with relation type.')
    return record


def comparison(record):
    # Independently enumerate semantic fields. Do not call the importer's
    # comparator: an omission there must not disappear from this check too.
    m=record['metadata']
    info={'present':m['present'],'missing':sorted(m['missing'])}
    for field in ['version','timestamp_ms','changeset','uid','user']:
        if field in m:info[field]=m[field]
    value={'type':record['type'],'id':record['id'],'metadata':info,'tags':record['tags']}
    if record['type']=='node':
        value['lat_nanodegrees']=record['lat_nanodegrees'];value['lon_nanodegrees']=record['lon_nanodegrees']
    elif record['type']=='way':value['refs']=record['refs'];value['locations']=record['locations']
    else:value['members']=record['members']
    return canonical(value)


def reconcile(credentials,graph,checkpoint=lambda:None,*,identity=None):
    spool=CheckedSpool(graph,checkpoint)
    digest=hashlib.sha256();budget=DecodeBudget(1024**3);source_objects=0;source_counts={k:0 for k in KINDS}
    budget.consume(len(spool.read(graph['handoff']['manifest_path'],4*1024**2)))
    with psycopg.connect(**credentials,autocommit=True,row_factory=dict_row) as conn:
        conn.execute("SET statement_timeout='30s'");conn.execute("SET lock_timeout='3s'")
        require(conn.execute("SHOW server_version").fetchone()['server_version'].startswith('17.12'),'Unexpected candidate PostgreSQL version.')
        extension=conn.execute("SELECT extversion,postgis_full_version() AS native FROM pg_extension WHERE extname='postgis'").fetchone()
        require(extension and extension['extversion']=='3.7.0','Unexpected candidate PostGIS version.')
        catalog=schema_snapshot(conn)
        expected_sql=hashlib.sha256((Path(__file__).parent/'schema.sql').read_bytes()).hexdigest()
        require(identity and identity.get('schema_sha256')==expected_sql and identity.get('schema_catalog_sha256')==schema_fingerprint(catalog),'Frozen schema identity differs from provisioning.')
        require({r['nspname']+'.'+r['relname'] for r in catalog['relations'] if r['relkind'] not in ['i']}==TABLES,'Unexpected or missing Atlas schema object.')
        fk=conn.execute("SELECT contype,conkey,confkey,confrelid='raw.osm_object'::regclass AS target,convalidated,condeferrable FROM pg_constraint WHERE conname='occurrence_canonical_fk' AND conrelid='raw.object_record'::regclass").fetchone()
        require(fk and fk['contype']=='f' and fk['conkey']==[3,4] and fk['confkey']==[1,2] and fk['target'] and fk['convalidated'] and not fk['condeferrable'],'Required occurrence-to-canonical foreign key is missing or changed.')
        require(conn.execute('SELECT state FROM atlas_meta.identity WHERE singleton').fetchone()['state']=='FROZEN','Independent reader requires a frozen database.')
        require(conn.execute('SELECT count(*) AS n FROM raw.source').fetchone()['n']==len(graph['regions']),'SQL source coverage cardinality differs.')
        registered={uuid5(UUID(graph['handoff']['verification_id']),r['region_id']):r for r in graph['regions']}
        expected_blocks={sid for sid,r in registered.items() if r['role']=='pbf'}
        expected_poly={sid for sid,r in registered.items() if any(d['path']=='poly-source.json' for d in r['outputs'])}
        actual_blocks={r['source_id'] for r in conn.execute('SELECT DISTINCT source_id FROM raw.block')}
        require(actual_blocks==expected_blocks,'SQL block source set differs from registered streams.')
        for table in ['raw.poly_source','spatial.boundary']:
            actual={r['source_id'] for r in conn.execute('SELECT source_id FROM '+table)}
            require(actual==expected_poly,'SQL POLY/boundary source set differs from registered sidecars.')
        for region in graph['regions']:
            sid=uuid5(UUID(graph['handoff']['verification_id']),region['region_id']);checkpoint()
            row=conn.execute('SELECT * FROM raw.source WHERE source_id=%s',[sid]).fetchone()
            require(row is not None,'Required SQL source identity is absent.')
            manifest=spool.read(region['manifest_path'],4*1024**2);budget.consume(len(manifest))
            require((str(row['run_id']),str(row['verification_id']),row['region_id'],row['coverage_role'],blob(row['batch_sha256']).hex(),
                     blob(row['region_manifest']),blob(row['region_manifest_sha256']).hex(),blob(row['provenance']))==
                    (graph['handoff']['run_id'],graph['handoff']['verification_id'],region['region_id'],region['role'],graph['handoff']['manifest_sha256'],
                     manifest,region['manifest_sha256'],canonical(region['manifest'])),'SQL source provenance differs from registered graph.')
            digest.update(canonical({k:str(v) if isinstance(v,UUID) else blob(v).hex() if isinstance(v,(bytes,memoryview)) else v for k,v in row.items()}))
            descriptors={x['path']:x for x in region['outputs']}
            if region['role']=='pbf':
                desc=descriptors['blocks.jsonl.zst'];expected=iter_ir(graph['spool'][desc['registered_path']],desc,budget,checkpoint)
                with conn.transaction(),conn.cursor(name='atlas_check_blocks') as cursor:
                    cursor.itersize=1;cursor.execute('SELECT * FROM raw.block WHERE source_id=%s ORDER BY block_no',[sid])
                    for row,pair in zip_longest(cursor,expected):
                        require(row is not None and pair is not None,'SQL block count differs.')
                        block,line=pair
                        value={'schema_version':1,'block':row['block_no'],'encoding':row['encoding'],'raw_size':row['raw_size'],
                               'granularity':str(row['granularity']),'date_granularity':str(row['date_granularity']),
                               'lat_offset':str(row['lat_offset']),'lon_offset':str(row['lon_offset']),'missing':row['missing_fields']}
                        if row['index_data'] is not None:value['indexdata_hex']=blob(row['index_data']).hex()
                        require(value==block and blob(row['record_line'])==line and blob(row['record_sha256'])==hashlib.sha256(line).digest(),'Independent SQL block precision/presence/encoding differs.')
                        digest.update(canonical_line(value));digest.update(line)
                desc=descriptors['objects.jsonl.zst'];expected=iter_ir(graph['spool'][desc['registered_path']],desc,budget,checkpoint)
                with conn.transaction(),conn.cursor(name='atlas_check_objects') as cursor:
                    cursor.itersize=1;cursor.execute(PROJECTION,[sid])
                    for row,pair in zip_longest(cursor,expected):
                        checkpoint();require(row is not None and pair is not None,'SQL occurrence count differs.')
                        record,line=pair;projected=reconstruct(row);rendered=canonical_line(projected)
                        require(projected==record and rendered==line,'Independent SQL object reconstruction differs from exact registered IR.')
                        require(blob(row['record_line'])==line and blob(row['record_sha256'])==hashlib.sha256(line).digest(),'Original SQL record bytes or digest differ.')
                        require(blob(row['semantic_sha256'])==hashlib.sha256(comparison(projected)).digest(),'Independent semantic hash differs.')
                        source_counts[projected['type']]+=1;source_objects+=1;digest.update(rendered);digest.update(line)
            else:
                require(conn.execute('SELECT count(*) AS n FROM raw.object_record WHERE source_id=%s',[sid]).fetchone()['n']==0,'Boundary-only source acquired OSM objects.')
            if 'poly-source.json' in descriptors:
                desc=descriptors['poly-source.json'];data=spool.read(desc['registered_path'],16*1024**2);budget.consume(len(data))
                poly=json.loads(data);source=next(x for x in region['manifest']['inputs'] if x['kind']=='poly')
                row=conn.execute('SELECT * FROM raw.poly_source WHERE source_id=%s',[sid]).fetchone()
                require(row is not None and (blob(row['sidecar_bytes']),blob(row['sidecar_sha256']).hex(),blob(row['input_descriptor']),blob(row['verified_wkb']).hex())==
                        (data,desc['sha256'],canonical(source),poly['derived_coverage_wkb_hex']),'SQL boundary tokens/WKB/input provenance differ.')
                digest.update(data);digest.update(blob(row['verified_wkb']))
            for desc in region['outputs']:
                if desc.get('encoding')!='jsonl+zstd' and desc['path']!='poly-source.json':
                    data=spool.read(desc['registered_path'],16*1024**2);budget.consume(len(data))
                    require(len(data)==desc['size'] and hashlib.sha256(data).hexdigest()==desc['sha256'],'Spool diagnostic changed.')
        # Independently reconstruct all overlap values from SQL, including the
        # selected representative. A payload-only comparison would miss damage.
        counts={k:0 for k in KINDS};duplicates=0;last=None;semantic=None;representative=None
        with conn.transaction(),conn.cursor(name='atlas_check_overlap') as cursor:
            cursor.itersize=1
            cursor.execute('SELECT kind,osm_id,source_id,ordinal FROM raw.object_record ORDER BY kind,osm_id,source_id')
            for item in cursor:
                checkpoint();key=(item['kind'],item['osm_id'])
                # Indexed projection is bounded to this occurrence; no body is
                # shared with the importer's semantic reconciliation.
                query=PROJECTION.replace('WHERE r.source_id=%s ORDER BY r.ordinal','WHERE r.source_id=%s AND r.ordinal=%s')
                projected=reconstruct(conn.execute(query,[item['source_id'],item['ordinal']]).fetchone());actual=comparison(projected)
                obj=conn.execute('SELECT representative_source,semantic_sha256 FROM raw.osm_object WHERE kind=%s AND osm_id=%s',key).fetchone()
                require(obj is not None and blob(obj['semantic_sha256'])==hashlib.sha256(actual).digest(),'Canonical object identity/hash is absent or differs.')
                if key==last:
                    require(actual==semantic and obj['representative_source']==representative,'Conflicting SQL overlap or representative.')
                    duplicates+=1
                else:
                    counts[KINDS[item['kind']]]+=1;semantic=actual;last=key;representative=obj['representative_source']
                    require(representative==item['source_id'],'Canonical representative is not the deterministic first source.')
                digest.update(canonical([item['kind'],str(item['osm_id']),str(item['source_id']),actual.hex(),str(representative)]))
        require(conn.execute('SELECT count(*) AS n FROM raw.osm_object').fetchone()['n']==sum(counts.values()),'Canonical counts differ.')
        require(conn.execute('''SELECT count(*) AS n FROM raw.way_ref w LEFT JOIN raw.object_record n ON n.source_id=w.source_id
          AND n.kind=0 AND n.osm_id=w.node_id WHERE n.osm_id IS NULL''').fetchone()['n']==0,'Missing per-source way node.')
        missing_members=conn.execute('''SELECT count(*) AS n FROM raw.member m LEFT JOIN raw.object_record o ON
             o.source_id=m.source_id AND o.kind=m.target_kind AND o.osm_id=m.target_id WHERE o.osm_id IS NULL''').fetchone()['n']
        spatial=spatial_checks(conn,counts,checkpoint);privileges=reader_checks(conn)
        digest.update(canonical(spatial['identity']));digest.update(canonical(counts));digest.update(canonical(catalog))
        return {'scope':'fixture','counts':counts,'source_counts':source_counts,'source_objects':source_objects,'duplicates':duplicates,
                'missing_relation_members':missing_members,'spatial':spatial,'privileges':privileges,
                'logical_fingerprint':digest.hexdigest(),'native':extension['native'],'projection_version':1,'schema_catalog_sha256':schema_fingerprint(catalog)}


def spatial_checks(conn,counts,checkpoint):
    points=conn.execute('SELECT count(*) AS n FROM spatial.node_point').fetchone()['n']
    require(points==counts['node'],'Required node geometry presence differs.')
    invalid=conn.execute('''SELECT count(*) AS n FROM spatial.node_point p JOIN raw.osm_object o USING(kind,osm_id)
      JOIN raw.object_record r ON r.source_id=o.representative_source AND r.kind=o.kind AND r.osm_id=o.osm_id
      JOIN raw.node_value n USING(source_id,ordinal) WHERE ST_IsEmpty(p.geom) OR NOT ST_IsValid(p.geom) OR ST_SRID(p.geom)<>4326
      OR ST_NDims(p.geom)<>2 OR GeometryType(p.geom)<>'POINT' OR ST_X(p.geom)<>n.lon_nd::double precision/1000000000
      OR ST_Y(p.geom)<>n.lat_nd::double precision/1000000000''').fetchone()['n']
    require(invalid==0,'Node geometry type/SRID/dimension/coordinate validation failed.')
    boundaries=conn.execute('SELECT count(*) AS n FROM spatial.boundary').fetchone()['n']
    required=conn.execute('SELECT count(*) AS n FROM raw.poly_source').fetchone()['n']
    require(boundaries==required,'Required boundary geometry presence differs.')
    invalid=conn.execute('''SELECT count(*) AS n FROM raw.poly_source s FULL JOIN spatial.boundary b USING(source_id)
      WHERE s.source_id IS NULL OR b.source_id IS NULL OR ST_IsEmpty(b.geom) OR NOT ST_IsValid(b.geom)
      OR ST_SRID(b.geom)<>4326 OR ST_NDims(b.geom)<>2 OR GeometryType(b.geom)<>'MULTIPOLYGON'
      OR ST_AsBinary(b.geom,'NDR')<>ST_AsBinary(ST_Multi(ST_SetSRID(ST_GeomFromWKB(s.verified_wkb),4326)),'NDR')''').fetchone()['n']
    require(invalid==0,'Boundary presence/type/SRID/validity/exact WKB validation failed.')
    indexes=conn.execute("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='spatial' ORDER BY indexname").fetchall()
    for name in ['node_point_gix','boundary_gix']:
        require(any(x['indexname']==name and 'USING gist' in x['indexdef'] for x in indexes),'Required spatial GiST index is absent.')
    conn.execute('SET enable_seqscan=off');plans={};probes={}
    try:
        for table,index in [('node_point','node_point_gix'),('boundary','boundary_gix')]:
            checkpoint();query=f'SELECT count(*) FROM spatial.{table} WHERE geom && ST_MakeEnvelope(-180,-90,180,90,4326)'
            plan=conn.execute('EXPLAIN (FORMAT JSON) '+query).fetchone()['QUERY PLAN']
            require(index in json.dumps(plan),'Spatial probe does not use required GiST index.')
            plans[table]=plan;probes[table]=conn.execute(query).fetchone()['count']
    finally:conn.execute('RESET enable_seqscan')
    extent=conn.execute('SELECT ST_Extent(geom)::text AS extent FROM spatial.node_point').fetchone()['extent']
    return {'points':points,'boundaries':boundaries,'extent':extent,'way_relation_geometry':'not_derived','plans':plans,'probes':probes,
            'identity':{'points':points,'boundaries':boundaries,'extent':extent,'indexes':indexes,'probes':probes}}


def reader_checks(conn):
    conn.execute('SET default_transaction_read_only=off')
    denied=[]
    for statement in ['CREATE TABLE raw.atlas_write_probe(x integer)','CREATE TEMP TABLE atlas_write_probe(x integer)',
                      'UPDATE raw.source SET region_id=region_id WHERE false','INSERT INTO raw.source SELECT * FROM raw.source WHERE false',
                      'SELECT lo_create(0)',"SELECT lo_from_bytea(0,'probe'::bytea)"]:
        try:
            with conn.transaction():
                conn.execute(statement)
                raise ValidationError('Reader acquired an effective write path.')
        except psycopg.errors.InsufficientPrivilege:denied.append(statement.split()[0:3])
    role=conn.execute('''SELECT r.oid,r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
       (SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid) AS memberships
       FROM pg_roles r WHERE r.rolname=current_user''').fetchone()
    require(not any(role[k] for k in ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls','memberships']),'Reader has administrative privileges.')
    require(conn.execute("SELECT count(*) AS n FROM pg_class WHERE relnamespace IN ('raw'::regnamespace,'spatial'::regnamespace,'atlas_meta'::regnamespace) AND relowner=%s",[role['oid']]).fetchone()['n']==0,'Reader owns candidate objects.')
    require(conn.execute('''SELECT count(*) AS n FROM pg_proc WHERE prosecdef
            AND has_function_privilege(current_user,oid,'EXECUTE')''').fetchone()['n']==0,'Reader can execute a SECURITY DEFINER routine.')
    require(conn.execute('''SELECT count(*) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')''').fetchone()['n']==0,'Reader has an effective write grant on a user relation.')
    require(conn.execute("SELECT count(*) AS n FROM pg_namespace WHERE has_schema_privilege(current_user,oid,'CREATE')").fetchone()['n']==0,'Reader can create objects in a schema.')
    require(not conn.execute("SELECT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS allowed").fetchone()['allowed'],'Reader can create database objects or temporary relations.')
    return {'role':role['rolname'],'write_probes_denied':len(denied),'read_only_setting_required':False,'memberships':0,'ownership':0}
