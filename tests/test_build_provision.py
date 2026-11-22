from uuid import uuid4
from unittest import TestCase
from django.core.exceptions import ValidationError

class ProvisionIdentityTests(TestCase):
    def test_names_bind_full_uuid_generation_and_are_safe_never_reused(self):
        from atlas_build.provision import names
        candidate=uuid4();one=names(candidate,1);two=names(candidate,2)
        self.assertNotEqual(one,two)
        for value in one.values():
            self.assertIn(candidate.hex,value);self.assertLessEqual(len(value),63)
        with self.assertRaises(ValidationError):names(candidate,0)

    def test_owner_oid_cluster_and_journal_are_required_even_before_marker(self):
        from atlas_build.provision import assert_owned
        expected={'database':'atc_owned','cluster':'123','marker':{'candidate':'id','generation':1}}
        journal={'database':'atc_owned','cluster':'123','owner_oid':42,'marker':expected['marker'],'state':'create_requested'}
        observed={'database':'atc_owned','cluster':'123','owner_oid':42,'marker':None,'database_oid':99}
        self.assertTrue(assert_owned(observed,journal,expected))
        for mutation in [{'owner_oid':43},{'cluster':'124'},{'marker':{'candidate':'other','generation':1}}]:
            with self.assertRaises(ValidationError):assert_owned({**observed,**mutation},journal,expected)
        with self.assertRaises(ValidationError):assert_owned(observed,None,expected)

    def test_registered_target_cannot_be_recreated_or_silently_move_clusters(self):
        from atlas_build.provision import assert_registered_target
        identity={'database':'atc_owned','cluster':'123','database_oid':99,'owner_oid':42}
        observed=dict(identity)
        self.assertTrue(assert_registered_target(identity,observed,'123','atc_owned'))
        self.assertTrue(assert_registered_target({},None,'123','atc_new'))
        for target,cluster in [(None,'123'),(observed,'124'),({**observed,'database_oid':100},'123'),({**observed,'owner_oid':43},'123')]:
            with self.assertRaises(ValidationError):assert_registered_target(identity,target,cluster,'atc_owned')

    def test_rpc_authentication_secret_is_not_a_cross_generation_credential_key(self):
        from atlas_build.provision import Provisioner
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from unittest.mock import patch
        with TemporaryDirectory() as directory:
            root=Path(directory);private=root/'private';shared=root/'shared'
            private.write_bytes(b'provisioner-only-test-key');shared.write_bytes(b'worker-rpc-test-key')
            with patch.dict('os.environ',{'ATLAS_CANDIDATE_CREDENTIAL_KEY_FILE':str(private),'ATLAS_PROVISIONER_SECRET_FILE':str(shared)}):
                provisioner=Provisioner();candidate=uuid4();one=provisioner.password(candidate,'loader_generation_one')
                shared.write_bytes(b'changed-rpc-authentication-key')
                self.assertTrue(one==provisioner.password(candidate,'loader_generation_one'),'RPC rotation must not change role credentials')
                self.assertTrue(one!=provisioner.password(candidate,'loader_generation_two'),'Role/generation must be part of credential derivation')

import os
from datetime import timedelta
from unittest import skipUnless
from django.test import TransactionTestCase,override_settings
from django.utils import timezone
from atlas_build.models import BuildIntent,BuildExecution,Candidate,DDLOperation
from atlas_build.control import dispatch_receipts
from atlas_build.provision import Provisioner,names
from tests import test_build_control as fixture_tests


@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated provisioner-owned real PostGIS test process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class RealProvisionTests(TransactionTestCase):
    setUpFixture=fixture_tests.BuildControlTests.setUp
    prepare_profile=fixture_tests.BuildControlTests.prepare_profile
    seal_fixture=fixture_tests.BuildControlTests.seal_fixture
    publish_fixture=fixture_tests.BuildControlTests.publish_fixture
    published=fixture_tests.BuildControlTests.published
    source=fixture_tests.BuildControlTests.source

    def prepare_intent(self):
        self.setUpFixture();self.published();dispatch_receipts()
        return BuildIntent.objects.get()

    def setUp(self):
        self.intent=self.prepare_intent();self.intent.generation=1;self.intent.status='running';self.intent.save()
        self.execution=BuildExecution.objects.create(intent=self.intent,generation=1,
            started_at=timezone.now(),lease_until=timezone.now()+timedelta(seconds=120))
        self.candidate=Candidate.objects.create(execution=self.execution)
        self.admin=Provisioner();self.admin.bootstrap()
        self.marker=self.admin.authorize(self.candidate.pk,self.execution.pk,self.execution.token,'create')[3]
        self.record('create');self.addCleanup(self.cleanup_owned)

    def record(self,operation):
        return DDLOperation.objects.get_or_create(candidate=self.candidate,operation=operation,
             defaults={'intended':{'marker':self.marker,'cluster':self.admin.info()['cluster'],'explicit':True,'actor':'test','reason':'owned disposable fixture target'}})[0]

    def call(self,operation):
        return getattr(self.admin,operation)(self.candidate.pk,self.execution.pk,self.execution.token)

    def created(self):
        result=self.call('create');self.candidate.identity=result['identity'];self.candidate.status='LOADING';self.candidate.save()
        return result

    def cleanup_owned(self):
        from psycopg import sql
        n=names(self.candidate.pk,self.execution.generation)
        with self.admin.connect() as conn:
            doc=self.admin.journal(conn,self.candidate.pk)
        if not doc:return
        if doc.get('state')=='orphan_dropped' and not Candidate.objects.filter(pk=self.candidate.pk).exists():return
        Candidate.objects.filter(pk=self.candidate.pk).update(status='FAILED')
        BuildExecution.objects.filter(pk=self.execution.pk).update(status='failed',finished_at=timezone.now())
        self.record('drop')
        self.admin.fault=lambda step:None
        self.call('drop')

    def test_real_create_and_freeze_revoke_stale_loader_and_transfer_ownership(self):
        import psycopg
        from psycopg import sql
        result=self.created();n=result['identity']['names']
        loader=psycopg.connect(**result['loader'],autocommit=True)
        self.addCleanup(loader.close)
        marker=loader.execute('SELECT marker FROM atlas_meta.identity').fetchone()[0]
        self.assertEqual(marker,self.marker)
        with self.admin.connect(n['database']) as conn:
            conn.execute('CREATE TABLE raw.injected_loader_owned(x integer)')
            conn.execute(sql.SQL('ALTER TABLE raw.injected_loader_owned OWNER TO {}').format(sql.Identifier(n['loader'])))
        self.record('freeze');frozen=self.call('freeze')
        self.assertEqual(frozen['terminated_loader_connections'],1)
        with self.assertRaises(psycopg.Error):loader.execute('SELECT 1')
        with self.assertRaises(psycopg.Error):psycopg.connect(**result['loader'])
        with self.admin.connect(n['database']) as conn:
            self.assertEqual(conn.execute("SELECT relowner FROM pg_class WHERE oid='raw.injected_loader_owned'::regclass").fetchone()[0],result['identity']['owner_oid'])
        self.candidate.status='FROZEN';self.candidate.save()
        inspected=self.call('inspect');self.assertEqual(inspected['state'],'FROZEN')
        with psycopg.connect(**result['reader'],autocommit=True) as reader:
            reader.execute('SET default_transaction_read_only=off')
            for statement in ['CREATE TABLE raw.denied(x integer)','CREATE TEMP TABLE denied(x integer)',
                              'UPDATE raw.source SET region_id=region_id WHERE false','SELECT lo_create(0)',
                              "SELECT lo_from_bytea(0,'abc'::bytea)"]:
                with self.subTest(statement=statement),self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    reader.execute(statement)

    def test_create_before_marker_is_owned_and_not_publicly_connectable(self):
        def crash(step):
            if step=='after_create_database':raise RuntimeError('approved fixture fault')
        self.admin.fault=crash
        with self.assertRaises(RuntimeError):self.call('create')
        n=names(self.candidate.pk,1)
        with self.admin.connect() as conn:
            before=conn.execute('SELECT oid,datallowconn FROM pg_database WHERE datname=%s',[n['database']]).fetchone()
            self.assertFalse(before[1],'public connection window exists before ACL/marker setup')
        self.admin.fault=lambda step:None
        result=self.created();self.assertEqual(result['identity']['database_oid'],before[0])

    def test_drop_before_metadata_update_reconciles_without_recreating(self):
        result=self.created();self.record('drop')
        Candidate.objects.filter(pk=self.candidate.pk).update(status='FAILED')
        BuildExecution.objects.filter(pk=self.execution.pk).update(status='failed',finished_at=timezone.now())
        def crash(step):
            if step=='after_drop_database':raise RuntimeError('approved fixture fault')
        self.admin.fault=crash
        with self.assertRaises(RuntimeError):self.call('drop')
        self.admin.fault=lambda step:None
        self.assertTrue(self.call('drop')['dropped'])

    def test_wrong_owner_oid_is_rejected_without_adoption(self):
        from psycopg import sql
        result=self.created();n=result['identity']['names'];wrong=n['owner']+'_wrong'
        with self.admin.connect() as conn:
            conn.execute(sql.SQL('CREATE ROLE {} NOLOGIN').format(sql.Identifier(wrong)))
            conn.execute(sql.SQL('ALTER DATABASE {} OWNER TO {}').format(sql.Identifier(n['database']),sql.Identifier(wrong)))
        try:
            with self.assertRaises(ValidationError):self.call('create')
        finally:
            # Test-only admin fault restoration, then the normal checked cleanup.
            with self.admin.connect() as conn:
                conn.execute(sql.SQL('ALTER DATABASE {} OWNER TO {}').format(sql.Identifier(n['database']),sql.Identifier(n['owner'])))
                conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(wrong)))

    def test_expired_or_cross_generation_token_cannot_provision(self):
        from uuid import uuid4
        with self.assertRaises(ValidationError):self.admin.create(self.candidate.pk,self.execution.pk,uuid4())
        BuildExecution.objects.filter(pk=self.execution.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        with self.assertRaises(ValidationError):self.call('create')

    def test_failed_cleanup_survives_profile_disable_and_uses_frozen_epoch(self):
        result=self.created();self.record('drop')
        Candidate.objects.filter(pk=self.candidate.pk).update(status='FAILED')
        BuildExecution.objects.filter(pk=self.execution.pk).update(status='failed',finished_at=timezone.now())
        from atlas_build.models import BuildProfile
        BuildProfile.objects.filter(pk=self.intent.profile_id).update(enabled=False,epoch=uuid4())
        self.assertTrue(self.call('drop')['dropped'])

    def test_journal_binds_all_role_oids_and_recreated_reader_is_quarantined(self):
        from psycopg import sql
        result=self.created();n=result['identity']['names']
        with self.admin.connect() as conn:
            doc=self.admin.journal(conn,self.candidate.pk)
            self.assertEqual(set(doc['role_oids']),{'owner','loader','reader'})
            self.assertEqual(doc['role_oids']['owner'],result['identity']['owner_oid'])
        self.assertEqual(self.marker['control_database'],'test_atlas_fixture')
        held=n['reader']+'_held'
        with self.admin.connect() as conn:
            conn.execute(sql.SQL('ALTER ROLE {} RENAME TO {}').format(sql.Identifier(n['reader']),sql.Identifier(held)))
            conn.execute(sql.SQL('CREATE ROLE {} NOLOGIN').format(sql.Identifier(n['reader'])))
            import json
            conn.execute(sql.SQL('COMMENT ON ROLE {} IS {}').format(sql.Identifier(n['reader']),sql.Literal(json.dumps(self.marker,sort_keys=True))))
        try:
            with self.assertRaises(ValidationError):self.call('create')
        finally:
            with self.admin.connect() as conn:
                conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(n['reader'])))
                conn.execute(sql.SQL('ALTER ROLE {} RENAME TO {}').format(sql.Identifier(held),sql.Identifier(n['reader'])))


    def test_resource_metrics_and_expired_generation_cancellation_are_target_owned(self):
        import psycopg
        result=self.created();loader=psycopg.connect(**result['loader'],autocommit=True)
        self.addCleanup(loader.close)
        metrics=self.call('metrics')
        self.assertGreater(metrics['root_used'],0);self.assertGreater(metrics['wal'],0)
        self.assertGreaterEqual(metrics['heap_toast'],0);self.assertGreaterEqual(metrics['indexes'],0)
        self.record('cancel')
        BuildExecution.objects.filter(pk=self.execution.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        BuildIntent.objects.filter(pk=self.intent.pk).update(generation=2)
        self.assertTrue(self.call('cancel')['revoked'])
        with self.assertRaises(psycopg.Error):loader.execute('SELECT 1')
        with self.assertRaises(psycopg.Error):psycopg.connect(**result['loader'])

    def test_explicit_orphan_cleanup_requires_hash_ownership_and_loading_never_ready_state(self):
        import hashlib,json
        result=self.created();n=result['identity']['names']
        with self.admin.connect() as conn:doc=self.admin.journal(conn,self.candidate.pk)
        expected=hashlib.sha256(json.dumps(doc,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        # A present control record cannot be bypassed through orphan recovery.
        with self.assertRaises(ValidationError):self.admin.cleanup_orphan(self.candidate.pk,expected,'test','owned disposable orphan')
        DDLOperation.objects.filter(candidate=self.candidate).delete();Candidate.objects.filter(pk=self.candidate.pk).delete()
        self.addCleanup(lambda:None)
        with self.assertRaises(ValidationError):self.admin.cleanup_orphan(self.candidate.pk,'0'*64,'test','wrong journal')
        removed=self.admin.cleanup_orphan(self.candidate.pk,expected,'test','owned disposable orphan after lost test control row')
        self.assertTrue(removed['dropped'])
        with self.admin.connect() as conn:
            self.assertIsNone(conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',[n['database']]).fetchone())

    def test_orphan_cleanup_never_drops_frozen_unknown_or_ready_database(self):
        import hashlib,json
        self.created();self.record('freeze');self.call('freeze')
        with self.admin.connect() as conn:doc=self.admin.journal(conn,self.candidate.pk)
        expected=hashlib.sha256(json.dumps(doc,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        DDLOperation.objects.filter(candidate=self.candidate).delete();Candidate.objects.filter(pk=self.candidate.pk).delete()
        try:
            with self.assertRaises(ValidationError):self.admin.cleanup_orphan(self.candidate.pk,expected,'test','must quarantine frozen unknown')
        finally:
            # Restore only the test control row, retaining the same identity;
            # the ordinary explicit checked cleanup then handles this known
            # never-READY fault target, without teaching orphan cleanup a bypass.
            self.candidate.status='FAILED';self.candidate.save(force_insert=True)

    def test_create_requires_recorded_cluster_before_any_external_creation(self):
        op=DDLOperation.objects.get(candidate=self.candidate,operation='create')
        op.intended={**op.intended,'cluster':'different-cluster'};op.save(update_fields=['intended'])
        with self.assertRaises(ValidationError):self.call('create')
        with self.admin.connect() as conn:
            self.assertIsNone(self.admin.journal(conn,self.candidate.pk))

    def test_lease_loss_after_roles_stops_before_create_database(self):
        def expire(step):
            if step=='after_roles':BuildExecution.objects.filter(pk=self.execution.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
        self.admin.fault=expire
        with self.assertRaises(ValidationError):self.call('create')
        with self.admin.connect() as conn:
            self.assertIsNone(conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',[names(self.candidate.pk,1)['database']]).fetchone())
