"""Lossless JSON dictionaries over bytea, including NUL in source values/keys.

This is an authoritative report store, not a JSONB query projection. Migration
copies decoded old JSON values explicitly. Existing serialized output files are
never rewritten. Restoring an old release requires its pre-upgrade backup.
"""
import json
from django.db import models


class LosslessJSONField(models.BinaryField):
    description = 'UTF-8 JSON report stored losslessly in bytea'

    def from_db_value(self, value, expression, connection):
        return self.to_python(value)

    def to_python(self, value):
        if isinstance(value, (bytes, bytearray, memoryview)):
            return json.loads(bytes(value))
        if isinstance(value, str):
            return json.loads(value)
        return value

    def get_prep_value(self, value):
        if value is None:
            return None
        if isinstance(value, (bytes, bytearray, memoryview)):
            value = json.loads(bytes(value))
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')

    def value_to_string(self, obj):
        return self.get_prep_value(self.value_from_object(obj)).decode('utf-8')
