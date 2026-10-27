"""Regression for finalizing images without Git installed inside the ops container.

Runs real host Git on temporary fixture checkouts and then the Node consumer with an empty PATH.
No Docker daemon, downloaded sources or network are needed.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RECORDER = ROOT / 'infra/prepare/record-checkouts.py'
CONSUMER = (ROOT / 'infra/prepare/verified-source-heads.mjs').as_uri()
GIT = shutil.which('git')
NODE = shutil.which('node')


@unittest.skipUnless(GIT and NODE, 'host Git and Node are required for this development test')
class SourceHeadRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='seyra-preparation-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.sources = self.folder / 'sources with spaces'
        self.checkout = self.sources / 'provider'
        self.checkout.mkdir(parents=True)
        subprocess.run([GIT, 'init', '-q', str(self.checkout)], check=True)
        subprocess.run([
            GIT, '-C', str(self.checkout), '-c', 'user.name=Seyra Test',
            '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
            'commit', '-q', '--allow-empty', '-m', 'fixture',
        ], check=True)
        self.head = subprocess.check_output([GIT, '-C', str(self.checkout), 'rev-parse', 'HEAD'], text=True).strip()
        self.config = self.folder / 'sources.json'
        self.config.write_text(json.dumps({'sources': {'provider': {'commit': self.head}}}), encoding='utf-8')
        self.record = self.folder / 'verification.json'

    def produce(self, env=None):
        return subprocess.run([sys.executable, str(RECORDER), str(self.config), str(self.sources), str(self.record)],
                              text=True, capture_output=True, env=env)

    def consume(self, sources=None):
        code = "const {loadVerifiedSourceHeads}=await import(process.argv[1]); process.stdout.write(JSON.stringify(loadVerifiedSourceHeads(process.argv[2],process.argv[3],process.argv[4])));"
        env = {**os.environ, 'PATH': ''}
        return subprocess.run([NODE, '--input-type=module', '-e', code, CONSUMER, str(self.record), str(self.config), str(sources or self.sources)],
                              text=True, capture_output=True, env=env)

    def test_actual_host_git_record_is_consumed_without_git_on_path(self):
        result = self.produce()
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(self.record.read_text(encoding='utf-8'))
        self.assertEqual(record['sources_config_sha256'], hashlib.sha256(self.config.read_bytes()).hexdigest())
        result = self.consume()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'provider': self.head})

    def test_different_checkout_is_rejected_before_record_is_written(self):
        self.config.write_text(json.dumps({'sources': {'provider': {'commit': 'f' * 40}}}), encoding='utf-8')
        result = self.produce()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expected', result.stderr)
        self.assertFalse(self.record.exists())

    def test_modified_pins_invalidate_an_existing_record(self):
        self.assertEqual(self.produce().returncode, 0)
        self.config.write_text(self.config.read_text(encoding='utf-8') + '\n', encoding='utf-8')
        result = self.consume()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not match sources.json', result.stderr)

    def test_record_for_another_directory_is_rejected(self):
        self.assertEqual(self.produce().returncode, 0)
        result = self.consume(self.folder / 'different-sources')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different source directory', result.stderr)

    def test_missing_or_wrong_recorded_head_is_rejected(self):
        self.assertEqual(self.produce().returncode, 0)
        for heads in [{}, {'provider': {'observed_commit': 'f' * 40}}]:
            with self.subTest(heads=heads):
                record = json.loads(self.record.read_text(encoding='utf-8'))
                record['checkouts'] = heads
                self.record.write_text(json.dumps(record), encoding='utf-8')
                result = self.consume()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('differs from the pinned commit', result.stderr)

    def test_missing_host_git_fails_without_writing_a_record(self):
        result = self.produce({**os.environ, 'PATH': ''})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checkout verification failed', result.stderr)
        self.assertFalse(self.record.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
