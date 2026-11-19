import json
from functools import lru_cache
from pathlib import Path

from django.core.exceptions import ValidationError
from jsonschema import Draft202012Validator, ValidationError as SchemaValidationError


@lru_cache(maxsize=2)
def validator(kind):
    if kind not in {"batch","region"}:
        raise ValueError("Unsupported verification manifest kind.")
    return Draft202012Validator(json.loads((Path(__file__).parent/"schemas"/f"{kind}-v1.json").read_bytes()))


def validate_manifest(kind,value):
    try:
        validator(kind).validate(value)
    except SchemaValidationError as error:
        raise ValidationError("The verification manifest does not match its supported schema.") from error
