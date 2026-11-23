"""Explicit diagnostic escaping; authoritative reports retain original values."""
import json
import unicodedata


def diagnostic_text(value, limit=2000):
    escaped = ''.join((json.dumps(c, ensure_ascii=True)[1:-1]
                      if unicodedata.category(c).startswith('C') else c)
                     for c in str(value))
    return escaped[:limit]


def diagnostic_json(value, limit=65536):
    encoded = json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False)
    if len(encoded) > limit:
        return encoded[:limit] + "\n[Diagnostic display truncated; authoritative report retained.]"
    return encoded
