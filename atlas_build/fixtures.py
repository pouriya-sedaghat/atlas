"""Explicit synthetic fixture registration, restricted to the isolated QA DB.

Only intake inputs/seal metadata are constructed here. Verification, admission,
import, validation and READY publication always run through the normal workers.
"""
import hashlib,os,struct,zlib
from pathlib import Path
from uuid import uuid4
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from atlas_intake.models import Artifact,CatalogRevision,Run
from atlas_intake.control import lock_control,set_selection,launch_manual,audit
from atlas_intake.storage import sync_directory
from atlas_verification.control import canonical,request_verification
from atlas_verification.proto import fileformat_pb2 as ff,osmformat_pb2 as osm
from .control import fixture_guard,bind_fixture_run,coverage
from .models import BuildProfile

COVERAGE={'pbfs':['fixture-a','fixture-b'],'boundary_only':['fixture-boundary'],'exceptions':[]}
CATALOG=[{'id':key,'name':key,'parent':None,'path':'fixture/'+key,
          'pbf_url':'https://atlas-fixture.invalid/'+key+'.osm.pbf',
          'poly_url':'https://atlas-fixture.invalid/'+key+'.poly'} for key in ['fixture-a','fixture-b','fixture-boundary']]
POLY=b'Atlas controlled fixture\n1\n0 0\n2 0\n2 2\n0 2\n0 0\nEND\nEND\n'
MAX_ID=9223372036854775807
KINDS={'lossless','relation-only','empty','conflict','missing-way-node','invalid-boundary','load','large-children','boundary-only','boundary-policy','mixed-empty'}



def expected_coverage(kind):
    return {'pbfs':[],'boundary_only':['fixture-a','fixture-b','fixture-boundary'],'exceptions':[]} if kind=='boundary-only' else COVERAGE

POLICY_POLYS={
 'fixture-a':b'Fixture multipart with exclusion\n1\n0 0\n5 0\n5 5\n0 5\n0 0\nEND\n!hole\n1 1\n2 1\n2 2\n1 2\n1 1\nEND\n2\n10 0\n11 0\n11 1\n10 1\n10 0\nEND\nEND\n',
 'fixture-b':b'Fixture split antimeridian\nwest\n-180 -10\n-175 -10\n-175 -7\n-180 -7\n-180 -10\nEND\neast\n175 -10\n180 -10\n180 -7\n175 -7\n175 -10\nEND\nEND\n',
 'fixture-boundary':b'Fixture Antarctica band\n1\n-180 -90\n180 -90\n180 -60\n-180 -60\n-180 -90\nEND\nEND\n'}

def frame(kind,message,compressed,index=None):
    raw=message.SerializeToString()
    blob=ff.Blob(zlib_data=zlib.compress(raw),raw_size=len(raw)) if compressed else ff.Blob(raw=raw)
    data=blob.SerializeToString();header=ff.BlobHeader(type=kind,datasize=len(data))
    if index is not None:header.indexdata=index
    encoded=header.SerializeToString()
    return struct.pack('>I',len(encoded))+encoded+data


def fixture_inputs(kind):
    if kind not in KINDS:raise ValidationError('Unknown bounded fixture kind.')
    if kind=='boundary-only':return {}
    result={}
    for alternate,key in enumerate(COVERAGE['pbfs']):
        b=osm.PrimitiveBlock(granularity=14 if alternate else 7,date_granularity=26 if alternate else 13,
             lat_offset=-44 if alternate else -51,lon_offset=83)
        # String-table slots deliberately differ between semantically equal
        # occurrences. Empty values and explicit metadata presence are retained.
        strings=[b'',b'name',b'v\0\xc3\xa9',b'k\0',b'u\0',b'outer\0',b'']
        if alternate:strings=[b'',b'unused',*strings[1:]]
        b.stringtable.s.extend(strings)
        sid=lambda value:strings.index(value)
        group=b.primitivegroup.add()
        empty_source=kind=='empty' or (kind=='mixed-empty' and alternate)
        if kind!='relation-only' and not empty_source:
            values=[(1,0 if alternate else 1,-1 if alternate else -2),(2,1 if alternate else 3,0),
                    (MAX_ID,61 if alternate else 123,-228 if alternate else -456)]
            for identity,lat,lon in values:
                node=group.nodes.add(id=identity,lat=lat,lon=lon)
                if identity==2:node.info.SetInParent()
                if identity==MAX_ID:
                    node.keys.extend([sid(b'name'),sid(b'name'),sid(b'k\0')]);node.vals.extend([sid(b'v\0\xc3\xa9'),0,sid(b'v\0\xc3\xa9')])
                    node.info.version=1;node.info.timestamp=4611686018427387903 if alternate else MAX_ID-1
                    node.info.uid=0;node.info.changeset=0;node.info.user_sid=sid(b'u\0')
                    if kind=='conflict' and alternate:node.vals[0]=0
            refs=[MAX_ID]+[0]*29999 if kind=='large-children' else [MAX_ID,0,1-MAX_ID]
            if kind=='missing-way-node' and alternate:refs[-1]=999-MAX_ID
            way=b.primitivegroup.add().ways.add(id=MAX_ID,refs=refs)
            # Optional locations use the block's exact integer encoding.
            if kind!='large-children':
                way.lat.extend([61 if alternate else 123,0,-61 if alternate else -122])
                way.lon.extend([-228 if alternate else -456,0,227 if alternate else 454])
            if kind=='load':
                for identity in range(3,2003):group.nodes.add(id=identity,lat=1 if alternate else 3,lon=0)
        if not empty_source:
            relation=b.primitivegroup.add().relations.add(id=MAX_ID)
            if kind=='relation-only':
                relation.memids.extend([42]);relation.types.extend([osm.Relation.RELATION]);relation.roles_sid.extend([sid(b'outer\0')])
            else:
                relation.memids.extend([MAX_ID,0,1-MAX_ID,41]);relation.types.extend([osm.Relation.WAY,osm.Relation.WAY,osm.Relation.NODE,osm.Relation.RELATION])
                relation.roles_sid.extend([sid(b'outer\0'),0,sid(b'v\0\xc3\xa9'),0])
        header=osm.HeaderBlock(required_features=['OsmSchema-V0.6','DenseNodes'],optional_features=['LocationsOnWays'],
               writingprogram='Atlas fixture\0writer',source='Controlled QA\0source',osmosis_replication_timestamp=1700000000+alternate)
        result[key]=frame('OSMHeader',header,bool(alternate))+frame('OSMData',b,bool(alternate),b'' if alternate else b'\0opaque-index')
    return result


def register_fixture(kind,actor,*,profile_id):
    fixture_guard()
    # All synthetic bytes are bounded and computed before the Control lock.
    # The tiny QA-only file publication and registration commit together, so
    # an ordinary intake worker never observes queued fixture artifacts.
    inputs=fixture_inputs(kind);digest=hashlib.sha256(canonical(CATALOG)).hexdigest()
    with transaction.atomic():
        state=lock_control()
        profile=BuildProfile.objects.select_for_update().get(pk=profile_id)
        if not profile.enabled or coverage(profile.coverage)!=coverage(expected_coverage(kind)):
            raise ValidationError('Explicit enabled profile must match the complete fixture coverage.')
        catalog,_=CatalogRevision.objects.get_or_create(digest=digest,defaults={'regions':CATALOG})
        state.catalog=catalog;state.save(update_fields=['catalog'])
        set_selection(expected_coverage(kind)['pbfs'],actor)
        key='fixture-'+str(uuid4());run=launch_manual(key,actor)
        bind_fixture_run(run.pk,profile.pk,actor)
        for artifact in run.artifacts.all():
            data=inputs[artifact.region_id] if artifact.kind==Artifact.Kind.PBF else POLY
            if kind=='boundary-policy' and artifact.kind==Artifact.Kind.POLY:data=POLICY_POLYS[artifact.region_id]
            if kind=='invalid-boundary' and artifact.region_id=='fixture-boundary':data=b'invalid\n1\n0 0\n2 2\n0 2\n2 0\n0 0\nEND\nEND\n'
            target=Path(settings.ATLAS_INBOX)/artifact.relative_path;target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('xb') as output:output.write(data);output.flush();os.fsync(output.fileno())
            sync_directory(target.parent)
            artifact.status=Artifact.Status.COMPLETE;artifact.actual_length=len(data);artifact.sha256=hashlib.sha256(data).hexdigest();artifact.finished_at=timezone.now()
            artifact.save(update_fields=['status','actual_length','sha256','finished_at'])
        run.status=Run.Status.SEALED;run.sealed_at=timezone.now();run.save(update_fields=['status','sealed_at'])
        audit('build.fixture_inputs_registered',actor,run=run,kind=kind,scope='fixture',profile=str(profile.pk))
        return request_verification(run.pk,key,actor)
