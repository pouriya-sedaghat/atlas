"""Shared validation for external read-only capacity/window observations."""
import re
from datetime import datetime,timezone
from pathlib import Path
try:
    from django.core.exceptions import ValidationError
except ModuleNotFoundError:
    # The external host monitor intentionally needs only the standard library.
    ValidationError=ValueError


def guard_root(root,inventory):
    root=Path(root)
    if not root.is_absolute() or '..' in root.parts or root.resolve()!=root:
        raise ValidationError('Fixture root must be an absolute path without symlinks.')
    for parent in [root,*root.parents]:
        if parent.is_symlink():raise ValidationError('Fixture root may not cross a symlink.')
    for item in inventory:
        for mount in item['mounts']:
            source=Path(mount['Source'])
            for old in [source,source.resolve()]:
                if old==root or old in root.parents or root in old.parents:
                    raise ValidationError('Fixture root overlaps a retained deployment mount.')
    return root


def validate_attestation(value,*,now=None):
    now=now or datetime.now(timezone.utc)
    try:
        if not isinstance(value,dict) or type(value['quiescent']) is not bool:raise ValueError()
        observed=datetime.fromisoformat(value['observed_at'])
        if observed.tzinfo is None or not -2<=(now-observed).total_seconds()<=10:raise ValueError()
        if not re.fullmatch('[0-9a-f]{64}',value['inventory_digest']):raise ValueError()
        for field in ['headroom_bytes','candidate_bytes','new_service_uncommitted']:
            if type(value[field]) is not int or not 0<=value[field]<=1024**5:raise ValueError()
    except (KeyError,TypeError,ValueError,AttributeError):raise ValidationError('Incomplete, stale or invalid external capacity attestation.') from None
    return value


CEILINGS={'db':(.25,384*1024**2),'web':(.25,256*1024**2),'worker':(.25,256*1024**2),
          'verifier':(.5,512*1024**2),'candidate-db':(1,1536*1024**2),
          'provisioner':(.25,256*1024**2),'builder':(.5,1024*1024**2)}


def own_capacity(rows,revision,pins):
    seen=set();uncommitted=0
    for row in rows:
        try:
            service=row['Config']['Labels']['com.docker.compose.service'];host=row['HostConfig']
            if service not in CEILINGS or service in seen or row['Name']!='/atlas-phase1c-fixture-'+service+'-1':raise ValueError()
            seen.add(service);cpu,memory=CEILINGS[service]
            if (not row['State']['Running'] or row['State'].get('Health',{}).get('Status')!='healthy'
                    or row['Image']!=pins[service] or host.get('Privileged')
                    or not 0<host['NanoCpus']<=int(cpu*10**9) or not 0<host['Memory']<=memory
                    or host['MemorySwap']!=host['Memory']):raise ValueError()
            if service not in ['db','candidate-db'] and row['Config']['Labels'].get('org.opencontainers.image.revision')!=revision:raise ValueError()
            if any('docker.sock' in mount.get(key,'') for mount in row.get('Mounts',[]) for key in ['Source','Destination']):raise ValueError()
            # Reserve the full remaining ceiling, conservatively including
            # memory already in use; do not pretend sampled RSS is a hard cap.
            uncommitted+=host['Memory']
        except (KeyError,TypeError,ValueError):raise ValidationError('New-service inventory, image or effective capacity configuration changed.') from None
    if seen!=set(CEILINGS):raise ValidationError('All seven isolated services are required for the pilot.')
    return uncommitted

IO_RATES={'db':(1048576,524288),'web':(1048576,524288),'worker':(1048576,524288),
          'verifier':(4194304,2097152),'candidate-db':(8388608,4194304),
          'provisioner':(1048576,524288),'builder':(4194304,2097152)}


def validate_cgroup_limits(samples,physical_device):
    if not re.fullmatch('[0-9]+:[0-9]+',physical_device):raise ValidationError('Physical block device identity is required.')
    if set(samples)!={'atlas-phase1c-fixture-'+name+'-1' for name in CEILINGS}:
        raise ValidationError('Cgroup inventory differs from the seven isolated services.')
    for service,(cpu,memory) in CEILINGS.items():
        try:
            item=samples['atlas-phase1c-fixture-'+service+'-1'];quota,period=map(int,item['cpu.max'].split())
            if quota<=0 or period<=0 or quota/period>cpu or not 0<int(item['memory.max'])<=memory or item['memory.swap.max']!='0':raise ValueError()
            lines=[line.split() for line in item['io.max'].splitlines() if line.split()[0]==physical_device]
            if len(lines)!=1:raise ValueError()
            fields=dict(word.split('=',1) for word in lines[0][1:]);read,write=map(int,[fields['rbps'],fields['wbps']])
            max_read,max_write=IO_RATES[service]
            if not 0<read<=max_read or not 0<write<=max_write:raise ValueError()
        except (ValueError,TypeError,KeyError,IndexError):raise ValidationError('Effective physical I/O, CPU, RAM or swap enforcement is unavailable.') from None
    return True
