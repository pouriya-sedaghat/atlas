from pathlib import Path
from tempfile import TemporaryDirectory
from hashlib import sha256
from unittest import TestCase
from django.core.exceptions import ValidationError
from atlas_verification.storage import hash_file

class RegisteredOutputBoundsTests(TestCase):
    def test_registered_output_size_is_checked_before_hashing(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'output').write_bytes(b'abc')
            with self.assertRaises(ValidationError):hash_file(root,'output',expected_size=1)
            self.assertEqual(hash_file(root,'output',expected_size=3),(3,sha256(b'abc').hexdigest()))
