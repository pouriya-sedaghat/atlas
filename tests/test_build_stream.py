import hashlib,json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
import zstandard
from django.core.exceptions import ValidationError

class BoundedIRTests(TestCase):
    def fixture(self,root,raw):
        encoded=zstandard.ZstdCompressor(write_checksum=True).compress(raw)
        p=root/'ir.zst';p.write_bytes(encoded)
        return p,{'size':len(encoded),'sha256':hashlib.sha256(encoded).hexdigest(),
          'uncompressed_size':len(raw),'uncompressed_sha256':hashlib.sha256(raw).hexdigest(),
          'count':raw.count(b'\n')}

    def test_single_frame_stream_reconciles_all_bytes_and_counts(self):
        from atlas_build.stream import iter_ir,DecodeBudget
        with TemporaryDirectory() as t:
            p,d=self.fixture(Path(t),b'{"id":"1"}\n{"id":"2"}\n')
            budget=DecodeBudget(1024)
            self.assertEqual([x for x,line in iter_ir(p,d,budget)],[{'id':'1'},{'id':'2'}])
            self.assertEqual(budget.used,d['uncompressed_size'])

    def test_truncated_trailing_and_concatenated_frames_are_rejected(self):
        from atlas_build.stream import iter_ir,DecodeBudget
        for mutate in [lambda b:b[:-1],lambda b:b+b'x',lambda b:b+b]:
            with TemporaryDirectory() as t:
                p,d=self.fixture(Path(t),b'{}\n');raw=mutate(p.read_bytes());p.write_bytes(raw)
                d.update(size=len(raw),sha256=hashlib.sha256(raw).hexdigest())
                with self.assertRaises(ValidationError):list(iter_ir(p,d,DecodeBudget(1024)))

    def test_actual_expansion_record_and_count_bounds_fail_closed(self):
        from atlas_build.stream import iter_ir,DecodeBudget
        for mode in ['size','count','budget','newline']:
            with self.subTest(mode=mode),TemporaryDirectory() as t:
                raw=b'{"value":"'+b'a'*10000+b'"}\n'
                if mode=='newline':raw=raw[:-1]
                p,d=self.fixture(Path(t),raw)
                if mode=='size':d['uncompressed_size']=1
                if mode=='count':d['count']=0
                limit=1 if mode=='budget' else 20000
                with self.assertRaises(ValidationError):list(iter_ir(p,d,DecodeBudget(limit)))

    def test_permitted_large_line_is_complete_and_exact_ceiling_is_rejected_before_parse(self):
        from atlas_build.stream import iter_ir,DecodeBudget,MAX_RECORD
        for length in [4*1024**2,MAX_RECORD]:
            with self.subTest(length=length),TemporaryDirectory() as temporary:
                raw=b'{"value":"'+b'a'*(length-13)+b'"}\n'
                self.assertEqual(len(raw),length)
                path,descriptor=self.fixture(Path(temporary),raw);del raw
                if length==MAX_RECORD:
                    with self.assertRaises(ValidationError):list(iter_ir(path,descriptor,DecodeBudget(MAX_RECORD+1)))
                else:
                    row,line=next(iter_ir(path,descriptor,DecodeBudget(MAX_RECORD)))
                    self.assertEqual(len(line),length);self.assertEqual(len(row['value']),length-13)

    def test_frames_with_unnecessary_large_windows_are_refused_before_expansion(self):
        from atlas_build.stream import iter_ir,DecodeBudget
        raw=b'{"value":"bounded"}\n'
        encoded=bytearray(zstandard.ZstdCompressor(write_content_size=False).compress(raw))
        self.assertFalse(encoded[4]&0x20)
        encoded[5]=(27-10)<<3 # Declare a 128 MiB window without growing the tiny body.
        encoded=bytes(encoded)
        with TemporaryDirectory() as temporary:
            path=Path(temporary)/'window.zst';path.write_bytes(encoded)
            # Explicit header-only window declaration for this resource probe;
            # output length, SHA and JSON remain small and valid.
            desc={'size':len(encoded),'sha256':hashlib.sha256(encoded).hexdigest(),
                'uncompressed_size':len(raw),'uncompressed_sha256':hashlib.sha256(raw).hexdigest(),'count':1}
            self.assertGreater(zstandard.get_frame_parameters(encoded).window_size,64*1024**2)
            with self.assertRaises(ValidationError):list(iter_ir(path,desc,DecodeBudget(1024)))
