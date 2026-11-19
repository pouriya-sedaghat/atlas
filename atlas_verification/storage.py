import hashlib
import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from django.core.exceptions import ValidationError

from atlas_intake.storage import inbox_usage, make_directories, sync_directory


def relative_parts(value):
    relative = PurePosixPath(value)
    if not relative.parts or relative.is_absolute() or value != relative.as_posix() or ".." in relative.parts:
        raise ValidationError("Invalid verification storage path.")
    return relative.parts


@contextmanager
def safe_open(root, relative):
    """Keep each validated directory descriptor open until its child is opened."""
    parts = relative_parts(relative)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file_descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            if not stat.S_ISREG(os.fstat(file_descriptor).st_mode):
                raise ValidationError("A verification input must be a regular file.")
            stream = os.fdopen(file_descriptor, "rb")
            file_descriptor = None
            with stream:
                yield stream
        finally:
            if file_descriptor is not None:
                os.close(file_descriptor)
    finally:
        os.close(descriptor)


def hash_file(root, relative):
    digest = hashlib.sha256()
    size = 0
    with safe_open(root, relative) as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def read_checked(root, relative, expected, cap):
    with safe_open(root, relative) as source:
        data = source.read(cap + 1)
    if len(data) > cap or hashlib.sha256(data).hexdigest() != expected:
        raise ValidationError("A verification manifest is missing or has changed.")
    return data


def spool(root, artifact, destination, progress):
    digest = hashlib.sha256()
    copied = 0
    with safe_open(root, artifact["path"]) as source, destination.open("xb") as target:
        if os.fstat(source.fileno()).st_size != artifact["length"]:
            raise ValidationError("The source size differs from the frozen input.")
        while copied < artifact["length"]:
            chunk = source.read(min(1024**2, artifact["length"] - copied))
            if not chunk:
                raise ValidationError("The source ended before its frozen byte count.")
            target.write(chunk)
            copied += len(chunk)
            digest.update(chunk)
            progress({"phase": "spooling", "region": artifact["region_id"], "bytes": copied})
        if source.read(1) or digest.hexdigest() != artifact["sha256"]:
            raise ValidationError("The source fingerprint differs from the frozen input.")
        target.flush()
        os.fsync(target.fileno())
    sync_directory(destination.parent)
    return destination


def write_json(path, value):
    from .control import canonical
    encoded = canonical(value)
    if len(encoded) > 4 * 1024**2:
        raise ValueError("Manifest exceeds the verification size limit.")
    with path.open("xb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    return {"path": path.name, "size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}


def inventory(root, base):
    files = []
    for directory, names, filenames in os.walk(base):
        names.sort()
        for name in sorted(filenames):
            path = Path(directory) / name
            if path.is_symlink():
                raise ValidationError("Symlinks cannot be registered as verification output.")
            relative = path.relative_to(root).as_posix()
            size, digest = hash_file(root, relative)
            files.append({"path": relative, "size": size, "sha256": digest})
    return files
