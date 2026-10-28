"""Disposable real-engine CI check for catalog omissions; fictional data only.

Run after building infra/atlas/intake/Dockerfile.audit as atlas-audit-ci.
All resources have a fresh unguessable name and are removed in finally.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
PG = 'postgis/postgis@sha256:1ac10b2551ba84ae05db8e7da477afcd0a3fede99bcb7705da2ee157390cb095'
IMPORTER = 'iboates/osm2pgsql@sha256:6548a1e2492e08fa0d5ce987d382ad57c4b21c8a94ff00017c6109770a061b79'


def run(*args, data=None, required=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if required and result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


def main():
    name = 'atlas-ci-catalog-' + uuid.uuid4().hex
    network, database, importer = name + '-net', name + '-db', name + '-import'
    password = uuid.uuid4().hex  # discarded with the test database
    run('docker', 'pull', PG)
    run('docker', 'pull', IMPORTER)
    run('docker', 'network', 'create', '--internal', network)
    try:
        run('docker', 'run', '-d', '--name', database, '--network', network,
            '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
            '-e', 'POSTGRES_USER=atlas_ci', '-e', 'POSTGRES_DB=atlas_test_catalog',
            '-e', 'POSTGRES_PASSWORD=' + password, PG)

        def sql(query):
            return run('docker', 'exec', '-i', database, 'psql', '-v', 'ON_ERROR_STOP=1',
                       '-At', '-U', 'atlas_ci', '-d', 'atlas_test_catalog', data=query).stdout.strip()

        for _ in range(120):
            ready = run('docker', 'exec', database, 'pg_isready', '-h', '127.0.0.1',
                        '-U', 'atlas_ci', '-d', 'atlas_test_catalog', required=False)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('disposable PostGIS did not become ready')
        sql('CREATE SCHEMA osm_raw; CREATE SCHEMA render; CREATE SCHEMA import_work;')
        with tempfile.TemporaryDirectory(prefix='atlas-ci-catalog-') as folder:
            os.chmod(folder, 0o755)
            run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--user', f'{os.getuid()}:{os.getgid()}', '-v', f'{ROOT}:/src:ro', '-v', f'{folder}:/out',
                '--entrypoint', 'python', 'atlas-audit-ci', '-I', '/src/tools/build-candidate-fixtures.py', '/out')
            args = ['docker', 'run', '--name', importer, '--network', network, '--read-only',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '512m', '--memory-swap', '512m',
                    '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
                    '-e', 'PGPASSWORD=' + password, '-v', f'{folder}:/in:ro']
            for source, target in [('infra/atlas/raw.lua', 'raw.lua'),
                                   ('infra/atlas/catalog-observed.lua', 'render.lua'),
                                   ('infra/atlas/catalog-details.lua', 'catalog-details.lua'),
                                   ('infra/atlas/catalog-core-v2.lua', 'catalog-core.lua')]:
                args += ['-v', f'{ROOT / source}:/config/{target}:ro']
            run(*args, '--entrypoint', 'osm2pgsql', IMPORTER, '--create', '--slim', '--drop',
                '--extra-attributes', '--middle-schema=import_work', '--output=flex',
                '--style=/config/raw.lua', '--cache=64', '--number-processes=1',
                '-H', database, '-U', 'atlas_ci', '-d', 'atlas_test_catalog', '/in/candidate-geometry.osm.pbf')
        counts = json.loads(sql("SELECT json_build_array((SELECT count(*) FROM osm_raw.nodes),"
                                "(SELECT count(*) FROM osm_raw.ways),(SELECT count(*) FROM osm_raw.relations),"
                                "(SELECT count(*) FROM render.object_outcomes));"))
        assert counts == [6, 3, 1, 8], counts
        assert json.loads(sql('SELECT to_json(nodes) FROM osm_raw.ways WHERE osm_id=20')) == [1, 2, 1]
        outcomes = json.loads(sql("SELECT json_object_agg(osm_type||osm_id,status) FROM render.object_outcomes"))
        assert outcomes == {'N3': 'rendered', 'N4': 'uncatalogued', 'N5': 'catalog_policy_excluded',
                            'N6': 'metadata_only', 'W10': 'rendered', 'W20': 'partial',
                            'W21': 'geometry_rejected', 'R30': 'geometry_rejected'}, outcomes
        assert sql('SELECT count(*) FROM render.transport') == '2'
        assert sql('SELECT count(*) FROM render.buildings') == '0'
        print(json.dumps({'passed': True, 'fixture': 'fictional geometry outcomes', 'counts': counts}))
    finally:
        run('docker', 'rm', '-fv', importer, required=False)
        run('docker', 'rm', '-fv', database, required=False)
        run('docker', 'network', 'rm', network, required=False)


if __name__ == '__main__':
    main()
