"""Bounded complete handoff graph and stable-copy input boundary."""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
from django.conf import settings
from django.core.exceptions import ValidationError
from atlas_verification.control import get_handoff,read_manifest,assert_current,canonical
from atlas_verification.models import VerificationAttempt
from atlas_verification.storage import safe_open,read_checked,relative_parts
from atlas_verification.manifest import validate_manifest
from atlas_intake.storage import sync_directory
from .control import coverage

GIB=1024**3
MAX_OBJECT_BYTES=512*1024**2
MAX_OBJECTS=2_000_000
MAX_DECODED=GIB
MAX_SPOOL=GIB


def checked_int(value):
    if not isinstance(value,int) or isinstance(value,bool) or value<0:
        raise ValidationError('Invalid bounded nonnegative descriptor integer.')
    return value


def bounded_hash(root,relative,size,expected,checkpoint=lambda:None,destination=None):
    relative_parts(relative);size=checked_int(size)
    if size>MAX_SPOOL:raise ValidationError('Input exceeds fixture byte budget.')
    digest=hashlib.sha256();received=0
    with safe_open(root,relative) as source:
        if os.fstat(source.fileno()).st_size!=size:raise ValidationError('Registered input size changed.')
        output=destination.open('xb') if destination else None
        try:
            while received<size:
                checkpoint()
                data=source.read(min(1024**2,size-received))
                if not data:raise ValidationError('Registered input ended early.')
                digest.update(data);received+=len(data)
                if output:output.write(data)
            if source.read(1) or digest.hexdigest()!=expected:
                raise ValidationError('Registered input digest changed.')
            if output:output.flush();os.fsync(output.fileno())
        finally:
            if output:output.close()
    checkpoint()
    return digest.hexdigest()


def validate_inputs(attempt_id,checkpoint=lambda:None):
    a=VerificationAttempt.objects.get(pk=attempt_id)
    if not a.successful or not a.build_eligible or not a.snapshot.get('fixture'):
        raise ValidationError('Only an opted-in complete eligible fixture handoff can build.')
    root=Path(settings.ATLAS_VERIFICATION_ROOT)
    registry=a.intended.get('files',[])
    if not isinstance(registry,list) or not registry or len(registry)>100000:
        raise ValidationError('Invalid complete output registry.')
    paths=[x['path'] for x in registry]
    if len(set(paths))!=len(paths):raise ValidationError('Duplicate output identity.')
    encoded=sum(checked_int(x['size']) for x in registry)
    source_bytes=sum(checked_int(x['length']) for x in a.snapshot['artifacts'] if not x.get('exception'))
    if encoded>MAX_SPOOL or source_bytes>MAX_SPOOL:
        raise ValidationError('Declared input/spool budget exceeded before reads.')
    # Bound actual reads before the normal handoff API, then use that API with its
    # now-size-bounded registered-output checks. No unchecked mutable re-open.
    for entry in registry:
        bounded_hash(root,entry['path'],entry['size'],entry['sha256'],checkpoint)
    handoff=get_handoff(a.pk,verify_outputs=True)
    if not handoff['build_eligible']:raise ValidationError('Current handoff is not eligible.')
    batch=read_manifest(a);fixture=a.snapshot['fixture']
    if (batch.get('fixture')!=fixture or fixture.get('scope')!='fixture'
            or batch.get('verification_id')!=str(a.pk) or batch.get('run_id')!=str(a.run_id)
            or batch.get('catalog_digest')!=a.snapshot['catalog_digest']
            or batch.get('frozen_inputs')!=a.snapshot or batch.get('tools')!=a.tools
            or batch.get('status') not in ['verified','verified_with_warnings']
            or batch.get('blocking') or batch.get('checks_incomplete')
            or set(batch.get('checks_completed',[]))!={x['artifact_id'] for x in a.snapshot['artifacts']}):
        raise ValidationError('Batch identity, fixture provenance or complete checks disagree.')
    expected=coverage({'pbfs':a.snapshot['selected_pbfs'],
       'boundary_only':sorted(set(a.snapshot['regions'])-set(a.snapshot['selected_pbfs'])),
       'exceptions':[{'region_id':x['region_id'],'exception':x['exception']}
                     for x in a.snapshot['artifacts'] if x.get('exception')]})
    if (batch.get('selected_pbfs')!=expected['pbfs'] or
            batch.get('boundary_only_regions')!=expected['boundary_only']):
        raise ValidationError('Batch coverage roles disagree with frozen source intent.')
    descriptors=batch['regions']
    if (len(descriptors)!=len(a.snapshot['regions']) or
            {x['region_id'] for x in descriptors}!=set(a.snapshot['regions'])):
        raise ValidationError('Regional manifest set is incomplete or duplicated.')
    registered={x['path']:x for x in registry};graph={a.manifest_path}
    regions=[];object_bytes=objects=0;decoded=0
    total_counts={k:0 for k in ["nodes","ways","relations"]}
    base=PurePosixPath(a.manifest_path).parent
    for entry in descriptors:
        rel=(base/entry['path']).as_posix();relative_parts(rel)
        data=read_checked(root,rel,entry['sha256'],4*1024**2)
        if len(data)!=checked_int(entry['size']):raise ValidationError('Region manifest size disagrees.')
        if rel not in registered or any(registered[rel][k]!=entry[k] for k in ['size','sha256']):
            raise ValidationError('Regional manifest differs from output registry.')
        graph.add(rel);r=json.loads(data);validate_manifest('region',r)
        source=[x for x in a.snapshot['artifacts'] if x['region_id']==entry['region_id']]
        if (r['region_id']!=entry['region_id'] or r.get('fixture')!=fixture or r['inputs']!=source
                or r['input_fingerprint']!=hashlib.sha256(canonical(source)).hexdigest()
                or r['schema_version']!=1 or r['policy_version']!='atlas-input-v1'):
            raise ValidationError('Regional source identity or policy differs.')
        role='pbf' if r['region_id'] in expected['pbfs'] else 'boundary_only'
        kinds={'poly','pbf'} if role=='pbf' else {'poly'}
        if set(r['checks'])!=kinds:raise ValidationError('Missing or extra regional check.')
        for kind,check in r['checks'].items():
            if check.get('status') not in ['verified','verified_with_warnings','excepted']:
                raise ValidationError('A regional source check is not usable.')
        if role=='pbf':
            check=r['checks']['pbf'];counts=check['counts']
            count=sum(checked_int(counts[k]) for k in ['nodes','ways','relations'])
            if not count or check.get('empty') or check['references']['way_node']['missing_occurrences']:
                raise ValidationError('Selected PBF is empty or has missing way nodes.')
            objects+=count
            for kind in total_counts:total_counts[kind]+=checked_int(counts[kind])
            if check.get("reread",{}).get("counts")!=counts or check.get("osmium",{}).get("counts")!=counts:
                raise ValidationError("Regional native/reread counts disagree.")
            if check.get("reread",{}).get("tags")!=check.get("tags"):
                raise ValidationError("Regional tag counts disagree.")
        outputs=[]
        for output in r['outputs']:
            path=(PurePosixPath(rel).parent/output['path']).as_posix();relative_parts(path)
            if path in graph:raise ValidationError('Duplicate graph output.')
            graph.add(path)
            if path not in registered or any(registered[path][k]!=output[k] for k in ['size','sha256']):
                raise ValidationError('Regional output graph disagrees with registry.')
            desc={**output,'registered_path':path};outputs.append(desc)
            if output.get('encoding')=='jsonl+zstd':
                if (output.get('schema_version')!=1 or output.get('compression')!=
                        {'algorithm':'zstd','level':3,'threads':0,'checksum':True}):
                    raise ValidationError('IR schema or compression is unsupported.')
                decoded+=checked_int(output['uncompressed_size'])
                if output['path']=='objects.jsonl.zst':
                    object_bytes+=output['uncompressed_size']
                    if output['count']!=count:raise ValidationError('Object descriptor/count mismatch.')
                    for key in ['sha256','size','uncompressed_sha256','uncompressed_size']:
                        if check['reread'].get(key)!=output.get(key):
                            raise ValidationError('Object reread/descriptor identity mismatch.')
                elif output['path']=='blocks.jsonl.zst' and output['count']!=check.get('data_blocks'):
                    raise ValidationError('Block count disagrees with producer.')
            else:decoded+=checked_int(output['size'])
        if role=='pbf' and {o['path'] for o in outputs if o.get('encoding')=='jsonl+zstd'}!={'objects.jsonl.zst','blocks.jsonl.zst'}:
            raise ValidationError('Complete object/block IR is required.')
        regions.append({'region_id':r['region_id'],'role':role,'manifest':r,
                        'manifest_path':rel,'manifest_sha256':entry['sha256'],'outputs':outputs})
        decoded+=len(data)
    decoded+=registered[a.manifest_path]['size']
    if total_counts!=batch.get('counts'):
        raise ValidationError('Batch and per-source object counts disagree.')
    if (graph!=set(registered) or objects>MAX_OBJECTS or object_bytes>MAX_OBJECT_BYTES
            or decoded>MAX_DECODED):
        raise ValidationError('Incomplete output graph or declared decoded fixture budget exceeded.')
    for source in a.snapshot['artifacts']:
        if not source.get('exception'):
            bounded_hash(Path(settings.ATLAS_INBOX),source['path'],source['length'],source['sha256'],checkpoint)
    assert_current(a);checkpoint()
    return {'handoff':handoff,'fixture':fixture,'coverage':expected,'snapshot':a.snapshot,
            'batch':batch,'regions':regions,'registry':registry,'encoded_bytes':encoded,
            'decoded_bytes':decoded,'objects':objects,'object_bytes':object_bytes}


def spool_inputs(attempt_id,directory,checkpoint=lambda:None):
    graph=validate_inputs(attempt_id,checkpoint)
    root=Path(settings.ATLAS_VERIFICATION_ROOT);directory=Path(directory)
    directory.mkdir(mode=0o700,parents=True,exist_ok=False)
    paths={}
    for entry in graph['registry']:
        token=hashlib.sha256(entry['path'].encode()).hexdigest()
        destination=directory/token
        bounded_hash(root,entry['path'],entry['size'],entry['sha256'],checkpoint,destination)
        paths[entry['path']]=str(destination)
    sync_directory(directory)
    assert_current(VerificationAttempt.objects.get(pk=attempt_id));checkpoint()
    graph['spool']=paths
    return graph


class CheckedSpool:
    """Reconcile every copied descriptor before any import read or SQL check."""
    def __init__(self,graph,checkpoint=lambda:None):
        rows=graph['registry'];mapping=graph['spool']
        if not rows or len(rows)>100000 or len({x['path'] for x in rows})!=len(rows) or set(mapping)!={x['path'] for x in rows}:
            raise ValidationError('Private spool registry is incomplete or duplicated.')
        if sum(checked_int(x['size']) for x in rows)>MAX_SPOOL:raise ValidationError('Private spool exceeds its declared budget.')
        self.registry={x['path']:x for x in rows}
        first=Path(next(iter(mapping.values())))
        self.root=first.parent
        if not first.is_absolute() or self.root.resolve()!=self.root:raise ValidationError('Private spool root is unsafe.')
        self.tokens={}
        for entry in rows:
            relative_parts(entry['path']);path=Path(mapping[entry['path']]);token=hashlib.sha256(entry['path'].encode()).hexdigest()
            if path.parent!=self.root or path.name!=token:raise ValidationError('Private spool file identity is unsafe.')
            bounded_hash(self.root,token,entry['size'],entry['sha256'],checkpoint)
            self.tokens[entry['path']]=token

    def read(self,registered_path,cap):
        entry=self.registry[registered_path]
        if entry['size']>cap:raise ValidationError('Private sidecar/manifest exceeds its read ceiling.')
        data=read_checked(self.root,self.tokens[registered_path],entry['sha256'],cap)
        if len(data)!=entry['size']:raise ValidationError('Private sidecar/manifest size changed.')
        return data
