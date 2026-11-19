import hashlib
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from django.core.exceptions import ValidationError

from atlas_verification.storage import safe_open, spool


class SafeSpoolTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/"input").write_bytes(b"original")
        self.artifact = {"path":"input","length":8,"sha256":hashlib.sha256(b"original").hexdigest(),"region_id":"sample"}

    def test_source_path_replacement_after_open_copies_original_descriptor(self):
        replaced = False

        def progress(update):
            nonlocal replaced
            if not replaced:
                os.rename(self.root/"input", self.root/"old")
                (self.root/"input").write_bytes(b"replaced")
                replaced = True
        target = self.root/"spool"
        spool(self.root,self.artifact,target,progress)
        self.assertEqual(target.read_bytes(),b"original")

    def test_symlink_at_any_component_and_nonregular_file_are_rejected(self):
        (self.root/"link").symlink_to(self.root, target_is_directory=True)
        (self.root/"filelink").symlink_to(self.root/"input")
        os.mkfifo(self.root/"fifo")
        for path in ("link/input","filelink","fifo","../input","/input"):
            with self.subTest(path=path), self.assertRaises((OSError,ValidationError)):
                with safe_open(self.root,path) as source:
                    source.read()

    def test_fingerprint_mismatch_does_not_become_a_verified_spool(self):
        self.artifact["sha256"]="f"*64
        with self.assertRaises(ValidationError):
            spool(self.root,self.artifact,self.root/"spool",lambda update:None)

    def test_missing_source_is_integrity_failure_and_private_write_failure_is_operational(self):
        import errno
        from unittest.mock import patch
        with TemporaryDirectory() as temporary:
            root=Path(temporary)
            data=b"accepted"
            artifact={"path":"source", "length":len(data), "sha256":hashlib.sha256(data).hexdigest(), "region_id":"region"}
            with self.assertRaises(ValidationError):
                spool(root,artifact,root/"spool",lambda update:None)
            (root/"source").write_bytes(data)
            with patch.object(Path,"open",side_effect=PermissionError(errno.EACCES,"private spool denied")):
                with self.assertRaises(PermissionError):
                    spool(root,artifact,root/"spool",lambda update:None)
