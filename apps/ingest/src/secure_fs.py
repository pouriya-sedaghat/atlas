#!/usr/bin/env python3
"""Linux descriptor-relative intake I/O. No input names are interpreted as commands."""
import hashlib
import errno
import json
import os
from pathlib import PurePosixPath
import re
import stat
import sys
import uuid

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
HEX32 = re.compile(r'^[0-9a-f]{32}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
MAX_MANIFEST = 8192
MAX_ARTIFACT = 8 * 1024 * 1024


class Invalid(Exception):
    pass


def identifier(value, pattern=HEX32):
    if not pattern.fullmatch(value): raise Invalid('invalid_identifier')
    return value


def absolute_directory(path, create=False):
    parts = PurePosixPath(path)
    if not parts.is_absolute() or '..' in parts.parts or str(parts) == '/':
        raise Invalid('invalid_root')
    fd = os.open('/', DIR_FLAGS)
    try:
        for component in parts.parts[1:]:
            if create:
                try: os.mkdir(component, 0o700, dir_fd=fd); os.fsync(fd)
                except FileExistsError: pass
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd); raise


def private_directory(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent); os.fsync(parent)
        except FileExistsError: pass
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd); raise Invalid('directory_permissions')
    return fd


def root_directory(path, create=False):
    fd = absolute_directory(path, create)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd); raise Invalid('root_permissions')
    return fd


def regular_file(parent, name, *, single_link=False):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or (single_link and info.st_nlink != 1):
        os.close(fd); raise Invalid('not_a_private_regular_file')
    return fd


def read_small(parent, name, limit, *, single_link=False):
    fd = regular_file(parent, name, single_link=single_link)
    try:
        before = os.fstat(fd)
        if before.st_size > limit: raise Invalid('file_too_large')
        chunks = []; length = 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - length))
            if not chunk: break
            chunks.append(chunk); length += len(chunk)
            if length > limit: raise Invalid('file_too_large')
        if fingerprint(before) != fingerprint(os.fstat(fd)): raise Invalid('file_changed')
        return b''.join(chunks)
    finally: os.close(fd)


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def digest_file(parent, name, expected_bytes):
    fd = regular_file(parent, name)
    try:
        info = os.fstat(fd)
        if info.st_size != expected_bytes: raise Invalid('size_mismatch')
        h = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024): h.update(chunk)
        if fingerprint(info) != fingerprint(os.fstat(fd)): raise Invalid('file_changed')
        return h.hexdigest()
    finally: os.close(fd)


def write_once(parent, name, data, mode=0o444):
    temporary = '.partial-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fchmod(stream.fileno(), mode); os.fsync(stream.fileno())
        try:
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            if read_small(parent, name, len(data)) != data: raise Invalid('immutable_file_conflict')
        os.fsync(parent)
    finally:
        os.unlink(temporary, dir_fd=parent); os.fsync(parent)


def copy_checked(source, destination, expected_bytes=None, expected_sha=None):
    before = os.fstat(source)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1: raise Invalid('not_a_private_regular_file')
    if expected_bytes is None: expected_bytes = before.st_size
    if before.st_size != expected_bytes or expected_bytes <= 0: raise Invalid('size_mismatch')
    h = hashlib.sha256(); length = 0
    while chunk := os.read(source, min(1024 * 1024, expected_bytes + 1 - length)):
        length += len(chunk)
        if length > expected_bytes: raise Invalid('source_grew')
        h.update(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(destination, view); view = view[written:]
    if length != expected_bytes or fingerprint(before) != fingerprint(os.fstat(source)):
        raise Invalid('file_changed')
    digest = h.hexdigest()
    if expected_sha is not None and digest != expected_sha: raise Invalid('sha256_mismatch')
    os.fchmod(destination, 0o444); os.fsync(destination)
    return digest, length


def parse_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise Invalid('duplicate_json_key')
            result[key] = value
        return result
    def invalid_constant(_): raise Invalid('non_finite_json_number')
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid_constant)


def inspect(root, submission):
    incoming = private_directory(root, 'incoming')
    delivery = -1
    try:
        delivery = private_directory(incoming, identifier(submission))
        try: marker = read_small(delivery, 'READY', 0, single_link=True)
        except FileNotFoundError: return {'status':'not_ready'}
        if marker != b'': raise Invalid('invalid_ready_marker')
        raw = read_small(delivery, 'source-manifest.json', MAX_MANIFEST, single_link=True)
        manifest = parse_json(raw)
        source = regular_file(delivery, 'input.osm.pbf', single_link=True)
        try: size = os.fstat(source).st_size
        finally: os.close(source)
        return {'status':'ready','manifest':manifest,'manifestSha256':hashlib.sha256(raw).hexdigest(),'bytes':size}
    finally:
        if delivery >= 0: os.close(delivery)
        os.close(incoming)


def initialize(path):
    root = root_directory(path, True)
    try:
        for name in ('incoming','quarantine','sources','artifacts','signing'):
            fd = private_directory(root, name, True); os.close(fd)
        os.fsync(root)
    finally: os.close(root)
    return {'initialized':True}


def submit(root, source_path, metadata):
    incoming = private_directory(root, 'incoming')
    submission = uuid.uuid4().hex
    source_parent = absolute_directory(str(PurePosixPath(source_path).parent))
    source = destination = delivery = -1
    try:
        source = regular_file(source_parent, PurePosixPath(source_path).name, single_link=True)
        source_info = os.fstat(source)
        maximum = metadata['maxBytes']
        if not 0 < source_info.st_size <= maximum: raise Invalid('size_limit')
        capacity = os.fstatvfs(root)
        if capacity.f_bavail * capacity.f_frsize < source_info.st_size + metadata['minFreeBytes']:
            raise Invalid('capacity')
        delivery = private_directory(incoming, submission, True)
        destination = os.open('input.osm.pbf.part', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=delivery)
        sha, length = copy_checked(source, destination, expected_sha=metadata.get('expectedSha256'))
        os.close(destination); destination = -1
        os.rename('input.osm.pbf.part','input.osm.pbf',src_dir_fd=delivery,dst_dir_fd=delivery)
        manifest = {'schema':'atlas.submission/1','id':submission,'sha256':sha,'bytes':length,'source':metadata['source']}
        write_once(delivery,'source-manifest.json',(json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n').encode())
        write_once(delivery,'READY',b''); os.fsync(delivery); os.fsync(incoming)
        return manifest
    finally:
        for fd in (source,destination,delivery,source_parent,incoming):
            if fd >= 0: os.close(fd)


def snapshot(root, submission, token, manifest_sha, expected_sha, expected_bytes, min_free):
    identifier(submission); identifier(token); identifier(manifest_sha,HEX64); identifier(expected_sha,HEX64)
    incoming = private_directory(root,'incoming'); delivery = private_directory(incoming,submission)
    quarantine = private_directory(root,'quarantine'); jobdir = private_directory(quarantine,submission,True)
    attempt = private_directory(jobdir,token,True)
    sources = private_directory(root,'sources'); blobdir = private_directory(sources,expected_sha,True)
    source = target = -1
    try:
        read_small(delivery,'READY',0,single_link=True)
        raw = read_small(delivery,'source-manifest.json',MAX_MANIFEST,single_link=True)
        if hashlib.sha256(raw).hexdigest() != manifest_sha: raise Invalid('manifest_changed')
        source = regular_file(delivery,'input.osm.pbf',single_link=True)
        capacity = os.fstatvfs(root)
        if capacity.f_bavail * capacity.f_frsize < expected_bytes + min_free: raise Invalid('capacity')
        target = os.open('input.partial',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=attempt)
        sha, length = copy_checked(source,target,expected_bytes,expected_sha)
        os.close(target); target = -1
        try:
            os.link('input.partial','input.osm.pbf',src_dir_fd=attempt,dst_dir_fd=blobdir,follow_symlinks=False)
            os.fsync(blobdir); os.fsync(sources); created = True
        except FileExistsError:
            if digest_file(blobdir,'input.osm.pbf',length) != sha: raise Invalid('blob_corrupt')
            created = False
        os.unlink('input.partial',dir_fd=attempt); os.fsync(attempt)
        return {'sha256':sha,'bytes':length,'created':created}
    finally:
        for fd in (source,target,blobdir,sources,attempt,jobdir,quarantine,delivery,incoming):
            if fd >= 0: os.close(fd)


def artifact(root, sha, data=None):
    identifier(sha,HEX64); artifacts = private_directory(root,'artifacts')
    try:
        if data is not None:
            if len(data)>MAX_ARTIFACT or hashlib.sha256(data).hexdigest()!=sha: raise Invalid('artifact_hash_mismatch')
            write_once(artifacts,sha+'.json',data)
        else:
            data = read_small(artifacts,sha+'.json',MAX_ARTIFACT)
            if hashlib.sha256(data).hexdigest()!=sha: raise Invalid('artifact_corrupt')
        return data
    finally: os.close(artifacts)


def cleanup_attempt(root, submission, token):
    identifier(submission); identifier(token)
    quarantine = private_directory(root,'quarantine')
    try:
        try: jobdir = private_directory(quarantine,submission)
        except FileNotFoundError: return {'cleaned':True}
        try:
            try: attempt = private_directory(jobdir,token)
            except FileNotFoundError: return {'cleaned':True}
            try:
                # Parser never mounts this directory. Never recurse into unknown entries.
                try: os.unlink('input.partial',dir_fd=attempt)
                except FileNotFoundError: pass
                os.fsync(attempt)
            finally: os.close(attempt)
            os.rmdir(token,dir_fd=jobdir); os.fsync(jobdir)
        finally: os.close(jobdir)
        return {'cleaned':True}
    finally: os.close(quarantine)


def consume(root, submission, manifest_sha):
    incoming=private_directory(root,'incoming'); delivery=private_directory(incoming,identifier(submission))
    try:
        raw=read_small(delivery,'source-manifest.json',MAX_MANIFEST,single_link=True)
        if hashlib.sha256(raw).hexdigest()!=identifier(manifest_sha,HEX64): raise Invalid('manifest_changed')
        for name in ('READY','input.osm.pbf'):
            try: os.unlink(name,dir_fd=delivery)
            except FileNotFoundError: pass
        write_once(delivery,'CONSUMED',b'');os.fsync(delivery)
        return {'consumed':True}
    finally: os.close(delivery);os.close(incoming)


def main():
    if not sys.platform.startswith('linux'): raise Invalid('linux_required')
    command, path, *args = sys.argv[1:]
    if command == 'init': result = initialize(path)
    else:
        root = root_directory(path)
        try:
            if command == 'inspect': result = inspect(root,args[0])
            elif command == 'bind':
                write_once(root,'control-instance.json',(identifier(args[0])+'\n').encode());result={'bound':args[0]}
            elif command == 'submit': result = submit(root,args[0],parse_json(sys.stdin.buffer.read(MAX_MANIFEST+1)))
            elif command == 'snapshot': result = snapshot(root,*args[:4],int(args[4]),int(args[5]))
            elif command == 'cleanup-attempt': result = cleanup_attempt(root,*args)
            elif command == 'consume': result = consume(root,*args)
            elif command == 'put-artifact':
                data = sys.stdin.buffer.read(MAX_ARTIFACT+1); artifact(root,args[0],data); result = {'stored':args[0]}
            elif command == 'read-artifact':
                sys.stdout.buffer.write(artifact(root,args[0])); return
            elif command == 'verify-blob':
                sources=private_directory(root,'sources'); blob=private_directory(sources,identifier(args[0],HEX64))
                try:
                    if digest_file(blob,'input.osm.pbf',int(args[1]))!=args[0]: raise Invalid('blob_corrupt')
                    result={'verified':True}
                finally: os.close(blob);os.close(sources)
            else: raise Invalid('unknown_command')
        finally: os.close(root)
    print(json.dumps(result,separators=(',',':')))


if __name__ == '__main__':
    try: main()
    except (Invalid,OSError,ValueError,KeyError,TypeError,RecursionError) as error:
        # File paths and arbitrary file contents are deliberately not copied into logs.
        code = str(error) if isinstance(error,Invalid) else {
            errno.ELOOP:'symlink_forbidden',errno.ENOTDIR:'unsafe_directory',errno.ENOENT:'file_missing',
            errno.EACCES:'filesystem_permission',errno.ENOSPC:'capacity'
        }.get(error.errno,'filesystem_failure') if isinstance(error,OSError) else type(error).__name__
        print(json.dumps({'error':code}),file=sys.stderr)
        raise SystemExit(2)
