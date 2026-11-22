"""Exact producer domains and overlap semantics; source encoding is retained."""
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path
from jsonschema import Draft202012Validator
from django.core.exceptions import ValidationError
from atlas_verification.control import canonical

KINDS={'node':0,'way':1,'relation':2}
INFO=('version','timestamp','changeset','uid','user_sid','visible')


def require(condition,message):
    if not condition:raise ValidationError(message)


def integer(value,*,bits=64,positive=False,nonnegative=False):
    require(isinstance(value,str) and len(value)<=31 and
            re.fullmatch(r'(?:0|-?[1-9][0-9]*)',value,re.ASCII) is not None,'Noncanonical source integer.')
    number=int(value)
    if bits is not None:require(-(1<<(bits-1))<=number<(1<<(bits-1)),'Source integer exceeds producer range.')
    if positive:require(number>0,'Source identity must be positive.')
    if nonnegative:require(number>=0,'Source metadata cannot be negative.')
    return number


def text(value):
    require(isinstance(value,str),'Source text is not a string.')
    try:return value.encode('utf-8',errors='strict')
    except UnicodeError:raise ValidationError('Source text is not valid UTF-8.') from None


@lru_cache(maxsize=2)
def validator(kind):
    path=Path(__file__).parent.parent/'atlas_verification'/'schemas'/f'{kind}-v1.json'
    return Draft202012Validator(json.loads(path.read_bytes()))


def schema(kind,value):
    # The accepted 1B producer writes protobuf's zlib_data spelling, while
    # its frozen v1 schema describes zlib. Check the same domain here without
    # changing the authoritative input, persisted value, or historical schema.
    checked={**value,'encoding':'zlib'} if kind=='block' and value.get('encoding')=='zlib_data' else value
    if next(validator(kind).iter_errors(checked),None) is not None:
        raise ValidationError('Unsupported or invalid exact IR record schema.')


def validate_block(block):
    schema('block',block)
    require(type(block['block']) is int and 2<=block['block']<2**63,'Invalid block number.')
    require(type(block['raw_size']) is int and 0<=block['raw_size']<32*1024**2,'Invalid block raw size.')
    for field in ['granularity','date_granularity']:integer(block[field],bits=32,positive=True)
    for field in ['lat_offset','lon_offset']:integer(block[field])
    defaults={'granularity':'100','date_granularity':'1000','lat_offset':'0','lon_offset':'0'}
    for field in block['missing']:require(block[field]==defaults[field],'Absent block field has a nondefault value.')
    if 'indexdata_hex' in block:
        require(len(block['indexdata_hex'])<2*65536,'Opaque block index exceeds producer header bound.')


def validate_record(record,block):
    schema('object',record);validate_block(block)
    common={'schema_version','type','id','ordinal','block','tags','metadata'}
    extra={'node':{'encoded_lat','encoded_lon','lat_nanodegrees','lon_nanodegrees'},
           'way':{'refs','locations'},'relation':{'members'}}
    require(set(record)==common|extra[record['type']],'Object fields disagree with producer type.')
    require(type(record['ordinal']) is int and 0<record['ordinal']<2**63,'Invalid source ordinal.')
    require(record['block']==block['block'],'Object block reference disagrees.')
    integer(record['id'],positive=True)
    require(len(record['tags'])<=1_000_000,'Tag cardinality exceeds producer bound.')
    for key,value in record['tags']:text(key);text(value)
    info=record['metadata'];missing=info['missing']
    require('visible' in missing,'History visibility remains unsupported.')
    require(info['present'] or set(missing)==set(INFO),'Absent Info has present fields.')
    allowed={'present','missing'}
    for field in INFO:
        if field in missing:continue
        if field=='timestamp':
            allowed.update(['timestamp_ticks','timestamp_ms'])
            ticks=integer(info.get('timestamp_ticks'));millis=integer(info.get('timestamp_ms'),bits=None)
            require(millis==ticks*integer(block['date_granularity'],bits=32,positive=True),'Timestamp reconstruction differs.')
        elif field=='user_sid':
            allowed.update(['user_sid','user'])
            sid=integer(info.get('user_sid'),nonnegative=True)
            require(sid<2**32,'String-table index exceeds uint32.');text(info.get('user'))
        else:
            allowed.add(field)
            integer(info.get(field),bits=32 if field in ['uid','version'] else 64,
                    positive=field=='version',nonnegative=field in ['uid','changeset'])
    require(set(info)==allowed,'Metadata presence and values disagree.')
    def coordinate(value,latitude):
        n=integer(value);bound=90_000_000_000 if latitude else 180_000_000_000
        require(-bound<=n<=bound,'Coordinate outside producer range.');return n
    if record['type']=='node':
        for axis,latitude in [('lat',True),('lon',False)]:
            raw=integer(record['encoded_'+axis]);actual=coordinate(record[axis+'_nanodegrees'],latitude)
            require(actual==integer(block[axis+'_offset'])+integer(block['granularity'],bits=32,positive=True)*raw,
                    'Exact coordinate reconstruction differs.')
    elif record['type']=='way':
        refs=record['refs'];require(len(refs)<=1_000_000,'Way cardinality exceeds producer bound.')
        for ref in refs:integer(ref,positive=True)
        if record['locations'] is not None:
            require(len(record['locations'])==len(refs),'Way locations do not align with references.')
            for point in record['locations']:
                coordinate(point['lat_nanodegrees'],True);coordinate(point['lon_nanodegrees'],False)
    else:
        require(len(record['members'])<=250000,'Relation cardinality exceeds producer bound.')
        for member in record['members']:integer(member['id'],positive=True);text(member['role'])
    return record


def semantic_bytes(record):
    info={k:v for k,v in record['metadata'].items() if k not in ['timestamp_ticks','user_sid']}
    info['missing']=sorted(info['missing'])
    result={'type':record['type'],'id':record['id'],'tags':record['tags'],'metadata':info}
    for field in ['lat_nanodegrees','lon_nanodegrees','refs','locations','members']:
        if field in record:result[field]=record[field]
    return canonical(result)


def semantic_digest(record):return hashlib.sha256(semantic_bytes(record)).digest()


def identical(left,right,*,hash_fn=hashlib.sha256):
    a=semantic_bytes(left);b=semantic_bytes(right)
    return hash_fn(a).digest()==hash_fn(b).digest() and a==b
