import hashlib
import os
import stat
from pathlib import PurePosixPath


def below(root, relative):
    path = PurePosixPath(relative)
    if not path.parts or path.is_absolute() or relative != path.as_posix() or ".." in path.parts:
        raise ValueError("Invalid relative inbox path.")
    target = root.joinpath(*path.parts)
    for directory in (target, *target.parents):
        if directory == root:
            break
        if directory.is_symlink():
            raise ValueError("Symlink in inbox path.")
    return target


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def make_directories(root, directory):
    if directory == root:
        return
    make_directories(root, directory.parent)
    try:
        directory.mkdir(mode=0o750)
    except FileExistsError:
        if not directory.is_dir() or directory.is_symlink():
            raise NotADirectoryError("Invalid inbox directory.")
    else:
        sync_directory(directory.parent)


def matches(path, length, expected):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != length:
            return False
        digest = hashlib.sha256()
        remaining = length
        while remaining:
            chunk = stream.read(min(1024**2, remaining))
            if not chunk:
                return False
            digest.update(chunk)
            remaining -= len(chunk)
        return not stream.read(1) and digest.hexdigest() == expected


def _raise_walk_error(error):
    raise error


def inbox_usage(root):
    total = 0
    linked = set()
    for parent, directories, files in os.walk(root, onerror=_raise_walk_error):
        directories.sort()
        for name in files:
            try:
                info = os.lstat(os.path.join(parent, name))
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if info.st_nlink > 1:
                key = (info.st_dev, info.st_ino)
                if key in linked:
                    continue
                linked.add(key)
            total += max(info.st_size, info.st_blocks * 512)
    return total
