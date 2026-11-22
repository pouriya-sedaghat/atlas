"""Real PostGIS COPY and independent SQL projection, with unchanged raw payloads."""
import copy
import hashlib
import os
from pathlib import Path
from unittest import skipUnless
from django.test import TransactionTestCase,override_settings
from django.core.exceptions import ValidationError
from tests import test_build_provision as provision_tests
from tests.test_verification_decoder import block,pbf

@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated real PostGIS provisioner process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildRawTests(TransactionTestCase):
    prepare_intent=provision_tests.RealProvisionTests.prepare_intent
    setUp=provision_tests.RealProvisionTests.setUp
    setUpFixture=provision_tests.RealProvisionTests.setUpFixture
    prepare_profile=provision_tests.RealProvisionTests.prepare_profile
    seal_fixture=provision_tests.RealProvisionTests.seal_fixture
    publish_fixture=provision_tests.RealProvisionTests.publish_fixture
    published=provision_tests.RealProvisionTests.published
    record=provision_tests.RealProvisionTests.record
    call=provision_tests.RealProvisionTests.call
    created=provision_tests.RealProvisionTests.created
    cleanup_owned=provision_tests.RealProvisionTests.cleanup_owned

    def source(self):
        b=block();b.granularity=7;b.lat_offset=-51;b.lon_offset=83;b.date_granularity=13
        del b.stringtable.s[:]
        b.stringtable.s.extend([b'',b'name',b'v\x00\xc3\xa9',b'k\x00',b'',b'u\x00'])
        n=b.primitivegroup.add().nodes.add(id=9223372036854775807,lat=123,lon=-456,keys=[1,1,3],vals=[2,4,2])
        n.info.version=1;n.info.timestamp=9223372036854775806;n.info.uid=0;n.info.changeset=0;n.info.user_sid=5
        return pbf(b)

    def graph(self):
        from atlas_build.inputs import spool_inputs
        return spool_inputs(self.intent.receipt.verification_id,self.output.parent/'build-spool')

    def imported(self,graph=None,**kwargs):
        from atlas_build.importer import import_graph
        result=self.created();graph=graph or self.graph()
        report=import_graph(result['loader'],graph,**kwargs)
        self.record('freeze');self.call('freeze')
        self.candidate.status='FROZEN';self.candidate.save()
        return result,graph,report

    def test_real_lossless_copy_and_independent_reader_reconstruction(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported()
        checked=reconcile(result['reader'],graph,identity=result['identity'])
        self.assertEqual(checked['counts'],{'node':1,'way':0,'relation':0})
        self.assertEqual(checked['source_objects'],1)
        self.assertEqual(checked['spatial']['points'],1)
        self.assertTrue(checked['logical_fingerprint'])
        import psycopg
        with psycopg.connect(**result['reader']) as conn:
            row=conn.execute('SELECT timestamp_ms,user_utf8 FROM raw.info').fetchone()
            self.assertEqual(int(row[0]),9223372036854775806*13);self.assertEqual(bytes(row[1]),b'u\0')
            self.assertEqual([bytes(x[0]) for x in conn.execute('SELECT key_utf8 FROM raw.tag ORDER BY position')],[b'name',b'name',b'k\0'])

    def test_projection_tampering_blocks_even_when_original_line_is_unchanged(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported()
        with self.admin.connect(result['identity']['database']) as conn:
            before=bytes(conn.execute('SELECT record_line FROM raw.object_record').fetchone()[0])
            conn.execute("UPDATE raw.tag SET value_utf8='changed'::bytea WHERE position=1")
            self.assertEqual(bytes(conn.execute('SELECT record_line FROM raw.object_record').fetchone()[0]),before)
        with self.assertRaises(ValidationError):reconcile(result['reader'],graph,identity=result['identity'])

    def test_same_digest_is_never_sufficient_for_conflicting_overlap(self):
        from atlas_build.importer import import_graph
        from atlas_verification.records import RecordWriter
        from atlas_build.stream import iter_ir,DecodeBudget
        graph=self.graph();region=copy.deepcopy(next(r for r in graph['regions'] if r['role']=='pbf'))
        region['region_id']='synthetic-other';graph['regions'].append(region)
        desc=next(d for d in region['outputs'] if d['path']=='objects.jsonl.zst')
        original=next(iter_ir(graph['spool'][desc['registered_path']],desc,DecodeBudget(1024**3)))[0]
        original['tags'].append(['conflict','different'])
        path=Path(next(iter(graph['spool'].values()))).parent/hashlib.sha256(b'test/conflict').hexdigest();writer=RecordWriter(path);writer.write(original);writer.close()
        replacement={**writer.descriptor(),'path':desc['path'],'registered_path':'test/conflict'}
        region['outputs'][region['outputs'].index(desc)]=replacement;graph['spool']['test/conflict']=str(path)
        graph['registry'].append({'path':'test/conflict','size':replacement['size'],'sha256':replacement['sha256']})
        result=self.created()
        with self.assertRaisesRegex(ValidationError,'Conflicting complete overlap'):import_graph(result['loader'],graph,digest=lambda record:b'x'*32)

    def test_changed_private_region_manifest_is_rejected_before_any_copy(self):
        from atlas_build.importer import import_graph
        graph=self.graph();path=Path(graph['spool'][graph['regions'][0]['manifest_path']]);path.write_bytes(path.read_bytes()+b'changed')
        result=self.created()
        with self.assertRaises(ValidationError):import_graph(result['loader'],graph)
        with self.admin.connect(result['identity']['database']) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM raw.source').fetchone()[0],0)

    def test_changed_private_batch_manifest_is_rejected_even_though_not_object_ir(self):
        from atlas_build.importer import import_graph
        graph=self.graph();path=Path(graph['spool'][graph['handoff']['manifest_path']]);path.write_bytes(path.read_bytes()+b'changed')
        result=self.created()
        with self.assertRaises(ValidationError):import_graph(result['loader'],graph)
        with self.admin.connect(result['identity']['database']) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM raw.source').fetchone()[0],0)

    def test_unexpected_frozen_schema_objects_are_rejected(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported()
        with self.admin.connect(result['identity']['database']) as conn:conn.execute('CREATE TABLE raw.unexpected(x integer)')
        with self.assertRaises(ValidationError):reconcile(result['reader'],graph,identity=result['identity'])

    def test_reader_write_grant_on_any_other_table_is_rejected(self):
        from atlas_build.validate import reconcile
        from psycopg import sql
        result,graph,report=self.imported()
        with self.admin.connect(result['identity']['database']) as conn:
            conn.execute(sql.SQL('GRANT INSERT ON raw.tag TO {}').format(sql.Identifier(result['identity']['names']['reader'])))
        with self.assertRaises(ValidationError):reconcile(result['reader'],graph,identity=result['identity'])

    def test_unregistered_poly_and_boundary_rows_are_rejected(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported()
        # A source with an approved POLY exception has no sidecar. Model that
        # graph locally while retaining the database's now-unregistered rows.
        for region in graph['regions']:
            region['outputs']=[d for d in region['outputs'] if d['path']!='poly-source.json']
        with self.assertRaisesRegex(ValidationError,'POLY|boundary'):
            reconcile(result['reader'],graph,identity=result['identity'])


@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated real PostGIS provisioner process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildMultiSourceTests(TransactionTestCase):
    setUp=BuildRawTests.setUp
    setUpFixture=BuildRawTests.setUpFixture
    record=BuildRawTests.record
    call=BuildRawTests.call
    created=BuildRawTests.created
    cleanup_owned=BuildRawTests.cleanup_owned
    graph=BuildRawTests.graph
    imported=BuildRawTests.imported
    fixture_kind='lossless'
    def prepare_intent(self):
        from atlas_build.fixtures import register_fixture,COVERAGE
        from atlas_build.control import activate_fixture_profile,dispatch_receipts
        from atlas_verification.worker import VerificationWorker
        from atlas_build.models import BuildIntent
        self.setUpFixture();self.profile=activate_fixture_profile(COVERAGE,'fixture-operator',bootstrap=True)
        attempt=register_fixture(self.fixture_kind,'fixture-operator',profile_id=self.profile.pk)
        self.assertTrue(VerificationWorker().tick());attempt.refresh_from_db()
        self.assertTrue(attempt.successful,(attempt.status,attempt.error,attempt.summary.get('blocking')))
        dispatch_receipts();return BuildIntent.objects.get()

    def test_boundary_only_source_cannot_acquire_unregistered_blocks(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported()
        with self.admin.connect(result['identity']['database']) as conn:
            conn.execute("""INSERT INTO raw.block SELECT s.source_id,b.block_no,b.encoding,b.raw_size,b.granularity,
                b.date_granularity,b.lat_offset,b.lon_offset,b.missing_fields,b.index_data,b.record_line,b.record_sha256
                FROM raw.source s CROSS JOIN LATERAL (SELECT * FROM raw.block LIMIT 1) b
                WHERE s.coverage_role='boundary_only'""")
        with self.assertRaisesRegex(ValidationError,'block'):
            reconcile(result['reader'],graph,identity=result['identity'])
    def test_encoding_only_overlap_keeps_all_occurrences_and_deduplicates_exact_values(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported();checked=reconcile(result['reader'],graph,identity=result['identity'])
        self.assertEqual(checked['counts'],{'node':3,'way':1,'relation':1})
        self.assertEqual(checked['source_objects'],10);self.assertEqual(checked['duplicates'],5)
        self.assertEqual(checked['missing_relation_members'],2)
        self.assertEqual(checked['spatial']['points'],3);self.assertEqual(checked['spatial']['boundaries'],3)
        self.assertEqual(report['warnings'][0]['code'],'mixed_source_vintages')


@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated real PostGIS provisioner process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildRelationOnlyTests(TransactionTestCase):
    setUp=BuildMultiSourceTests.setUp
    prepare_intent=BuildMultiSourceTests.prepare_intent
    setUpFixture=BuildMultiSourceTests.setUpFixture
    record=BuildMultiSourceTests.record
    call=BuildMultiSourceTests.call
    created=BuildMultiSourceTests.created
    cleanup_owned=BuildMultiSourceTests.cleanup_owned
    graph=BuildMultiSourceTests.graph
    imported=BuildMultiSourceTests.imported
    fixture_kind='relation-only'
    def test_real_relation_only_has_zero_points_and_no_node_extent(self):
        from atlas_build.validate import reconcile
        result,graph,report=self.imported();checked=reconcile(result['reader'],graph,identity=result['identity'])
        self.assertEqual(checked['counts'],{'node':0,'way':0,'relation':1})
        self.assertEqual(checked['source_objects'],2);self.assertEqual(checked['duplicates'],1)
        self.assertEqual(checked['spatial']['points'],0);self.assertIsNone(checked['spatial']['extent'])

@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated real PostGIS provisioner process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildLargeChildrenTests(TransactionTestCase):
    setUp=BuildMultiSourceTests.setUp
    prepare_intent=BuildMultiSourceTests.prepare_intent
    setUpFixture=BuildMultiSourceTests.setUpFixture
    record=BuildMultiSourceTests.record
    call=BuildMultiSourceTests.call
    created=BuildMultiSourceTests.created
    cleanup_owned=BuildMultiSourceTests.cleanup_owned
    graph=BuildMultiSourceTests.graph
    imported=BuildMultiSourceTests.imported
    fixture_kind='large-children'
    def test_large_ordered_duplicate_references_survive_multiple_committed_copy_chunks(self):
        from atlas_build.validate import reconcile
        import psycopg
        result,graph,report=self.imported();checked=reconcile(result['reader'],graph,identity=result['identity'])
        self.assertEqual(checked['counts'],{'node':3,'way':1,'relation':1});self.assertEqual(checked['duplicates'],5)
        with psycopg.connect(**result['reader']) as conn:
            self.assertEqual(conn.execute('SELECT count(*),min(position),max(position),count(DISTINCT node_id) FROM raw.way_ref').fetchone(),(60000,1,30000,1))
            self.assertEqual(conn.execute('SELECT bool_and(NOT locations_present) FROM raw.way_state').fetchone(),(True,))

@skipUnless(os.environ.get('ATLAS_PROVISIONER_TESTS')=='1','requires isolated real PostGIS provisioner process')
@override_settings(ATLAS_BUILD_FIXTURE_MODE=True)
class BuildBoundaryPolicyTests(TransactionTestCase):
    setUp=BuildMultiSourceTests.setUp
    prepare_intent=BuildMultiSourceTests.prepare_intent
    setUpFixture=BuildMultiSourceTests.setUpFixture
    record=BuildMultiSourceTests.record
    call=BuildMultiSourceTests.call
    created=BuildMultiSourceTests.created
    cleanup_owned=BuildMultiSourceTests.cleanup_owned
    graph=BuildMultiSourceTests.graph
    imported=BuildMultiSourceTests.imported
    fixture_kind='boundary-policy'
    def test_postgis_preserves_verified_multipart_hole_split_and_antarctica_plane(self):
        from atlas_build.validate import reconcile
        import psycopg
        result,graph,report=self.imported();checked=reconcile(result['reader'],graph,identity=result['identity'])
        self.assertEqual(checked['spatial']['boundaries'],3)
        with psycopg.connect(**result['reader']) as conn:
            values=dict(conn.execute('SELECT s.region_id,ST_Area(b.geom) FROM spatial.boundary b JOIN raw.source s USING(source_id)'))
            self.assertEqual(values,{'fixture-a':25.0,'fixture-b':30.0,'fixture-boundary':10800.0})
            self.assertFalse(conn.execute("SELECT ST_Covers(b.geom,ST_SetSRID(ST_MakePoint(0,-9),4326)) FROM spatial.boundary b JOIN raw.source s USING(source_id) WHERE s.region_id='fixture-b'").fetchone()[0])
