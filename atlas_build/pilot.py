"""External read-only pilot monitor. No container receives the Docker socket.

Run on the authorized host after the seven isolated services are healthy. It
compares every legacy observation with a frozen preflight, checks new image and
resource pins, and supplies short-lived observations to only the QA control DB.
A missing/failed monitor expires admission and build growth within 12 seconds.
"""
import argparse,json,os,selectors,subprocess,time
from datetime import datetime,timezone
from pathlib import Path
from .legacy import collect,command
from .monitor import guard_root,own_capacity,validate_attestation,validate_cgroup_limits

PROJECT='atlas-phase1c-fixture'


def own_inventory():
    names=command(['docker','ps','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Names}}']).splitlines()
    if not names:raise ValueError('Isolated service inventory is empty.')
    return json.loads(command(['docker','inspect',*names]))


def candidate_bytes():
    data=command(['docker','exec',PROJECT+'-candidate-db-1','du','-s','-B1','/var/lib/postgresql/data'],timeout=5)
    fields=data.split()
    if len(fields)!=2 or fields[1]!='/var/lib/postgresql/data' or not fields[0].isdigit():raise ValueError('Unbounded candidate allocation observation.')
    return int(fields[0])


def effective_cgroups(rows):
    # PostgreSQL images intentionally contain no Python interpreter. The same
    # bounded file reads run through a tiny shell there and Python elsewhere.
    result={}
    for row in rows:
        name=row['Name'].lstrip('/')
        files={}
        for field in ['cpu.max','memory.max','memory.swap.max','memory.current','memory.peak','memory.events','io.max','io.stat','cpu.stat']:
            raw=command(['docker','exec',name,'cat','/sys/fs/cgroup/'+field],timeout=5)
            if len(raw)>16384:raise ValueError('Cgroup observation exceeded its bound.')
            files[field]=raw.strip()
        result[name]=files
    return result


def main():
    if Path('/.dockerenv').exists():raise SystemExit('Run the external monitor on the authorized Atlas host.')
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--baseline',required=True)
    parser.add_argument('--physical-device',default='8:0');parser.add_argument('--revision',required=True);parser.add_argument('--pins',required=True);parser.add_argument('--seconds',type=int,default=900)
    args=parser.parse_args();root=Path(args.root);baseline=json.loads(Path(args.baseline).read_text());pins=json.loads(Path(args.pins).read_text())
    if not 1<=args.seconds<=3600:raise SystemExit('Pilot monitor window must be between one second and one hour.')
    guard_root(root,baseline['inventory']);rows=own_inventory();own_capacity(rows,args.revision,pins)
    evidence=root/'evidence';evidence.mkdir(exist_ok=True)
    before=effective_cgroups(rows);validate_cgroup_limits(before,args.physical_device);(evidence/'pilot-cgroups-before.json').write_text(json.dumps(before,indent=2))
    errors=(evidence/'pilot-attest.stderr').open('ab')
    sink=subprocess.Popen(['docker','exec','-i',PROJECT+'-web-1','python','manage.py','atlas_build_attest','--stream'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,bufsize=0)
    selector=selectors.DefaultSelector();selector.register(sink.stdout,selectors.EVENT_READ)
    started=time.monotonic();samples=0;last=None
    try:
        with (evidence/'pilot-monitor.jsonl').open('a') as log:
            while time.monotonic()-started<args.seconds:
                tick=time.monotonic();observation=collect();rows=own_inventory();memory=own_capacity(rows,args.revision,pins)
                guard_root(root,observation['inventory'])
                observation['quiescent']=bool(observation['quiescent'] and observation['inventory_digest']==baseline['inventory_digest'])
                observation.update(candidate_bytes=candidate_bytes(),new_service_uncommitted=memory,
                     monitor_elapsed_seconds=time.monotonic()-tick)
                if observation['monitor_elapsed_seconds']>8:observation['quiescent']=False
                validate_attestation(observation)
                log.write(json.dumps(observation,sort_keys=True)+'\n');log.flush()
                sink.stdin.write((json.dumps(observation,separators=(',',':'))+'\n').encode());sink.stdin.flush()
                if not selector.select(timeout=5) or sink.stdout.readline()!=b'accepted\n':raise ValueError('QA attestation sink did not acknowledge the observation.')
                samples+=1;last=observation
                if not observation['quiescent']:raise ValueError('Legacy inventory/work changed or observation exceeded its bound; pilot stopped.')
                time.sleep(max(0,2-(time.monotonic()-tick)))
    finally:
        sink.stdin.close()
        try:sink.wait(timeout=5)
        except subprocess.TimeoutExpired:sink.terminate();sink.wait(timeout=5)
        selector.close();errors.close()
        (evidence/'pilot-monitor-summary.json').write_text(json.dumps({'samples':samples,'elapsed_seconds':time.monotonic()-started,
             'last_observation':last,'attestation_expiry_seconds':12},indent=2))
        (evidence/'pilot-cgroups-after.json').write_text(json.dumps(effective_cgroups(own_inventory()),indent=2))
    print(json.dumps({'samples':samples,'elapsed_seconds':time.monotonic()-started}))

if __name__=='__main__':main()
