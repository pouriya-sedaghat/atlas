"""One-pass bounded Zstd frame and JSONL reconciliation, without body buffering."""
import hashlib,json,os
import zstandard
from pathlib import Path
from atlas_verification.storage import safe_open
from django.core.exceptions import ValidationError

MAX_RECORD=32*1024**2

class DecodeBudget:
    def __init__(self,limit,used=0):self.limit=limit;self.used=used
    def consume(self,size):
        self.used+=size
        if self.used>self.limit:raise ValidationError('Aggregate decoded input budget exceeded.')


def iter_ir(path,descriptor,budget,checkpoint=lambda:None):
    expected=descriptor['uncompressed_size']
    if (type(expected) is not int or expected<0 or expected>budget.limit-budget.used
            or type(descriptor['count']) is not int or descriptor['count']<0):
        raise ValidationError('Declared decoded stream exceeds fixture budget.')
    decoder=zstandard.ZstdDecompressor(max_window_size=64*1024*1024).decompressobj()
    compressed_hash=hashlib.sha256();plain_hash=hashlib.sha256()
    compressed=expanded=count=0;pending=bytearray()
    path=Path(path)
    with safe_open(path.parent,path.name) as source:
        if os.fstat(source.fileno()).st_size!=descriptor['size']:
            raise ValidationError('Spool compressed size changed.')
        try:
            while data:=source.read(1024):
                checkpoint()
                compressed+=len(data)
                if compressed>descriptor['size'] or decoder.eof:
                    raise ValidationError('IR has trailing or concatenated frames.')
                compressed_hash.update(data);plain=decoder.decompress(data)
                if decoder.unused_data:raise ValidationError('IR has bytes after its frame.')
                expanded+=len(plain)
                if expanded>expected:raise ValidationError('Actual IR expansion exceeds declared size.')
                budget.consume(len(plain));plain_hash.update(plain);pending.extend(plain)
                consumed=0
                while (end:=pending.find(b'\n',consumed))!=-1:
                    if end+1-consumed>=MAX_RECORD:raise ValidationError('IR record reaches its 32 MiB ceiling.')
                    line=bytes(pending[consumed:end+1]);consumed=end+1;count+=1
                    if count>descriptor['count']:raise ValidationError('IR record count exceeds descriptor.')
                    yield json.loads(line),line
                if consumed:del pending[:consumed]
                if len(pending)>=MAX_RECORD:raise ValidationError('IR record reaches its 32 MiB ceiling.')
        except (zstandard.ZstdError,UnicodeError,json.JSONDecodeError):
            raise ValidationError('Invalid complete Zstd/JSONL stream.') from None
    if (not decoder.eof or pending or count!=descriptor['count'] or expanded!=expected
            or compressed_hash.hexdigest()!=descriptor['sha256']
            or plain_hash.hexdigest()!=descriptor['uncompressed_sha256']):
        raise ValidationError('IR frame, final newline, count or complete digest mismatch.')
    checkpoint()
