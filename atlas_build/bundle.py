"""Synchronized no-overwrite metadata bundles. Control registration is separate."""
import hashlib,json,os
from pathlib import Path
from django.core.exceptions import ValidationError
from atlas_intake.storage import make_directories,sync_directory
from atlas_verification.control import canonical
from atlas_verification.storage import relative_parts,hash_file,safe_open

LIMIT=64*1024**2


def stage_bundle(root,stage,target,build,validation):
    root=Path(root);relative_parts(stage);relative_parts(target)
    if build.get('scope')!='fixture' or validation.get('scope')!='fixture':
        raise ValidationError('Only explicit fixture bundles are supported.')
    base=root/stage;make_directories(root,base)
    metadata={'postgis/build.json':canonical(build),'postgis/validation.json':canonical(validation),
       'README.md':('Atlas fixture candidate\n=======================\n\n'
          'Scope: fixture. READY is an immutable candidate for later review.\n'
          'No release, active pointer, sessions, engine or consumer contract is published.\n\n'
          'Database identity, source coverage, provenance, versions and resource evidence: postgis/build.json\n'
          'Independent SQL, spatial and reader validation: postgis/validation.json\n'
          'Exact bundle file identities: postgis/index.json\n'
          'Raw OSM values use bytea and exact integer/numeric projections in PostgreSQL.\n'
          'Node points and verified multipolygons are derived; way/relation geometry is not derived.\n'
          'Original PBF wire bytes remain the registered intake source, not a reconstruction from IR.\n').encode()}
    index={'schema_version':1,'scope':'fixture','candidate_id':build['candidate_id'],
           'files':[{'path':name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in sorted(metadata.items())]}
    metadata['postgis/index.json']=canonical(index)
    if sum(map(len,metadata.values()))>LIMIT:raise ValidationError('Bundle exceeds its resource limit.')
    files=[]
    for name,data in sorted(metadata.items()):
        path=base/name;make_directories(root,path.parent)
        with path.open('xb') as output:output.write(data);output.flush();os.fsync(output.fileno())
        sync_directory(path.parent)
        files.append({'path':name,'stage':stage+'/'+name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    sync_directory(base)
    return {'schema_version':1,'scope':'fixture','target':target,'files':files,
            'index_sha256':next(x['sha256'] for x in files if x['path']=='postgis/index.json')}


def validate_intent(intent):
    if (intent.get('scope')!='fixture' or intent.get('schema_version')!=1 or len(intent.get('files',[]))!=4
            or {x['path'] for x in intent['files']}!={'README.md','postgis/build.json','postgis/validation.json','postgis/index.json'}
            or sum(x['size'] for x in intent['files'])>LIMIT):raise ValidationError('Invalid complete bundle intent.')
    relative_parts(intent['target'])
    for entry in intent['files']:relative_parts(entry['path']);relative_parts(entry['stage'])


def publish_bundle(root,intent,*,fault=lambda step:None):
    root=Path(root);validate_intent(intent)
    for entry in sorted(intent['files'],key=lambda x:x['path']=='postgis/index.json'):
        target=root/intent['target']/entry['path'];source=root/entry['stage']
        make_directories(root,target.parent)
        parent=target.parent
        while parent!=root:
            os.chown(parent,-1,10001);os.chmod(parent,0o750);parent=parent.parent
        if hash_file(root,entry['stage'],expected_size=entry['size'])!=(entry['size'],entry['sha256']):
            raise ValidationError('Staged bundle bytes changed.')
        if not target.exists():
            os.chown(source,-1,10001);os.chmod(source,0o440)
            try:os.link(source,target,follow_symlinks=False)
            except FileExistsError:pass
            fault('after_link')
        if hash_file(root,str(target.relative_to(root)),expected_size=entry['size'])!=(entry['size'],entry['sha256']):
            raise ValidationError('Published bundle conflicts with its immutable intent.')
        sync_directory(target.parent);fault('after_sync')
    check_bundle(root,intent)


def check_bundle(root,intent):
    root=Path(root);validate_intent(intent)
    for entry in intent['files']:
        if hash_file(root,intent['target']+'/'+entry['path'],expected_size=entry['size'])!=(entry['size'],entry['sha256']):
            raise ValidationError('Registered bundle file changed.')
    with safe_open(root,intent['target']+'/postgis/index.json') as source:index=json.loads(source.read(LIMIT+1))
    expected=[{k:x[k] for k in ['path','size','sha256']} for x in intent['files'] if x['path']!='postgis/index.json']
    if index.get('scope')!='fixture' or index.get('files')!=expected or intent['index_sha256']!=next(x['sha256'] for x in intent['files'] if x['path']=='postgis/index.json'):
        raise ValidationError('Bundle index disagrees with the complete intended files.')
    base=root/intent['target'];found=set()
    for parent,dirs,files in os.walk(base,followlinks=False):
        if any((Path(parent)/name).is_symlink() for name in dirs):raise ValidationError('Bundle contains an unsafe directory.')
        for name in files:
            found.add(str((Path(parent)/name).relative_to(base)))
            if len(found)>4:raise ValidationError('Bundle contains unexpected files.')
    if found!={x['path'] for x in intent['files']}:raise ValidationError('Bundle file set is incomplete.')
    return True
