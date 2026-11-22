"""Host-only read-only legacy inventory; containers receive no Docker socket.

python -m atlas_build.legacy --output /private/preflight.json [--baseline ...]
The host operator periodically supplies these observations to the QA control
plane. A changed inventory stops new work; it never pauses an older stack.
"""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor

LEGACY=('atlas-phase1a-smoke','atlas-recurrence-smoke','atlas-verification-smoke',
        'atlas-updates-smoke','atlas-poly-smoke')


def evaluate(scopes,inventory):
    base=sum(max(s['run_cap'],s['intake_outstanding'])+
             max(s['verifier_cap'],s['verification_outstanding']) for s in scopes)
    material={'scopes':sorted(scopes,key=lambda s:s['name']),'inventory':inventory}
    return {'quiescent':not any(s['busy'] for s in scopes),
            'headroom_bytes':(base*110+99)//100,
            'inventory_digest':hashlib.sha256(json.dumps(material,sort_keys=True,
                   separators=(',',':'),default=str).encode()).hexdigest(),**material}


QUERY=r'''import json,os
from pathlib import Path,PurePosixPath
from django.db import transaction,connection
from django.conf import settings
from django.utils import timezone
from atlas_intake.models import Control,Run,Artifact,Schedule
try:
 from atlas_verification.models import VerificationAttempt
except ModuleNotFoundError:VerificationAttempt=None
with transaction.atomic():
 with connection.cursor() as cur:cur.execute('SET TRANSACTION READ ONLY');cur.execute("SET LOCAL statement_timeout='3s'")
 c=Control.objects.get(pk=1);runs=list(Run.objects.order_by('pk').values('pk','status','limits')[:1001])
 active=list(Artifact.objects.filter(status__in=['pending','transferring','prepared']).values('pk','status','generation')[:1001])
 reservations=list(Artifact.objects.filter(reserved_bytes__gt=0).values('reserved_bytes','stage_path')[:1001])
 remaining=0
 for row in reservations:
  path=PurePosixPath(row['stage_path'])
  if path.is_absolute() or '..' in path.parts:raise ValueError('Unsafe legacy staging metadata')
  try:allocated=(Path(settings.ATLAS_INBOX)/path).stat().st_blocks*512 if row['stage_path'] else 0
  except FileNotFoundError:allocated=0
  remaining+=max(0,row['reserved_bytes']-allocated)
 verifications=list(VerificationAttempt.objects.order_by('pk').values('pk','status','reserved_bytes')[:1001]) if VerificationAttempt else []
 schedule=list(Schedule.objects.filter(pk=c.schedule_id).values('pk','status','due_at'))
 upcoming=bool(c.mode=='automatic' and c.schedule_id and schedule and
               schedule[0]['status'] in ['pending','dispatched'] and
               schedule[0]['due_at']<=timezone.now()+__import__('datetime').timedelta(seconds=360))
 busy=bool(active or any(r['status'] in ['queued','running'] for r in runs) or
           any(v['status'] in ['queued','running','prepared'] for v in verifications) or
           upcoming or c.catalog_refresh_requested or len(runs)>1000 or len(verifications)>1000)
 result={'run_cap':max([settings.ATLAS_LIMITS['run']]+[r['limits'].get('run',0) for r in runs]),
    'intake_outstanding':remaining,'verification_outstanding':sum(v['reserved_bytes'] for v in verifications),
    'verifier_cap':getattr(settings,'ATLAS_VERIFICATION_ATTEMPT_BYTES',0),'busy':busy,
    'identity':{'mode':c.mode,'selection':c.selection,'catalog':c.catalog_id,'schedule':schedule,
       'runs':runs,'active_artifacts':active,'verifications':verifications,'refresh_requested':c.catalog_refresh_requested}}
print('ATLAS_EVIDENCE='+json.dumps(result,default=str,sort_keys=True))
'''


def command(args,timeout=15):
    return subprocess.check_output(args,text=True,timeout=timeout)


def collect():
    names=command(['docker','ps','--format','{{.Names}}']).splitlines()
    names=sorted(n for n in names if any(n.startswith(p+'-') for p in LEGACY))
    rows=json.loads(command(['docker','inspect',*names]))
    inventory=[]
    for row in sorted(rows,key=lambda r:r['Name']):
        inventory.append({'name':row['Name'].lstrip('/'),'id':row['Id'],'image':row['Image'],
           'started_at':row['State']['StartedAt'],'health':row['State'].get('Health',{}).get('Status'),
           'memory':row['HostConfig']['Memory'],'cpu':row['HostConfig']['NanoCpus'],
           'mounts':[{k:m[k] for k in ['Source','Destination','RW']} for m in row['Mounts']
                     if not m['Destination'].startswith('/run/secrets')]})
    def observe(scope):
        out=command(['docker','exec',scope+'-web-1','python','manage.py','shell','-c',QUERY],timeout=20)
        data=json.loads(next(line.removeprefix('ATLAS_EVIDENCE=') for line in out.splitlines()
                            if line.startswith('ATLAS_EVIDENCE=')))
        data['name']=scope
        if scope+'-verifier-1' not in names:data['verifier_cap']=0
        if any(r['health']!='healthy' for r in inventory if r['name'].startswith(scope+'-')):
            data['busy']=True
        return data
    with ThreadPoolExecutor(max_workers=5) as pool:scopes=list(pool.map(observe,LEGACY))
    result=evaluate(scopes,inventory)
    result['observed_at']=datetime.now(timezone.utc).isoformat()
    return result


def main():
    if Path('/.dockerenv').exists():raise SystemExit('Legacy preflight runs on the authorized host only.')
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--baseline')
    args=p.parse_args();result=collect()
    if args.baseline:
        baseline=json.loads(Path(args.baseline).read_text())
        if result['inventory_digest']!=baseline['inventory_digest']:
            result['quiescent']=False;result['changed_inventory']=True
    target=Path(args.output);target.write_text(json.dumps(result,indent=2));target.chmod(0o600)
    print(json.dumps({k:result[k] for k in ['observed_at','quiescent','headroom_bytes','inventory_digest']}))
    return 0 if result['quiescent'] else 1

if __name__=='__main__':raise SystemExit(main())
