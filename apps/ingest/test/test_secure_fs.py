import hashlib,json,os,subprocess,sys,tempfile,unittest,uuid
from pathlib import Path

HELPER=Path(__file__).resolve().parents[1]/'src'/'secure_fs.py'


@unittest.skipUnless(sys.platform.startswith('linux'),'descriptor-relative filesystem contract requires Linux')
class SecureIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.parent=Path(self.temporary.name);self.root=self.parent/'state';self.invoke('init')
        self.source=self.parent/'fixture.osm.pbf';self.source.write_bytes(b'fictional bytes, not a map')

    def invoke(self,command,*args,data=None,fail=False):
        result=subprocess.run([sys.executable,'-I',str(HELPER),command,str(self.root),*map(str,args)],input=data,capture_output=True)
        if fail:
            self.assertNotEqual(result.returncode,0);return json.loads(result.stderr)
        self.assertEqual(result.returncode,0,result.stderr.decode());return json.loads(result.stdout)

    def submit(self):
        data={'maxBytes':100000,'minFreeBytes':0,'source':{'provider':'fixture','region':'fixture','url':'https://example.org/fixture.osm.pbf'}}
        return self.invoke('submit',self.source,data=json.dumps(data).encode())

    def test_durable_private_copy_and_consumption_retain_one_canonical_blob(self):
        manifest=self.submit();sid=manifest['id'];info=self.invoke('inspect',sid);token=uuid.uuid4().hex
        self.invoke('snapshot',sid,token,info['manifestSha256'],manifest['sha256'],manifest['bytes'],0)
        blob=self.root/'sources'/manifest['sha256']/'input.osm.pbf'
        self.assertEqual(blob.read_bytes(),self.source.read_bytes());self.assertEqual(blob.stat().st_mode&0o777,0o444)
        self.assertEqual(blob.stat().st_nlink,1)
        self.invoke('consume',sid,info['manifestSha256']);self.assertFalse((self.root/'incoming'/sid/'input.osm.pbf').exists())
        self.invoke('cleanup-attempt',sid,token);self.assertTrue(blob.exists())
        self.invoke('verify-blob',manifest['sha256'],manifest['bytes'])

    def test_mutated_delivery_cannot_poison_the_immutable_store(self):
        m=self.submit();info=self.invoke('inspect',m['id']);p=self.root/'incoming'/m['id']/'input.osm.pbf'
        p.chmod(0o600);p.write_bytes(b'x'*m['bytes'])
        result=self.invoke('snapshot',m['id'],uuid.uuid4().hex,info['manifestSha256'],m['sha256'],m['bytes'],0,fail=True)
        self.assertEqual(result['error'],'sha256_mismatch');self.assertFalse((self.root/'sources'/m['sha256']/'input.osm.pbf').exists())

    def test_symlink_fifo_and_hardlink_are_rejected_without_touching_targets(self):
        for kind in ('symlink','fifo','hardlink'):
            m=self.submit();p=self.root/'incoming'/m['id']/'input.osm.pbf';p.unlink()
            if kind=='symlink':p.symlink_to(self.source)
            elif kind=='fifo':os.mkfifo(p)
            else:os.link(self.source,p)
            self.invoke('inspect',m['id'],fail=True)
            if kind=='hardlink':p.unlink()
            self.assertEqual(self.source.read_bytes(),b'fictional bytes, not a map')

    def test_directory_escape_and_duplicate_manifest_keys_are_rejected(self):
        m=self.submit();delivery=self.root/'incoming'/m['id'];manifest=delivery/'source-manifest.json'
        manifest.chmod(0o600);manifest.write_text('{"id":"a","id":"b"}')
        self.assertEqual(self.invoke('inspect',m['id'],fail=True)['error'],'duplicate_json_key')
        sid=uuid.uuid4().hex;(self.root/'incoming'/sid).symlink_to(self.parent,target_is_directory=True)
        self.invoke('inspect',sid,fail=True)
        self.invoke('inspect','../outside',fail=True)

    def test_no_marker_no_admission_and_artifact_tampering_is_detected(self):
        m=self.submit();delivery=self.root/'incoming'/m['id'];(delivery/'READY').unlink()
        self.assertEqual(self.invoke('inspect',m['id']),{'status':'not_ready'})
        data=b'{"result":"fixture"}';digest=hashlib.sha256(data).hexdigest()
        self.invoke('put-artifact',digest,data=data)
        artifact=self.root/'artifacts'/(digest+'.json');artifact.chmod(0o600);artifact.write_bytes(b'{}')
        self.assertEqual(self.invoke('read-artifact',digest,fail=True)['error'],'artifact_corrupt')


if __name__=='__main__':unittest.main()
