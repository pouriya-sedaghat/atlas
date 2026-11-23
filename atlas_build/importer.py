"""Bounded client-side COPY into one inaccessible generation-owned database."""
import hashlib,json
from pathlib import Path
from uuid import UUID,uuid5
import psycopg
from psycopg import sql
from django.core.exceptions import ValidationError
from atlas_verification.control import canonical
from .semantic import KINDS,validate_block,validate_record,semantic_bytes,semantic_digest,text
from .stream import DecodeBudget,iter_ir
from .inputs import CheckedSpool

# Fixed COPY order also preserves all parent/child constraints at a chunk boundary.
TABLES={
 'source':['uuid','uuid','uuid','text','text','bytea','bytea','bytea','bytea'],
 'block':['uuid','int8','text','int4','int4','int4','int8','int8','text[]','bytea','bytea','bytea'],
 'object_record':['uuid','int8','int2','int8','int8','bytea','bytea','bytea'],
 'info':['uuid','int8','bool','text[]','int4','int8','numeric','int8','int4','int8','bytea'],
 'node_value':['uuid','int8','int8','int8','int8','int8'],
 'tag':['uuid','int8','int4','bytea','bytea'],
 'way_state':['uuid','int8','bool'],
 'way_ref':['uuid','int8','int4','int8','int8','int8'],
 'member':['uuid','int8','int4','int2','int8','bytea'],
 'poly_source':['uuid','bytea','bytea','bytea','bytea'],
 'osm_object':['int2','int8','bytea','uuid'],
}

class CopyBatch:
    def __init__(self,conn,checkpoint):
        self.conn=conn;self.checkpoint=checkpoint;self.rows={t:[] for t in TABLES};self.bytes=self.count=0
    def add(self,table,row):
        size=sum(len(x) if isinstance(x,(bytes,str,list)) else 32 for x in row)+64
        if self.count and (self.bytes+size>4*1024**2 or self.count>=10000):self.flush()
        self.rows[table].append(row);self.bytes+=size;self.count+=1
        if self.bytes>=4*1024**2:self.flush()
    def flush(self):
        if not self.count:return
        self.checkpoint()
        with self.conn.transaction():
            for table,rows in self.rows.items():
                if not rows:continue
                with self.conn.cursor().copy(sql.SQL('COPY raw.{} FROM STDIN (FORMAT BINARY)').format(sql.Identifier(table))) as copy:
                    copy.set_types(TABLES[table])
                    for row in rows:copy.write_row(row)
                rows.clear()
        self.bytes=self.count=0;self.checkpoint()


def source_id(graph,region):return uuid5(UUID(graph['handoff']['verification_id']),region['region_id'])


def import_graph(credentials,graph,checkpoint=lambda:None,*,digest=semantic_digest):
    spool=CheckedSpool(graph,checkpoint)
    budget=DecodeBudget(1024**3);budget.consume(len(spool.read(graph['handoff']['manifest_path'],4*1024**2)))
    counts={'node':0,'way':0,'relation':0};source_objects=0
    with psycopg.connect(**credentials,autocommit=True) as conn:
        conn.execute("SET statement_timeout='30s'");conn.execute("SET lock_timeout='3s'")
        batch=CopyBatch(conn,checkpoint)
        for region in graph['regions']:
            checkpoint();sid=source_id(graph,region);manifest_path=graph['spool'][region['manifest_path']]
            manifest=spool.read(region['manifest_path'],4*1024**2);budget.consume(len(manifest))
            batch.add('source',[sid,UUID(graph['handoff']['run_id']),UUID(graph['handoff']['verification_id']),
                region['region_id'],region['role'],bytes.fromhex(graph['handoff']['manifest_sha256']),manifest,
                bytes.fromhex(region['manifest_sha256']),canonical(region['manifest'])])
            objects=None
            for descriptor in region['outputs']:
                path=Path(graph['spool'][descriptor['registered_path']])
                if descriptor['path']=='blocks.jsonl.zst':
                    previous=1
                    for block,line in iter_ir(path,descriptor,budget,checkpoint):
                        validate_block(block)
                        if block['block']<=previous:raise ValidationError('Block ordinals are not strictly increasing.')
                        previous=block['block']
                        batch.add('block',[sid,block['block'],block['encoding'],block['raw_size'],int(block['granularity']),
                            int(block['date_granularity']),int(block['lat_offset']),int(block['lon_offset']),block['missing'],
                            bytes.fromhex(block['indexdata_hex']) if 'indexdata_hex' in block else None,line,hashlib.sha256(line).digest()])
                elif descriptor['path']=='objects.jsonl.zst':objects=(path,descriptor)
                else:
                    if path.stat().st_size!=descriptor['size'] or descriptor['size']>16*1024**2:
                        raise ValidationError('Sidecar or diagnostic descriptor exceeds its bound.')
                    data=spool.read(descriptor['registered_path'],16*1024**2);budget.consume(len(data))
                    if hashlib.sha256(data).hexdigest()!=descriptor['sha256']:raise ValidationError('Spool sidecar changed.')
                    if descriptor['path']=='poly-source.json':
                        poly=json.loads(data);wkb=poly.get('derived_coverage_wkb_hex')
                        source=next(x for x in region['manifest']['inputs'] if x['kind']=='poly')
                        if (not wkb or poly.get('source_sha256')!=source['sha256'] or poly.get('source_size')!=source['length']):
                            raise ValidationError('Verified boundary provenance or required geometry is missing.')
                        batch.add('poly_source',[sid,data,hashlib.sha256(data).digest(),canonical(source),bytes.fromhex(wkb)])
            batch.flush()
            if region['role']=='pbf':
                if not objects:raise ValidationError('Selected source has no complete object stream.')
                previous=0;last_block=0;block=None
                for record,line in iter_ir(*objects,budget,checkpoint):
                    if record['ordinal']!=previous+1 or record['block']<last_block:
                        raise ValidationError('Source object ordinals or block references are out of order.')
                    previous+=1
                    if record['block']!=last_block:
                        batch.flush()
                        found=conn.execute('SELECT record_line FROM raw.block WHERE source_id=%s AND block_no=%s',[sid,record['block']]).fetchone()
                        if not found:raise ValidationError('Object references an absent source block.')
                        block=json.loads(bytes(found[0]));last_block=record['block']
                    validate_record(record,block);kind=KINDS[record['type']];ordinal=record['ordinal'];info=record['metadata']
                    counts[record['type']]+=1;source_objects+=1
                    if source_objects>2_000_000:raise ValidationError('Actual object count exceeds fixture limit.')
                    batch.add('object_record',[sid,ordinal,kind,int(record['id']),record['block'],line,hashlib.sha256(line).digest(),digest(record)])
                    batch.add('info',[sid,ordinal,info['present'],info['missing'],
                        *[int(info[k]) if k in info else None for k in ['version','timestamp_ticks','timestamp_ms','changeset','uid','user_sid']],
                        text(info['user']) if 'user' in info else None])
                    if kind==0:
                        batch.add('node_value',[sid,ordinal,*[int(record[k]) for k in ['encoded_lat','encoded_lon','lat_nanodegrees','lon_nanodegrees']]])
                    for position,(key,value) in enumerate(record['tags'],1):batch.add('tag',[sid,ordinal,position,text(key),text(value)])
                    if kind==1:
                        locations=record['locations'];batch.add('way_state',[sid,ordinal,locations is not None])
                        for position,ref in enumerate(record['refs'],1):
                            point=locations[position-1] if locations is not None else None
                            batch.add('way_ref',[sid,ordinal,position,int(ref),int(point['lat_nanodegrees']) if point else None,int(point['lon_nanodegrees']) if point else None])
                    elif kind==2:
                        for position,member in enumerate(record['members'],1):
                            batch.add('member',[sid,ordinal,position,KINDS[member['type']],int(member['id']),text(member['role'])])
                if previous!=objects[1]['count']:raise ValidationError('Source object count differs.')
                batch.flush()
        # Reconcile per-source references before any union/dedup can hide a gap.
        if conn.execute('''SELECT 1 FROM raw.way_ref w LEFT JOIN raw.object_record n ON
             n.source_id=w.source_id AND n.kind=0 AND n.osm_id=w.node_id WHERE n.osm_id IS NULL LIMIT 1''').fetchone():
            raise ValidationError('A way references an absent node in its own source.')
        canonical_count=duplicates=0;previous_key=None;previous_semantic=None;previous_hash=None
        with psycopg.connect(**credentials) as scan:
            with scan.cursor(name='atlas_overlap') as cursor:
                cursor.itersize=1
                cursor.execute('SELECT kind,osm_id,source_id,record_line,semantic_sha256 FROM raw.object_record ORDER BY kind,osm_id,source_id')
                for kind,osm_id,sid,line,stored_hash in cursor:
                    checkpoint();key=(kind,osm_id);record=json.loads(bytes(line));semantic=semantic_bytes(record);stored_hash=bytes(stored_hash)
                    if key==previous_key:
                        if stored_hash!=previous_hash or semantic!=previous_semantic:
                            raise ValidationError(f'Conflicting complete overlap for type {kind}, ID {osm_id}; both source occurrences retained.')
                        duplicates+=1
                    else:
                        batch.add('osm_object',[kind,osm_id,stored_hash,sid]);canonical_count+=1
                        previous_key=key;previous_semantic=semantic;previous_hash=stored_hash
        batch.flush();checkpoint()
        conn.execute('''INSERT INTO spatial.node_point SELECT o.kind,o.osm_id,
          ST_SetSRID(ST_MakePoint(n.lon_nd::double precision/1000000000,n.lat_nd::double precision/1000000000),4326)
          FROM raw.osm_object o JOIN raw.object_record r ON r.source_id=o.representative_source AND r.kind=o.kind AND r.osm_id=o.osm_id
          JOIN raw.node_value n USING(source_id,ordinal) WHERE o.kind=0''')
        conn.execute('''INSERT INTO spatial.boundary SELECT source_id,ST_Multi(ST_SetSRID(ST_GeomFromWKB(verified_wkb),4326)) FROM raw.poly_source''')
        checkpoint()
    vintages=[]
    for region in graph['regions']:
        if region['role']=='pbf':
            header=region['manifest']['checks']['pbf'].get('header',{})
            vintages.append({'region_id':region['region_id'],'header':header})
    values={canonical({k:v for k,v in x['header'].items() if k in ['source','osmosis_replication_timestamp','osmosis_replication_sequence_number','osmosis_replication_base_url','missing']}) for x in vintages}
    warnings=[{'code':'mixed_source_vintages','sources':vintages}] if len(values)>1 else []
    return {'warnings':warnings,'source_vintages':vintages,'source_counts':counts,'source_objects':source_objects,'canonical_objects':canonical_count,'duplicates':duplicates,
            'decoded_bytes':budget.used,'way_relation_geometry':'not_derived'}
