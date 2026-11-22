"""Privileged typed candidate operations. Importers never receive this credential.

Only this process connects with candidate administration rights. The control
plane journals each requested operation first; a second maintenance ledger makes
CREATE DATABASE's pre-marker gap reconcilable by exact owner OID and cluster.
"""
from contextlib import contextmanager
import hashlib,hmac,json,os
from pathlib import Path
from uuid import UUID
import psycopg
from psycopg import sql
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils import timezone
from .control import fixture_guard,VERSIONS
from .models import Candidate,DDLOperation
from .catalog import snapshot as schema_snapshot,fingerprint as schema_fingerprint


def names(candidate,generation):
    candidate=UUID(str(candidate))
    if type(generation) is not int or not 0<generation<100000000:
        raise ValidationError('Invalid provisioning generation.')
    suffix=candidate.hex+'_g'+str(generation).zfill(8)
    return {key:prefix+suffix for key,prefix in [('database','atc_'),('owner','ato_'),('loader','atl_'),('reader','atr_')]}


def assert_owned(observed,journal,expected):
    if (not journal or journal.get('database')!=expected['database']
            or journal.get('cluster')!=expected['cluster'] or journal.get('marker')!=expected['marker']
            or not journal.get('owner_oid') or observed.get('database')!=expected['database']
            or observed.get('cluster')!=expected['cluster'] or observed.get('owner_oid')!=journal['owner_oid']
            or (observed.get('marker') is None and journal.get('state')!='create_requested')
            or observed.get('marker') not in [None,expected['marker']]):
        raise ValidationError('Unknown or mismatched candidate ownership is quarantined.')
    if journal.get('database_oid') and observed['database_oid']!=journal['database_oid']:
        raise ValidationError('Candidate database OID changed.')
    return True



def assert_registered_target(identity,observed,cluster,database):
    if identity and (not observed or identity.get('cluster')!=cluster or identity.get('database')!=database
            or observed.get('cluster')!=identity.get('cluster') or observed.get('database')!=identity.get('database')
            or observed.get('database_oid')!=identity.get('database_oid') or observed.get('owner_oid')!=identity.get('owner_oid')):
        raise ValidationError('A registered candidate target is missing or changed; it is never recreated.')
    return True


def operation_marker(candidate,execution):
    intent=execution.intent
    return {'candidate':str(candidate.pk),'execution':str(execution.pk),'generation':execution.generation,
            'intent':str(intent.pk),'scope':'fixture','profile':str(intent.profile_id),
            'epoch':str(intent.receipt.epoch),'schema':VERSIONS['schema'],
            'control_database':settings.DATABASES['default']['NAME']}


class Provisioner:
    def __init__(self,*,fault=lambda step:None):self.fault=fault

    def connect(self,database='postgres'):
        password=Path(os.environ['ATLAS_CANDIDATE_ADMIN_PASSWORD_FILE']).read_text().strip()
        conn=psycopg.connect(host=os.environ.get('ATLAS_CANDIDATE_HOST','candidate-db'),port=5432,
            dbname=database,user='atlas_candidate_admin',password=password,connect_timeout=5,autocommit=True,
            application_name='atlas-fixture-provisioner')
        conn.execute("SET log_min_error_statement='panic'")
        conn.execute("SET statement_timeout='30s'")
        conn.execute("SET lock_timeout='3s'")
        return conn

    def password(self,candidate,role):
        secret=Path(os.environ['ATLAS_CANDIDATE_CREDENTIAL_KEY_FILE']).read_bytes()
        return hmac.new(secret,(str(candidate)+':'+role).encode(),hashlib.sha256).hexdigest()

    def bootstrap(self):
        with self.connect() as conn:
            conn.execute('CREATE SCHEMA IF NOT EXISTS atlas_admin')
            conn.execute('CREATE TABLE IF NOT EXISTS atlas_admin.ownership(candidate uuid PRIMARY KEY, document jsonb NOT NULL)')
            for (name,) in conn.execute("SELECT datname FROM pg_database WHERE datname IN ('postgres','template1','template_postgis') AND datallowconn"):
                conn.execute(sql.SQL('REVOKE CONNECT,CREATE,TEMP ON DATABASE {} FROM PUBLIC').format(sql.Identifier(name)))
        return self.info()

    def info(self):
        with self.connect() as conn:
            version=conn.execute('SHOW server_version').fetchone()[0]
            if not version.startswith('17.12'):raise ValidationError('Candidate PostgreSQL version differs from approved pin.')
            cluster=str(conn.execute('SELECT system_identifier FROM pg_control_system()').fetchone()[0])
            lsn=conn.execute('SELECT pg_current_wal_insert_lsn()::text').fetchone()[0]
        data=Path(os.environ.get('ATLAS_CANDIDATE_DATA','/candidate-data'))
        return {'cluster':cluster,'postgres':version,'filesystem':str(os.stat(data).st_dev),'lsn':lsn}

    def authorize(self,candidate_id,execution_id,token,operation):
        fixture_guard()
        candidate=Candidate.objects.select_related('execution__intent__profile').get(pk=candidate_id)
        execution=candidate.execution;intent=execution.intent;profile=intent.profile
        if (str(execution.pk)!=str(execution_id) or str(execution.token)!=str(token)
                or profile.scope!='fixture' or intent.scope!='fixture'
                or intent.receipt.profile_id!=profile.pk):
            raise ValidationError('Provisioner execution/scope authorization failed.')
        if operation=='cancel':
            if candidate.ready_at or candidate.status=='READY':
                raise ValidationError('READY resources cannot be cancelled by a builder.')
        elif operation=='drop':
            if candidate.ready_at or candidate.status not in ['FAILED','CANCELLED']:
                raise ValidationError('Only never-READY failed owned candidates may be cleaned.')
        elif operation in ['reader_access','inspect'] and candidate.status=='READY' and not candidate.revoked_at:
            pass
        elif (not profile.enabled or profile.epoch!=intent.receipt.epoch or intent.generation!=execution.generation or intent.cancelled_at or execution.status not in ['running','prepared']
                or not execution.lease_until or execution.lease_until<=timezone.now()):
            raise ValidationError('Provisioner execution lost its current lease.')
        n=names(candidate.pk,execution.generation)
        marker=operation_marker(candidate,execution)
        return candidate,execution,n,marker

    def journal(self,conn,candidate):
        row=conn.execute('SELECT document FROM atlas_admin.ownership WHERE candidate=%s',[candidate]).fetchone()
        return row[0] if row else None

    def observe(self,conn,n,cluster):
        row=conn.execute("SELECT oid,datdba,shobj_description(oid,'pg_database') FROM pg_database WHERE datname=%s",[n['database']]).fetchone()
        if not row:return None
        try:marker=json.loads(row[2]) if row[2] else None
        except ValueError:raise ValidationError('Unrecognized database ownership marker.') from None
        return {'database':n['database'],'database_oid':row[0],'owner_oid':row[1],'cluster':cluster,'marker':marker}

    def save_journal(self,conn,candidate,document):
        conn.execute('INSERT INTO atlas_admin.ownership VALUES(%s,%s::jsonb) ON CONFLICT(candidate) DO UPDATE SET document=excluded.document',
                     [candidate,json.dumps(document,sort_keys=True)])

    @contextmanager
    def operation(self,candidate_id,execution_id,token,operation):
        c,e,n,marker=self.authorize(candidate_id,execution_id,token,operation)
        journal=DDLOperation.objects.filter(candidate=c,operation=operation).first()
        if operation not in ['metrics','inspect','reader_access'] and (not journal or journal.intended.get('marker')!=marker):
            raise ValidationError('Typed DDL intent must precede the external operation.')
        with self.connect() as conn:
            cluster=str(conn.execute('SELECT system_identifier FROM pg_control_system()').fetchone()[0])
            creation=DDLOperation.objects.filter(candidate=c,operation='create').first()
            expected=c.identity.get('cluster') or (journal.intended.get('cluster') if journal else None) or (creation.intended.get('cluster') if creation else None)
            if operation=='create' and not expected:raise ValidationError('Cluster identity must be recorded before CREATE.')
            if expected and expected!=cluster:raise ValidationError('Recorded candidate cluster identity changed.')
            # Session lock serializes ambiguous duplicates across autocommit DDL;
            # no control transaction/lock is held over this operation.
            key=int.from_bytes(hashlib.sha256(c.pk.bytes).digest()[:8],byteorder='big',signed=True)
            if not conn.execute('SELECT pg_try_advisory_lock(%s)',[key]).fetchone()[0]:
                raise ValidationError('An ambiguous operation is still in progress; reconcile before retry.')
            try:yield c,e,n,marker,journal,conn
            finally:conn.execute('SELECT pg_advisory_unlock(%s)',[key])
        self.authorize(candidate_id,execution_id,token,operation)

    def create(self,candidate_id,execution_id,token):
        with self.operation(candidate_id,execution_id,token,'create') as (c,e,n,marker,intent,conn):
            if c.status not in ['CREATE_INTENT','LOADING']:raise ValidationError('Cannot create or reopen this candidate phase.')
            cluster=self.info()['cluster'];expected={'database':n['database'],'cluster':cluster,'marker':marker}
            doc=self.journal(conn,c.pk);observed=self.observe(conn,n,cluster)
            assert_registered_target(c.identity,observed,cluster,n['database'])
            if observed:
                assert_owned(observed,doc,expected)
            else:
                if doc and doc.get('state') not in ['roles_created','create_requested']:
                    raise ValidationError('A registered candidate database is missing; it will not be recreated.')
                if not doc:
                    with conn.transaction():
                        for kind in ['owner','loader','reader']:
                            row=conn.execute('SELECT oid FROM pg_roles WHERE rolname=%s',[n[kind]]).fetchone()
                            if row:raise ValidationError('Preexisting unjournaled role name is quarantined.')
                            login=sql.SQL('NOLOGIN') if kind=='owner' else sql.SQL('LOGIN PASSWORD {}').format(sql.Literal(self.password(c.pk,n[kind])))
                            conn.execute(sql.SQL('CREATE ROLE {} {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3').format(sql.Identifier(n[kind]),login))
                            conn.execute(sql.SQL('COMMENT ON ROLE {} IS {}').format(sql.Identifier(n[kind]),sql.Literal(json.dumps(marker,sort_keys=True))))
                        role_oids={kind:conn.execute('SELECT oid FROM pg_roles WHERE rolname=%s',[n[kind]]).fetchone()[0]
                                   for kind in ['owner','loader','reader']}
                        doc={**expected,'owner_oid':role_oids['owner'],'role_oids':role_oids,'state':'roles_created'}
                        self.save_journal(conn,c.pk,doc)
                    self.fault('after_roles')
                    self.authorize(candidate_id,execution_id,token,'create')
                self.check_roles(conn,n,doc)
                doc={**doc,'state':'create_requested'};self.save_journal(conn,c.pk,doc)
                self.authorize(candidate_id,execution_id,token,'create')
                self.fault('before_create_database')
                conn.execute(sql.SQL("CREATE DATABASE {} WITH OWNER {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' ALLOW_CONNECTIONS false").format(sql.Identifier(n['database']),sql.Identifier(n['owner'])))
                self.fault('after_create_database')
                self.authorize(candidate_id,execution_id,token,'create')
                observed=self.observe(conn,n,cluster);assert_owned(observed,doc,expected)
            self.check_roles(conn,n,doc)
            conn.execute(sql.SQL('REVOKE ALL ON DATABASE {} FROM PUBLIC').format(sql.Identifier(n['database'])))
            conn.execute(sql.SQL('ALTER DATABASE {} ALLOW_CONNECTIONS true').format(sql.Identifier(n['database'])))
            self.authorize(candidate_id,execution_id,token,'create')
            conn.execute(sql.SQL('COMMENT ON DATABASE {} IS {}').format(sql.Identifier(n['database']),sql.Literal(json.dumps(marker,sort_keys=True))))
            observed=self.observe(conn,n,cluster)
            if doc['state']!='configured':
                with self.connect(n['database']) as data:
                    exists=data.execute("SELECT to_regclass('atlas_meta.identity')").fetchone()[0]
                    if exists:
                        existing=data.execute('SELECT marker FROM atlas_meta.identity WHERE singleton').fetchone()
                        if not existing or existing[0]!=marker:raise ValidationError('Existing schema ownership marker disagrees.')
                    else:
                        with data.transaction():
                            data.execute("CREATE EXTENSION postgis VERSION '3.7.0'")
                            native=data.execute('SELECT postgis_full_version()').fetchone()[0]
                            if data.execute("SELECT extversion FROM pg_extension WHERE extname='postgis'").fetchone()[0]!='3.7.0':
                                raise ValidationError('PostGIS version differs from approved pin.')
                            data.execute(sql.SQL('SET LOCAL ROLE {}').format(sql.Identifier(n['owner'])))
                            data.execute((Path(__file__).parent/'schema.sql').read_text(),prepare=False)
                            data.execute('INSERT INTO atlas_meta.identity VALUES(true,%s::jsonb,%s,NULL)',[json.dumps(marker),'LOADING'])
                            data.execute('RESET ROLE')
                            data.execute(sql.SQL('REVOKE ALL ON DATABASE {} FROM PUBLIC').format(sql.Identifier(n['database'])))
                            data.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
                            for who in ['loader','reader']:
                                data.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(n['database']),sql.Identifier(n[who])))
                                data.execute(sql.SQL('GRANT USAGE ON SCHEMA public,raw,spatial,atlas_meta TO {}').format(sql.Identifier(n[who])))
                            data.execute(sql.SQL('GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA raw,spatial TO {}').format(sql.Identifier(n['loader'])))
                            data.execute(sql.SQL('GRANT SELECT ON atlas_meta.identity TO {}').format(sql.Identifier(n['loader'])))
                            data.execute(sql.SQL('GRANT SELECT ON ALL TABLES IN SCHEMA raw,spatial,atlas_meta TO {}').format(sql.Identifier(n['reader'])))
                            self.remove_write_functions(data,n)
                self.authorize(candidate_id,execution_id,token,'create')
                with self.connect(n['database']) as data:catalog=schema_snapshot(data)
                doc={**doc,'database_oid':observed['database_oid'],'state':'configured',
                     'schema_catalog_sha256':schema_fingerprint(catalog),'schema_sha256':hashlib.sha256((Path(__file__).parent/'schema.sql').read_bytes()).hexdigest()}
                self.save_journal(conn,c.pk,doc)
            self.fault('after_configuration')
            with self.connect(n['database']) as data:native=data.execute('SELECT postgis_full_version()').fetchone()[0]
            result={**observed,'marker':marker,'names':n,'native':native,
                    'schema_catalog_sha256':doc.get('schema_catalog_sha256'),'schema_sha256':doc.get('schema_sha256')}
        return {'identity':result,'loader':self.credentials(c.pk,n,'loader'),'reader':self.credentials(c.pk,n,'reader')}

    def credentials(self,candidate,n,kind):
        return {'host':os.environ.get('ATLAS_CANDIDATE_HOST','candidate-db'),'port':5432,
                'dbname':n['database'],'user':n[kind],'password':self.password(candidate,n[kind]),
                'connect_timeout':5,'application_name':'atlas-build:'+str(candidate)}

    def remove_write_functions(self,conn,n):
        routines=conn.execute("""SELECT ns.nspname,p.proname,pg_get_function_identity_arguments(p.oid)
             FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
             WHERE p.prosecdef OR (ns.nspname='pg_catalog' AND
               (p.proname LIKE 'lo\\_%' ESCAPE '\\' OR p.proname IN ('lo_creat','lowrite','loread')))""").fetchall()
        for namespace,name,args in routines:
            conn.execute(sql.SQL('REVOKE EXECUTE ON FUNCTION {}.{}({}) FROM PUBLIC,{},{}').format(
               sql.Identifier(namespace),sql.Identifier(name),sql.SQL(args),sql.Identifier(n['reader']),sql.Identifier(n['loader'])))

    def check_roles(self,conn,n,doc,*,allow_missing=False):
        if not doc.get('role_oids') or set(doc['role_oids'])!={'owner','loader','reader'}:
            raise ValidationError('Incomplete role ownership journal is quarantined.')
        for kind,oid in doc['role_oids'].items():
            row=conn.execute("SELECT oid,shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=%s",[n[kind]]).fetchone()
            if not row:
                if allow_missing:continue
                raise ValidationError('A registered candidate role is missing.')
            if row[0]!=oid or not row[1] or json.loads(row[1])!=doc['marker']:
                raise ValidationError('Candidate role OID or ownership marker changed.')

    def owned(self,conn,c,n,marker):
        cluster=self.info()['cluster'];doc=self.journal(conn,c.pk);observed=self.observe(conn,n,cluster)
        if not observed:raise ValidationError('Registered candidate database is missing.')
        expected={'database':n['database'],'cluster':c.identity.get('cluster',cluster),'marker':marker}
        assert_owned(observed,doc,expected)
        self.check_roles(conn,n,doc)
        if c.identity and (c.identity.get('database_oid')!=observed['database_oid'] or c.identity.get('owner_oid')!=observed['owner_oid']):
            raise ValidationError('Registered database identity changed.')
        return observed,doc

    def terminate_loader(self,conn,n,database_oid):
        role=conn.execute('SELECT oid FROM pg_roles WHERE rolname=%s',[n['loader']]).fetchone()[0]
        sessions=conn.execute('SELECT pid,backend_start FROM pg_stat_activity WHERE datid=%s AND usesysid=%s',[database_oid,role]).fetchall()
        for pid,start in sessions:
            conn.execute('SELECT pg_terminate_backend(pid,2000) FROM pg_stat_activity WHERE pid=%s AND backend_start=%s AND datid=%s AND usesysid=%s',
                          [pid,start,database_oid,role])
        return len(sessions)

    def freeze(self,candidate_id,execution_id,token):
        with self.operation(candidate_id,execution_id,token,'freeze') as (c,e,n,marker,intent,conn):
            observed,doc=self.owned(conn,c,n,marker)
            conn.execute(sql.SQL('ALTER ROLE {} NOLOGIN').format(sql.Identifier(n['loader'])))
            conn.execute(sql.SQL('REVOKE CONNECT ON DATABASE {} FROM {}').format(sql.Identifier(n['database']),sql.Identifier(n['loader'])))
            terminated=self.terminate_loader(conn,n,observed['database_oid'])
            self.authorize(candidate_id,execution_id,token,'freeze')
            with self.connect(n['database']) as data:
                with data.transaction():
                    data.execute(sql.SQL('REASSIGN OWNED BY {} TO {}').format(sql.Identifier(n['loader']),sql.Identifier(n['owner'])))
                    data.execute(sql.SQL('REVOKE ALL ON ALL TABLES IN SCHEMA raw,spatial,atlas_meta FROM {}').format(sql.Identifier(n['loader'])))
                    data.execute(sql.SQL('REVOKE ALL ON SCHEMA raw,spatial,atlas_meta FROM {}').format(sql.Identifier(n['loader'])))
                    if not data.execute("SELECT 1 FROM pg_constraint WHERE conname='occurrence_canonical_fk'").fetchone():
                        data.execute('ALTER TABLE raw.object_record ADD CONSTRAINT occurrence_canonical_fk FOREIGN KEY(kind,osm_id) REFERENCES raw.osm_object')
                    data.execute("UPDATE atlas_meta.identity SET state='FROZEN' WHERE singleton AND marker=%s::jsonb",[json.dumps(marker)])
                left=conn.execute('SELECT count(*) FROM pg_stat_activity WHERE datid=%s AND usesysid=(SELECT oid FROM pg_roles WHERE rolname=%s)',[observed['database_oid'],n['loader']]).fetchone()[0]
                if left:raise ValidationError('Loader connections remain after bounded termination.')
            doc={**doc,'state':'frozen'};self.save_journal(conn,c.pk,doc)
            self.fault('after_freeze')
        return {'identity':observed,'terminated_loader_connections':terminated}

    def inspect(self,candidate_id,execution_id,token):
        c,e,n,marker=self.authorize(candidate_id,execution_id,token,'inspect')
        with self.connect() as conn:observed,doc=self.owned(conn,c,n,marker)
        with self.connect(n['database']) as data:
            identity=data.execute('SELECT marker,state FROM atlas_meta.identity WHERE singleton').fetchone()
            if not identity or identity[0]!=marker or identity[1]!='FROZEN':raise ValidationError('Candidate database is not frozen.')
            roles=data.execute('SELECT rolname,oid,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=ANY(%s)',[list(n.values())[1:]]).fetchall()
            owner_oid=observed['owner_oid']
            if any(r[2] or r[3] or r[4] or r[6] for r in roles):raise ValidationError('Candidate role acquired administrative privileges.')
            by_name={r[0]:r for r in roles}
            if by_name[n['owner']][5] or by_name[n['loader']][5] or not by_name[n['reader']][5]:raise ValidationError('Candidate login freeze differs.')
            if data.execute('SELECT count(*) FROM pg_auth_members WHERE member=ANY(%s)',[[r[1] for r in roles]]).fetchone()[0]:
                raise ValidationError('Candidate role membership is forbidden.')
            native=data.execute('SELECT postgis_full_version()').fetchone()[0]
        self.authorize(candidate_id,execution_id,token,'inspect')
        return {'identity':observed,'roles':roles,'native':native,'state':'FROZEN'}

    def reader_access(self,candidate_id,execution_id,token):
        c,e,n,marker=self.authorize(candidate_id,execution_id,token,'reader_access')
        with self.connect() as conn:self.owned(conn,c,n,marker)
        return self.credentials(c.pk,n,'reader')

    def drop(self,candidate_id,execution_id,token):
        with self.operation(candidate_id,execution_id,token,'drop') as (c,e,n,marker,intent,conn):
            if not intent.intended.get('explicit') and (not e.finished_at or (timezone.now()-e.finished_at).total_seconds()<86400):
                raise ValidationError('Failed database cleanup grace has not elapsed.')
            cluster=self.info()['cluster'];doc=self.journal(conn,c.pk)
            expected={'database':n['database'],'cluster':cluster,'marker':marker}
            if not doc and not c.identity:
                observed=self.observe(conn,n,cluster)
                roles=conn.execute('SELECT count(*) FROM pg_roles WHERE rolname=ANY(%s)',[[n[k] for k in ['owner','loader','reader']]]).fetchone()[0]
                if not observed and not roles:return {'dropped':True,'identity':None,'no_external_creation_observed':True}
            if (not doc or any(doc.get(k)!=v for k,v in expected.items())):
                raise ValidationError('Cleanup requires the exact external ownership journal.')
            observed=self.observe(conn,n,cluster)
            self.check_roles(conn,n,doc,allow_missing=doc['state'] in ['drop_requested','dropped'])
            if observed:
                assert_owned(observed,doc,expected)
                for kind in ['loader','reader']:
                    conn.execute(sql.SQL('ALTER ROLE {} NOLOGIN').format(sql.Identifier(n[kind])))
                self.terminate_loader(conn,n,observed['database_oid'])
                sessions=conn.execute('SELECT count(*) FROM pg_stat_activity WHERE datid=%s',[observed['database_oid']]).fetchone()[0]
                if sessions:raise ValidationError('Owned database is not quiescent for cleanup.')
                doc={**doc,'state':'drop_requested','drop_identity':observed}
                self.save_journal(conn,c.pk,doc)
                self.authorize(candidate_id,execution_id,token,'drop')
                self.fault('before_drop_database')
                conn.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(n['database'])))
                self.fault('after_drop_database')
                self.authorize(candidate_id,execution_id,token,'drop')
            elif doc['state'] not in ['roles_created','create_requested','drop_requested','dropped']:
                raise ValidationError('Unexplained missing database is quarantined.')
            elif doc['state'] not in ['drop_requested','dropped']:
                doc={**doc,'state':'drop_requested'};self.save_journal(conn,c.pk,doc)
            for kind in ['loader','reader','owner']:
                self.check_roles(conn,n,doc,allow_missing=True)
                if conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',[n[kind]]).fetchone():
                    conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(n[kind])))
                    self.fault('after_drop_role_'+kind)
            self.save_journal(conn,c.pk,{**doc,'state':'dropped'})
        return {'dropped':True,'identity':observed or doc.get('drop_identity')}

    def metrics(self,candidate_id,execution_id,token):
        c,e,n,marker=self.authorize(candidate_id,execution_id,token,'metrics')
        with self.connect() as conn:
            cluster=self.info()['cluster'];doc=self.journal(conn,c.pk);observed=self.observe(conn,n,cluster)
            assert_registered_target(c.identity,observed,cluster,n['database'])
            if observed:assert_owned(observed,doc,{'database':n['database'],'cluster':cluster,'marker':marker})
            wal=conn.execute('SELECT coalesce(sum(size),0) FROM pg_ls_waldir()').fetchone()[0]
            temp=conn.execute('SELECT coalesce(sum(size),0) FROM pg_ls_tmpdir()').fetchone()[0]
            lsn=conn.execute('SELECT pg_current_wal_insert_lsn()::text').fetchone()[0]
            allow=conn.execute('SELECT datallowconn FROM pg_database WHERE datname=%s',[n['database']]).fetchone()
        heap=indexes=database_bytes=0
        if allow and allow[0]:
            with self.connect(n['database']) as data:
                database_bytes=data.execute('SELECT pg_database_size(current_database())').fetchone()[0]
                heap,indexes=data.execute("""SELECT coalesce(sum(pg_table_size(c.oid)),0),coalesce(sum(pg_indexes_size(c.oid)),0)
                    FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
                    WHERE ns.nspname IN ('raw','spatial','atlas_meta') AND c.relkind IN ('r','m')""").fetchone()
        from .capacity import allocated_bytes
        root=Path(os.environ.get('ATLAS_CANDIDATE_DATA','/candidate-data'))
        result={'heap_toast':int(heap),'indexes':int(indexes),'wal':int(wal),'temp':int(temp),
                'database_bytes':int(database_bytes),'root_used':allocated_bytes([root]),'cluster':cluster,'lsn':lsn,'filesystem':str(root.stat().st_dev)}
        self.authorize(candidate_id,execution_id,token,'metrics')
        return result

    def cancel(self,candidate_id,execution_id,token):
        with self.operation(candidate_id,execution_id,token,'cancel') as (c,e,n,marker,intent,conn):
            doc=self.journal(conn,c.pk);cluster=self.info()['cluster'];observed=self.observe(conn,n,cluster)
            if not doc:return {'revoked':True,'database_created':False}
            if doc.get('marker')!=marker or doc.get('cluster')!=cluster or doc.get('database')!=n['database']:
                raise ValidationError('Cancellation ownership is unknown.')
            self.check_roles(conn,n,doc,allow_missing=doc['state']=='dropped')
            if observed:assert_owned(observed,doc,{'database':n['database'],'cluster':cluster,'marker':marker})
            terminated=0
            for kind in ['loader','reader']:
                if not conn.execute('SELECT 1 FROM pg_roles WHERE oid=%s AND rolname=%s',[doc['role_oids'][kind],n[kind]]).fetchone():continue
                conn.execute(sql.SQL('ALTER ROLE {} NOLOGIN').format(sql.Identifier(n[kind])))
                if observed:
                    conn.execute(sql.SQL('REVOKE CONNECT ON DATABASE {} FROM {}').format(sql.Identifier(n['database']),sql.Identifier(n[kind])))
                    sessions=conn.execute('SELECT pid,backend_start FROM pg_stat_activity WHERE datid=%s AND usesysid=%s',
                                          [observed['database_oid'],doc['role_oids'][kind]]).fetchall()
                    for pid,start in sessions:
                        conn.execute('SELECT pg_terminate_backend(pid,2000) FROM pg_stat_activity WHERE pid=%s AND backend_start=%s AND datid=%s AND usesysid=%s',
                            [pid,start,observed['database_oid'],doc['role_oids'][kind]])
                    terminated+=len(sessions)
            self.save_journal(conn,c.pk,{**doc,'cancelled':True})
        return {'revoked':True,'terminated_connections':terminated,'database_created':bool(observed)}

    def cleanup_orphan(self,candidate_id,journal_sha256,actor,reason):
        """Explicit operator reconciliation of a proven never-FROZEN orphan.

        This is deliberately absent from the worker RPC. A missing control row
        does not authorize adoption: exact external ownership plus LOADING state
        and an operator-reviewed journal digest are required. Unknown/FROZEN
        databases and roles whose original OIDs are unavailable are preserved.
        """
        from atlas_verification.diagnostics import diagnostic_text
        fixture_guard();candidate_id=UUID(str(candidate_id))
        if not actor or len(actor)>150 or not reason or len(reason)>2000:
            raise ValidationError('Orphan cleanup needs an explicit bounded actor and reason.')
        if Candidate.objects.filter(pk=candidate_id).exists():raise ValidationError('Use the ordinary controlled candidate cleanup protocol.')
        with self.connect() as conn:
            key=int.from_bytes(hashlib.sha256(candidate_id.bytes).digest()[:8],byteorder='big',signed=True)
            if not conn.execute('SELECT pg_try_advisory_lock(%s)',[key]).fetchone()[0]:
                raise ValidationError('Candidate operation is still active.')
            try:
                doc=self.journal(conn,candidate_id)
                if not doc:raise ValidationError('Unknown external ownership remains quarantined.')
                actual=hashlib.sha256(json.dumps(doc,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                previous=doc.get('orphan_cleanup',{})
                if journal_sha256 not in [actual,previous.get('reviewed_journal_sha256')]:raise ValidationError('Reviewed external journal changed.')
                marker=doc['marker'];n=names(candidate_id,marker['generation']);cluster=self.info()['cluster']
                if (marker.get('candidate')!=str(candidate_id) or marker.get('scope')!='fixture'
                        or marker.get('schema')!=VERSIONS['schema'] or doc.get('database')!=n['database']
                        or doc.get('cluster')!=cluster or doc.get('state') not in ['configured','orphan_drop_requested','orphan_dropped']):
                    raise ValidationError('Orphan is outside the proven never-READY recovery phases.')
                observed=self.observe(conn,n,cluster)
                if doc['state']=='orphan_dropped':
                    if observed:raise ValidationError('An already-dropped orphan name reappeared; quarantine it.')
                    return {'dropped':True,'identity':doc.get('drop_identity'),'residual_roles':doc.get('residual_roles',[])}
                known={'owner':doc['owner_oid'],**doc.get('role_oids',{})}
                for kind,oid in known.items():
                    role=conn.execute("SELECT oid,shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=%s",[n[kind]]).fetchone()
                    if not role:
                        if doc['state']=='orphan_drop_requested' and not observed:continue
                        raise ValidationError('Known orphan role is missing; quarantine ownership.')
                    if role[0]!=oid or not role[1] or json.loads(role[1])!=marker:raise ValidationError('Orphan role identity changed.')
                if observed:
                    assert_owned(observed,doc,{'database':n['database'],'cluster':cluster,'marker':marker})
                    with self.connect(n['database']) as data:
                        row=data.execute('SELECT marker,state FROM atlas_meta.identity WHERE singleton').fetchone()
                        if not row or row[0]!=marker or row[1]!='LOADING':raise ValidationError('FROZEN/unknown orphan may have been READY and is never deleted.')
                    doc={**doc,'state':'orphan_drop_requested','drop_identity':observed,'orphan_cleanup':{
                       'reviewed_journal_sha256':journal_sha256,'actor':diagnostic_text(actor),'reason':diagnostic_text(reason),
                       'requested_at':timezone.now().isoformat(),'proof':'exact cluster/name/database/owner OIDs and marker; database state LOADING; no control candidate'}}
                    self.save_journal(conn,candidate_id,doc)
                    conn.execute(sql.SQL('ALTER DATABASE {} ALLOW_CONNECTIONS false').format(sql.Identifier(n['database'])))
                    if conn.execute('SELECT count(*) FROM pg_stat_activity WHERE datid=%s',[observed['database_oid']]).fetchone()[0]:
                        raise ValidationError('Owned orphan must be quiescent before deletion.')
                    self.fault('before_orphan_drop')
                    conn.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(n['database'])))
                    self.fault('after_orphan_drop')
                elif doc['state']!='orphan_drop_requested':raise ValidationError('Unexplained missing orphan remains quarantined.')
                residual=[]
                for kind in ['loader','reader','owner']:
                    role=conn.execute("SELECT oid,shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=%s",[n[kind]]).fetchone()
                    if not role:continue
                    if kind not in known:
                        residual.append({'name':n[kind],'observed_oid':role[0],'reason':'original role OID was not recorded; left quarantined'})
                        continue
                    if role[0]!=known[kind] or not role[1] or json.loads(role[1])!=marker:raise ValidationError('Orphan role changed after database deletion.')
                    try:conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(n[kind])))
                    except psycopg.errors.DependentObjectsStillExist:
                        residual.append({'name':n[kind],'observed_oid':role[0],'reason':'unexpected role dependencies; left quarantined'})
                self.save_journal(conn,candidate_id,{**doc,'state':'orphan_dropped','residual_roles':residual,'cleaned_at':timezone.now().isoformat()})
                return {'dropped':True,'identity':observed or doc.get('drop_identity'),'residual_roles':residual}
            finally:conn.execute('SELECT pg_advisory_unlock(%s)',[key])
