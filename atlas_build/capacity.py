"""Shared filesystem reservations and fail-closed host/legacy preflight."""
import os
import shutil
import stat
from pathlib import Path
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils import timezone
from atlas_intake.models import Artifact
from atlas_verification.models import VerificationAttempt
from .models import BuildReservation,BuildHealth

class AdmissionDeferred(ValidationError):
    pass

GIB=1024**3
RESERVATION=12*GIB
ROOT_LIMIT=32*GIB
FREE_FLOOR=20*GIB


def storage_check(*,free,used,outstanding,legacy,new,root_outstanding=None):
    if min(free,used,outstanding,legacy,new)<0:raise ValidationError('Invalid capacity observation.')
    if free-outstanding-legacy-new<FREE_FLOOR:
        raise ValidationError('Filesystem free reserve and legacy headroom would be exceeded.')
    if root_outstanding is None:root_outstanding=outstanding
    if used+root_outstanding+new>ROOT_LIMIT:
        raise ValidationError('Build root including retained READY/failure data would exceed its cap.')
    return True


def outstanding_build_bytes(root):
    if not settings.ATLAS_BUILD_FIXTURE_MODE or not Path(root).exists():return 0
    fs=str(os.stat(root).st_dev)
    return sum(max(0,reserved-used) for reserved,used in BuildReservation.objects.filter(
        filesystem=fs).values_list('reserved_bytes','allocated_bytes'))


def active_plane_bytes(root):
    fs=os.stat(root).st_dev
    total=0
    if Path(settings.ATLAS_INBOX).exists() and os.stat(settings.ATLAS_INBOX).st_dev==fs:
        for a in Artifact.objects.filter(reserved_bytes__gt=0).only('reserved_bytes','stage_path'):
            try:allocated=(Path(settings.ATLAS_INBOX)/a.stage_path).stat().st_blocks*512 if a.stage_path else 0
            except FileNotFoundError:allocated=0
            total+=max(0,a.reserved_bytes-allocated)
    if Path(settings.ATLAS_VERIFICATION_ROOT).exists() and os.stat(settings.ATLAS_VERIFICATION_ROOT).st_dev==fs:
        for a in VerificationAttempt.objects.filter(reserved_bytes__gt=0):
            roots=[Path(settings.ATLAS_VERIFICATION_ROOT)/'.work'/str(a.pk),
                   Path(settings.ATLAS_VERIFICATION_ROOT)/a.snapshot['retrieval_local_date']/str(a.run_id)/str(a.pk)]
            allocated=allocated_bytes(roots)
            total+=max(0,a.reserved_bytes-allocated)
    return total


def host_memory_available():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):return int(line.split()[1])*1024
    raise ValidationError('Host available memory observation is unavailable.')


def legacy_window():
    h=BuildHealth.objects.filter(pk=1).first()
    if (not h or not h.legacy_until or h.legacy_until<=timezone.now()
            or not h.legacy.get('quiescent') or not h.legacy.get('inventory_digest')
            or not isinstance(h.legacy.get('headroom_bytes'),int)):
        raise AdmissionDeferred('A current external quiescent legacy-window attestation is required.')
    return h.legacy


def admission_capacity(root,root_used,*,new_service_uncommitted=0):
    root=Path(root);legacy=legacy_window()
    available=host_memory_available()
    if available<4*GIB or available-new_service_uncommitted<2*GIB:
        raise AdmissionDeferred('Insufficient uncommitted host memory headroom.')
    builds=outstanding_build_bytes(root)
    outstanding=builds+active_plane_bytes(root)
    free=shutil.disk_usage(root).free
    try:storage_check(free=free,used=root_used,outstanding=outstanding,
                  legacy=legacy['headroom_bytes'],new=RESERVATION,root_outstanding=builds)
    except ValidationError as error:raise AdmissionDeferred(str(error)) from error
    return {'filesystem':str(os.stat(root).st_dev),'free':free,'used':root_used,
            'outstanding':outstanding,'legacy':legacy,'available_memory':available,
            'reservation':RESERVATION}



def metric_budget(metrics):
    margin=128*1024**2
    caps={'heap_toast':4*GIB-margin,'indexes':2*GIB-margin,'wal':2*GIB-margin,
          'temp':GIB-margin,'database_bytes':6*GIB-margin,'root_used':ROOT_LIMIT,
          'client_bytes':GIB,'bundle_logs':64*1024**2}
    for field,cap in caps.items():
        value=metrics[field]
        if type(value) is not int or not 0<=value<=cap:raise ValidationError('Build growth/rollback margin reached for '+field+'.')
    if type(metrics['wal_generated']) is not int or metrics['wal_generated']<0:
        raise ValidationError('Cumulative WAL identity moved backward.')
    return True


def lsn_bytes(value):
    import re
    if not isinstance(value,str) or not re.fullmatch('[0-9A-F]{1,8}/[0-9A-F]{1,8}',value):raise ValidationError('Invalid bounded WAL position.')
    upper,lower=value.split('/')
    return (int(upper,16)<<32)+int(lower,16)


def growth_check(root,metrics):
    legacy=legacy_window()
    if host_memory_available()<2*GIB:raise ValidationError('Host memory stop threshold reached.')
    metric_budget(metrics)
    free=shutil.disk_usage(root).free
    if free-legacy['headroom_bytes']-outstanding_build_bytes(root)-active_plane_bytes(root)<FREE_FLOOR:
        raise ValidationError('Free reserve after outstanding commitments was reached.')
    return True



def allocated_bytes(roots):
    seen=set();total=0;count=0
    for root in roots:
        if not Path(root).exists():continue
        for parent,dirs,files in os.walk(root,followlinks=False):
            for name in files:
                try:info=os.lstat(Path(parent)/name)
                except FileNotFoundError:continue
                identity=(info.st_dev,info.st_ino)
                if stat.S_ISREG(info.st_mode) and identity not in seen:
                    seen.add(identity);total+=max(info.st_size,info.st_blocks*512)
                count+=1
                if count>100000:raise ValidationError('Allocation metadata walk exceeded its bound.')
    return total
