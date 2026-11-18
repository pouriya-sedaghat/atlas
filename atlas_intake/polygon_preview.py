import hashlib
import math
import os
import stat
from pathlib import Path

MAX_PREVIEW_BYTES = 2 * 1024 * 1024


def read_boundary(inbox, relative_path, expected_length, expected_sha256):
    if not expected_sha256 or not expected_length or not 0 < expected_length <= MAX_PREVIEW_BYTES:
        raise ValueError("Boundary has no previewable fingerprint")
    root = Path(inbox).resolve(strict=True)
    path = (root / relative_path).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError("Boundary path is outside the inbox")

    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_length:
            raise ValueError("Boundary size does not match")
        content = stream.read(expected_length + 1)
    if len(content) != expected_length or hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError("Boundary fingerprint does not match")

    return _parse_rings(content)


def _parse_rings(content):
    lines = (line.strip() for line in content.decode("utf-8").splitlines())
    next(lines, "")  # Provider polygon name.
    rings = []
    for label in lines:
        if not label:
            continue
        if label == "END":
            if rings and not any(lines):
                return rings
            break
        points = []
        for line in lines:
            if line == "END":
                break
            if line:
                longitude, latitude = map(float, line.split())
                if not math.isfinite(longitude) or not math.isfinite(latitude):
                    raise ValueError("Boundary coordinate is not finite")
                if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                    raise ValueError("Boundary coordinate is outside lon/lat bounds")
                points.append([longitude, latitude])
        if len(points) < 3:
            raise ValueError("Boundary ring has fewer than three vertices")
        rings.append(points)

    raise ValueError("Boundary has no valid final terminator")
