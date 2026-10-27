#!/usr/bin/env python3
"""Isolated Linux engine laboratory. Never activates the legacy platform or deletes its data."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import re
from pathlib import Path
import secrets
import shutil
import statistics
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / "infra/atlas/lab"
STATE = ROOT / ".lab-state"
ENV = STATE / "runtime.env"


def run(args, *, data=None, log=None, env=None):
    if log:
        with log.open("a", encoding="utf8") as output:
            result = subprocess.run(args, input=data, text=True, stdout=output, stderr=subprocess.STDOUT,env=env)
    else:
        result = subprocess.run(args, input=data, text=True, capture_output=True,env=env)
    if result.returncode:
        raise RuntimeError(f"command {args[0]} failed ({result.returncode}); see {log or 'stderr'}" +
                           ("" if log else ": " + result.stderr[-3000:]))
    return "" if log else result.stdout


def compose(*args, **kwargs):
    return run(["docker", "compose", "--project-name", "atlas-lab", "--env-file", str(ENV), "-f", str(LAB/"compose.yml"), *args], **kwargs)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024*1024), b""):
            h.update(chunk)
    return h.hexdigest()


def save(path, content, mode=0o600):
    temp = path.with_name(path.name+".partial")
    with temp.open("w", encoding="utf8", newline="\n") as stream:
        json.dump(content,stream,ensure_ascii=False,indent=2) if not isinstance(content,str) else stream.write(content)
        stream.write("\n")
        stream.flush(); os.fsync(stream.fileno())
    temp.chmod(mode); temp.replace(path)


def sql(text, database="atlas_lab"):
    return compose("exec","-T","db","psql","-X","-qAt","-U","atlas_admin","-d",database,"-v","ON_ERROR_STOP=1",data=text)


def initialize_database(passwords):
    compose("up","-d","db")
    for _ in range(90):
        try: sql("SELECT 1"); break
        except RuntimeError: time.sleep(2)
    else: raise RuntimeError("database did not become ready")
    sql((LAB/"setup.sql").read_text())
    sql(f"ALTER ROLE atlas_import PASSWORD '{passwords['import']}'; ALTER ROLE atlas_tile PASSWORD '{passwords['tile']}';")
    if not sql("SELECT 1 FROM pg_database WHERE datname='atlas_test_registry'",database="postgres").strip():
        sql("CREATE DATABASE atlas_test_registry OWNER atlas_admin",database="postgres")
    save(STATE/"prepared.json",{"schema":"atlas.lab-prepared/1","complete":True})


def prepare(args):
    if os.name != "posix":
        raise RuntimeError("lab execution requires Linux Docker")
    source = args.source.resolve(strict=True)
    if not source.is_file() or args.source.is_symlink() or not source.name.endswith('.osm.pbf'):
        raise ValueError("source must be a regular .osm.pbf file")
    if any(c in str(source) for c in '\r\n:$'):
        raise ValueError("source path cannot be represented safely in the compose environment")
    if sha(source) != args.expected_sha256:
        raise ValueError("source does not match the expected SHA-256")
    STATE.mkdir(mode=0o700,exist_ok=True)
    if ENV.exists():
        previous = json.loads((STATE/"settings.json").read_text())
        if previous["source_sha256"] != args.expected_sha256 or previous["source"] != str(source):
            raise RuntimeError("lab belongs to a different input; use a separate lab instead of overwriting it")
        if not (STATE/"prepared.json").exists():
            password = re.search(r'password=([0-9a-f]{48})', (STATE/"pg_tileserv.toml").read_text())
            if not password: raise RuntimeError("incomplete credential state cannot be recovered automatically")
            initialize_database({"import":(STATE/"pgpass").read_text().strip().rsplit(':',1)[1],"tile":password[1]})
        print(json.dumps({"prepared":True,"reused_existing_state":True}))
        return
    lock = json.loads((LAB/"images.lock.json").read_text())
    # Artifacts may be transferred from a connected preparation machine.
    archive = args.martin_archive.resolve(strict=True)
    if sha(archive) != lock["martin"]["sha256"]:
        raise ValueError("Martin upstream artifact digest mismatch")
    import tarfile
    build = STATE/"martin-build"; build.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar:
        binary = next((m for m in tar.getmembers() if Path(m.name).name == "martin" and m.isfile()),None)
        if not binary: raise ValueError("Martin binary missing from archive")
        with tar.extractfile(binary) as reader, (build/"martin").open("wb") as writer:
            shutil.copyfileobj(reader,writer)
    run(["docker","build","--network=none","-t","atlas-lab/martin:1.16.1","-f",str(LAB/"Dockerfile.martin"),str(build)],log=STATE/"martin-build.log")
    identities = {}
    for role,ref in lock["images"].items():
        # Pulling is preparation only. Runtime compose always uses pull_policy: never.
        try: info = json.loads(run(["docker","image","inspect",ref]))[0]
        except RuntimeError:
            run(["docker","pull",ref],log=STATE/"pull.log")
            info = json.loads(run(["docker","image","inspect",ref]))[0]
        if info["Os"] != "linux" or info["Architecture"] != "amd64": raise ValueError("unexpected image platform")
        identities[role] = {"ref":ref,"image_id":info["Id"]}
    martin = json.loads(run(["docker","image","inspect","atlas-lab/martin:1.16.1"]))[0]
    identities["MARTIN"] = {"ref":martin["Id"],"image_id":martin["Id"],"upstream_archive_sha256":sha(archive)}
    passwords = {name:secrets.token_hex(24) for name in ("admin","import","tile")}
    save(STATE/"db_password",passwords["admin"])
    # Import and tile services use the owner's uid. The private parent directory
    # protects credentials, and each service gets only its own required mount.
    save(STATE/"pgpass",f"db:5432:*:atlas_import:{passwords['import']}")
    martin_config = (LAB/"martin.yml").read_text().replace('postgresql://atlas_tile@db/atlas_lab',f"postgresql://atlas_tile:{passwords['tile']}@db/atlas_lab?sslmode=disable")
    save(STATE/"martin.yml",martin_config)
    tiles_config = (LAB/"pg_tileserv.toml").read_text().replace('user=atlas_tile sslmode=disable',f"user=atlas_tile password={passwords['tile']} sslmode=disable")
    save(STATE/"pg_tileserv.toml",tiles_config)
    settings = {"source":str(source),"source_sha256":args.expected_sha256,"images":identities}
    save(STATE/"settings.json",settings)
    env = {"ATLAS_LAB_STATE":str(STATE),"ATLAS_PBF":str(source),**{f"ATLAS_IMAGE_{role}":i["ref"] for role,i in identities.items()}}
    save(ENV,"\n".join(f'{k}={json.dumps(v)}' for k,v in env.items()))
    # Secrets go to psql on stdin, never to the command line or the published report.
    initialize_database(passwords)
    print(json.dumps({"prepared":True,"source_sha256":args.expected_sha256,"images":identities}))


def import_data(args):
    settings = json.loads((STATE/"settings.json").read_text())
    report = json.loads(args.audit.read_text(encoding="utf8"))
    if report["source"]["sha256"] != settings["source_sha256"] or report["blockers"]:
        raise ValueError("input audit does not authorize structural staging import")
    if sha(Path(settings["source"])) != settings["source_sha256"]: raise ValueError("source changed")
    if sql("SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('osm_raw','render')").strip() != "0":
        raise RuntimeError("lab database is not empty; refusing to overwrite it")
    started = time.monotonic()
    compose("run","--rm","--no-deps","-T","importer","--create","--slim","--drop","--extra-attributes",
            "--middle-schema=import_work","--output=flex","--style=/config/raw.lua","--cache=256",
            "--number-processes=2","-H","db","-U","atlas_import","-d","atlas_lab","/in/input.osm.pbf",log=STATE/"import.log")
    sql("REASSIGN OWNED BY atlas_import TO atlas_admin; REVOKE ALL ON SCHEMA osm_raw,render,import_work FROM atlas_import;")
    sql((ROOT/'infra/atlas/raw-finalize.sql').read_text())
    sql((ROOT/"infra/atlas/tiles.sql").read_text())
    summary = json.loads(sql("""SELECT json_build_object(
      'node',(SELECT count(*) FROM osm_raw.nodes),
      'way',(SELECT count(*) FROM osm_raw.ways),
      'relation',(SELECT count(*) FROM osm_raw.relations),
      'way_node_references',(SELECT sum(cardinality(nodes)) FROM osm_raw.ways),
      'relation_member_references',(SELECT sum(jsonb_array_length(members)) FROM osm_raw.relations),
      'database_bytes',pg_database_size(current_database()));"""))
    for kind in ("node","way","relation"):
        if summary[kind] != report["counts"][kind]: raise ValueError(f"raw {kind} count mismatch")
    if summary["way_node_references"] != report["references"]["counts"].get("way_to_node",0): raise ValueError("way reference count mismatch")
    relation_refs = sum(v for k,v in report["references"]["counts"].items() if k.startswith('relation_'))
    if summary["relation_member_references"] != relation_refs: raise ValueError("relation reference count mismatch")
    if sha(Path(settings["source"])) != settings["source_sha256"]: raise ValueError("source changed during import")
    save(STATE/"import-report.json",{"schema":"atlas.lab-import/1","source_sha256":settings["source_sha256"],
         "counts_verified":True,"semantic_roundtrip_verified":False,"summary":summary,
         "input_review_reasons":report["review_reasons"],"seconds":round(time.monotonic()-started,3)},0o644)
    compose("up","-d","martin","pgtileserv")
    print(json.dumps({"imported":summary,"seconds":round(time.monotonic()-started,3)}))


def selftest(args):
    report = json.loads(args.audit.read_text(encoding='utf8'))
    source = args.source.resolve(strict=True)
    if sha(source) != report['source']['sha256'] or report['blockers']:
        raise ValueError('fixture audit mismatch')
    database = 'atlas_test_catalog_'+secrets.token_hex(6)
    sql(f'CREATE DATABASE {database} OWNER atlas_admin',database='postgres')
    try:
        sql((LAB/'setup.sql').read_text(),database=database)
        compose('run','--rm','--no-deps','-T','importer','--create','--slim','--drop','--extra-attributes',
                '--middle-schema=import_work','--output=flex','--style=/config/raw.lua','--cache=64',
                '--number-processes=1','-H','db','-U','atlas_import','-d',database,'/in/input.osm.pbf',
                log=STATE/'fixture-import.log',env={**os.environ,'ATLAS_PBF':str(source)})
        sql((ROOT/'infra/atlas/raw-finalize.sql').read_text(),database=database)
        sql((ROOT/'infra/atlas/tiles.sql').read_text(),database=database)
        counts = [int(sql(f'SELECT count(*) FROM osm_raw.{table}',database=database).strip()) for table in ('nodes','ways','relations')]
        if counts != [report['counts'][kind] for kind in ('node','way','relation')]: raise ValueError('fixture raw count mismatch')
        z,x,y = tile_xy(0.03,0.02,14)
        if int(sql(f'SELECT octet_length(tiles.basemap({z},{x},{y}))',database=database).strip()) <= 0: raise ValueError('fixture MVT is empty')
        run(['docker','run','--rm','--user','1000:1000','--network','atlas-lab_backend',
             '-v',f'{ROOT}:/src','-v',f'{STATE}/db_password:/run/secrets/db_password:ro',
             '-v',f'{args.audit.resolve()}:/in/audit.json:ro','-e',f'ATLAS_RAW_DATABASE={database}',
             '-w','/src','node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20',
             'node','tools/verify-raw.mjs','/in/audit.json','/src/.lab-state/fixture-roundtrip.json'],log=STATE/'fixture-roundtrip.log')
        save(STATE/'selftest.json',{'schema':'atlas.lab-selftest/1','counts':counts,'mvt_nonempty':True},0o644)
        print(json.dumps({'fixture_counts':counts,'mvt_nonempty':True}))
    finally:
        # Only this freshly generated, dedicated test database is ever dropped.
        sql(f'DROP DATABASE {database} WITH (FORCE)',database='postgres')


def tile_xy(lon,lat,z):
    n = 2**z
    return z,int((lon+180)/360*n),int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n)


def benchmark(args):
    # Fixed geographic samples, explicit warm-up, serial engine order alternated by round.
    sites = {"tehran":(51.389,35.6892),"mashhad":(59.6062,36.2605),"shiraz":(52.5311,29.5918),
             "tabriz":(46.2919,38.0962),"ahvaz":(48.6692,31.3183),"rural":(58.5,32.4)}
    paths = [(*tile_xy(lon,lat,z),name) for name,(lon,lat) in sites.items() for z in (6,10,14,16)]
    engines = {"martin":"http://127.0.0.1:3111/basemap/{z}/{x}/{y}",
               "pgtileserv":"http://127.0.0.1:7801/tiles.basemap/{z}/{x}/{y}.pbf"}
    def request(engine,item):
        z,x,y,name = item; started = time.monotonic()
        url = engines[engine].format(z=z,x=x,y=y)
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={"Accept-Encoding":"identity"}),timeout=15) as response:
                body = response.read(32*1024*1024+1)
                if len(body)>32*1024*1024: raise ValueError("tile exceeded bound")
                return {"engine":engine,"site":name,"z":z,"x":x,"y":y,"status":response.status,
                        "bytes":len(body),"sha256":hashlib.sha256(body).hexdigest(),"ms":round((time.monotonic()-started)*1000,3)}
        except Exception as error:
            return {"engine":engine,"site":name,"z":z,"x":x,"y":y,"error":type(error).__name__,"ms":round((time.monotonic()-started)*1000,3)}
    for engine in engines:
        request(engine,paths[0])
    rows = []
    for round_number in range(args.rounds):
        for engine in (list(engines) if round_number%2==0 else list(reversed(engines))):
            with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
                rows.extend(executor.map(lambda item:request(engine,item),paths))
    summary = {}
    for engine in engines:
        selected = [r for r in rows if r['engine']==engine]; times = sorted(r['ms'] for r in selected)
        summary[engine] = {"requests":len(selected),"errors":sum('error' in r or r.get('status') not in (200,204) for r in selected),
                           "p50_ms":statistics.median(times),"p95_ms":times[math.ceil(len(times)*.95)-1],"max_ms":max(times)}
    report = {"schema":"atlas.engine-comparison/1","concurrency":args.concurrency,"rounds":args.rounds,
              "cache":"HTTP application caches disabled; shared PostgreSQL buffers are warmed by both engines",
              "summary":summary,"requests":rows,"production_capacity_established":False}
    save(STATE/"benchmark.json",report,0o644)
    print(json.dumps(summary))
    if any(s['errors'] for s in summary.values()): raise RuntimeError("benchmark contains request failures")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command",required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("--source",type=Path,required=True)
    setup.add_argument("--expected-sha256",required=True)
    setup.add_argument("--martin-archive",type=Path,required=True)
    importing = commands.add_parser("import")
    importing.add_argument("--audit",type=Path,required=True)
    testing = commands.add_parser('selftest')
    testing.add_argument('--source',type=Path,required=True)
    testing.add_argument('--audit',type=Path,required=True)
    bench = commands.add_parser("benchmark")
    bench.add_argument("--rounds",type=int,default=4)
    bench.add_argument("--concurrency",type=int,choices=range(1,17),default=4)
    args = parser.parse_args()
    if args.command == 'prepare': prepare(args)
    elif args.command == 'import': import_data(args)
    elif args.command == 'selftest': selftest(args)
    else:
        if not 1<=args.rounds<=100: parser.error('rounds must be in 1..100')
        benchmark(args)


if __name__ == '__main__': main()
