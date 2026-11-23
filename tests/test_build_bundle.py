"""Immutable file publication preserves intent/staging across partial failure."""
import hashlib,json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from django.core.exceptions import ValidationError

class BuildBundleTests(TestCase):
    def stage(self,root):
        from atlas_build.bundle import stage_bundle
        return stage_bundle(root,'build-work/intent/1/bundle','database/2026-11-21/candidate',
            {'schema_version':1,'scope':'fixture','candidate_id':'candidate','request_order':1,'identity':{'database':'owned'},'source_note':'u\0é'},
            {'schema_version':1,'scope':'fixture','logical_fingerprint':'a'*64,'privileges':{'write_probes_denied':6}})
    def test_index_excludes_itself_and_resume_does_not_overwrite_or_discard_staging(self):
        from atlas_build.bundle import publish_bundle,check_bundle
        with TemporaryDirectory() as directory:
            root=Path(directory);intent=self.stage(root)
            staged={x['path']:(root/x['stage']).read_bytes() for x in intent['files']}
            def fail(step):
                if step=='after_link':raise OSError('approved publication fault')
            with self.assertRaises(OSError):publish_bundle(root,intent,fault=fail)
            self.assertTrue(all((root/x['stage']).exists() for x in intent['files']))
            publish_bundle(root,intent);publish_bundle(root,intent)
            check_bundle(root,intent)
            index=json.loads((root/intent['target']/'postgis/index.json').read_bytes())
            self.assertNotIn('postgis/index.json',[x['path'] for x in index['files']])
            self.assertEqual({x['path']:(root/intent['target']/x['path']).read_bytes() for x in intent['files']},staged)
            build=json.loads((root/intent['target']/'postgis/build.json').read_bytes())
            self.assertEqual(build['source_note'],'u\0é')
    def test_conflict_and_symlink_fail_closed_preserving_both_original_and_stage(self):
        from atlas_build.bundle import publish_bundle
        for mode in ['conflict','symlink']:
            with self.subTest(mode=mode),TemporaryDirectory() as directory:
                root=Path(directory);intent=self.stage(root);target=root/intent['target'];target.mkdir(parents=True)
                path=target/'README.md'
                if mode=='conflict':path.write_bytes(b'original')
                else:path.symlink_to(root/intent['files'][0]['stage'])
                with self.assertRaises((OSError,ValidationError)):publish_bundle(root,intent)
                self.assertTrue((root/intent['files'][0]['stage']).exists())
                if mode=='conflict':self.assertEqual(path.read_bytes(),b'original')
