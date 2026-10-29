import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('passive_guest', Path(__file__).with_name('passive-guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)

class MissingMetricTests(unittest.TestCase):
    def test_missing_metric_is_unknown_not_zero(self):
        with tempfile.TemporaryDirectory() as p:
            value = guest.text(Path(p) / 'missing')
        self.assertIsNone(value['value'])
        self.assertEqual(value['error'], 'FileNotFoundError')

    def test_oversized_metric_is_explicitly_refused(self):
        with tempfile.TemporaryDirectory() as p:
            path = Path(p) / 'counter'
            path.write_text('x' * 17)
            value = guest.text(path, limit=16)
        self.assertIsNone(value['value'])
        self.assertEqual(value['error'], 'ValueError')

if __name__ == '__main__':
    unittest.main()
