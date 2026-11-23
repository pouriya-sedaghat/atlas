import hashlib
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from time import monotonic

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from atlas_intake.control import audit, lock_control
from atlas_intake.models import Artifact, Run
from atlas_intake.storage import inbox_usage, make_directories, sync_directory
from .control import SUCCESS, assert_current
from .models import VerificationAttempt, VerificationExecution, VerificationHealth
from .storage import hash_file, inventory, write_json, safe_open
from .manifest import validate_manifest
from .resources import CgroupObservation
from .diagnostics import diagnostic_text


LEASE = timedelta(seconds=30)


def heartbeat():
    VerificationHealth.objects.update_or_create(pk=1,defaults={"heartbeat":timezone.now()})


def directory(root, relative, mode=0o750):
    target = root/relative
    make_directories(root,target)
    os.chmod(target,mode)
    return target


class VerificationWorker:
    def __init__(self, root=None, child_command=None):
        self.root = Path(root or settings.ATLAS_VERIFICATION_ROOT).resolve(strict=True)
        self.work = directory(self.root,".work",0o700)
        self.child_command = child_command
        self.deadline = settings.ATLAS_VERIFICATION_TIMEOUT

    @transaction.atomic
    def claim(self):
        lock_control()
        if VerificationAttempt.objects.filter(status="running").exists():
            return None
        attempt = VerificationAttempt.objects.select_for_update().filter(status="queued").order_by("created_at","pk").first()
        if not attempt:
            return None
        try:
            assert_current(attempt)
        except ValidationError as error:
            self.finish_failure(attempt,"input_invalid",str(error))
            return None
        usage = inbox_usage(self.root)
        outstanding = VerificationAttempt.objects.exclude(pk=attempt.pk).aggregate(
            value=Sum("reserved_bytes"),
        )["value"] or 0
        intake = 0
        for row in Artifact.objects.filter(reserved_bytes__gt=0).only("stage_path","reserved_bytes"):
            if not row.stage_path:
                intake += row.reserved_bytes
                continue
            try:
                staged = (Path(settings.ATLAS_INBOX)/row.stage_path).stat().st_size
            except FileNotFoundError:
                staged = 0
            intake += max(0,row.reserved_bytes-staged)
        from atlas_build.capacity import outstanding_build_bytes
        build_remaining = outstanding_build_bytes(self.root)
        cap = settings.ATLAS_VERIFICATION_ATTEMPT_BYTES
        if (
            usage + outstanding + cap > settings.ATLAS_VERIFICATION_ROOT_BYTES
            or shutil.disk_usage(self.root).free - outstanding - intake - build_remaining - cap < settings.ATLAS_LIMITS["free"]
        ):
            self.finish_failure(attempt,"operational_failed","Verification storage reservation is unavailable.")
            return None
        attempt.generation += 1
        attempt.status = "running"
        attempt.lease_until = timezone.now()+LEASE
        attempt.reserved_bytes = cap
        attempt.progress = {"phase":"claimed"}
        attempt.error = ""
        attempt.finished_at = None
        attempt.save(update_fields=["generation","status","lease_until","reserved_bytes","progress","error","finished_at"])
        VerificationExecution.objects.create(attempt=attempt,generation=attempt.generation,started_at=timezone.now())
        audit("verification.started","verifier",attempt.run,verification=str(attempt.pk),generation=attempt.generation)
        return attempt

    @staticmethod
    def finish_failure(attempt,status,message,report=None):
        now = timezone.now()
        attempt.status = status
        attempt.error = diagnostic_text(message, 2000)
        if report is not None:
            attempt.summary = report
        elif not attempt.intended:
            attempt.summary = {"status":status,"build_eligible":False,"reasons":[{"code":status,"message":message[:2000]}]}
        execution_report = {"status":status,"error":message[:2000],"result":attempt.summary}
        attempt.lease_until = None
        attempt.reserved_bytes = 0
        attempt.finished_at = now
        attempt.save(update_fields=["status","error","summary","lease_until","reserved_bytes","finished_at"])
        attempt.executions.filter(generation=attempt.generation,finished_at=None).update(
            status=status,finished_at=now,report=execution_report,
        )
        audit("verification.failed","verifier",attempt.run,verification=str(attempt.pk),
              generation=attempt.generation,status=status,error=diagnostic_text(message, 500))

    @transaction.atomic
    def renew(self, attempt_id,generation,progress):
        attempt = VerificationAttempt.objects.select_for_update().get(pk=attempt_id)
        if attempt.generation != generation or attempt.status != "running" or attempt.lease_until <= timezone.now():
            return False
        attempt.progress = progress
        attempt.lease_until = timezone.now()+LEASE
        attempt.save(update_fields=["progress","lease_until"])
        return True

    def generation_path(self,attempt):
        parent = directory(self.root,f".work/{attempt.pk}",0o700)
        return directory(self.root,f".work/{attempt.pk}/{attempt.generation}",0o700)

    def storage_limit(self,attempt):
        roots=[self.root/f".work/{attempt.pk}",
               self.root/attempt.snapshot["retrieval_local_date"]/str(attempt.run_id)/str(attempt.pk)]
        seen=set()
        used=0
        def walk_error(error):
            raise error
        for root in roots:
            if not root.exists():
                continue
            for parent, _, files in os.walk(root,onerror=walk_error):
                for name in files:
                    try:
                        info=os.lstat(Path(parent)/name)
                    except FileNotFoundError:
                        continue
                    identity=(info.st_dev,info.st_ino)
                    if stat.S_ISREG(info.st_mode) and identity not in seen:
                        seen.add(identity)
                        used+=max(info.st_size,info.st_blocks*512)
        if used>settings.ATLAS_VERIFICATION_ATTEMPT_BYTES:
            return used,f"Verification exceeded its per-attempt storage cap: {used} > {settings.ATLAS_VERIFICATION_ATTEMPT_BYTES} bytes."
        root_used=inbox_usage(self.root)
        if root_used>settings.ATLAS_VERIFICATION_ROOT_BYTES:
            return used,f"Verification exceeded its root storage cap: {root_used} > {settings.ATLAS_VERIFICATION_ROOT_BYTES} bytes."
        free=shutil.disk_usage(self.root).free
        if free<settings.ATLAS_LIMITS["free"]:
            return used,f"Filesystem free-space reserve was reached: {free} < {settings.ATLAS_LIMITS['free']} bytes."
        return used,None

    @staticmethod
    def resource_failure(report,message,used):
        report.update(status="operational_failed",build_eligible=False,resource_failure=message)
        report["reasons"]=[*report.get("reasons",[])[:31],{"code":"resource_limit","message":message}]
        resources=report.setdefault("resources",{})
        resources["disk_high_water_bytes"]=max(resources.get("disk_high_water_bytes",0),used)
        return report

    @staticmethod
    def read_report(path):
        with path.open("rb") as source:
            encoded=source.read(4*1024**2+1)
        if len(encoded)>4*1024**2:
            raise ValueError("Verification report exceeded its size cap.")
        report=json.loads(encoded)
        if not isinstance(report,dict):
            raise ValueError("Verification report is not an object.")
        return report

    def execute(self,attempt):
        from .execute import tool_versions
        if attempt.tools != tool_versions() or attempt.policy_version != "atlas-input-v1":
            with transaction.atomic():
                current=VerificationAttempt.objects.select_for_update().get(pk=attempt.pk)
                self.finish_failure(current,"unsupported_profile","Pinned verification tools or policy have changed.")
            return
        path = self.generation_path(attempt)
        write_json(path/"snapshot.json",attempt.snapshot)
        start = monotonic()
        command = self.child_command or [sys.executable,"manage.py","atlas_verification_execute",str(path)]
        stderr = path/"child.stderr"
        observation=CgroupObservation()
        write_json(path/"cgroup-before.json",observation.before)
        measurements = {"disk_high_water_bytes":inbox_usage(path),"aggregate_peak_memory_bytes":0,
                        "attempt_sampled_peak_memory_bytes":0}
        failure = None
        with stderr.open("xb") as errors:
            child = subprocess.Popen(command,stdout=subprocess.PIPE,stderr=errors,start_new_session=True,bufsize=0)
            os.set_blocking(child.stdout.fileno(),False)
            selector = selectors.DefaultSelector()
            selector.register(child.stdout,selectors.EVENT_READ)
            last_renew = 0.0
            progress = {"phase":"starting"}
            progress_buffer = bytearray()
            try:
                while child.poll() is None:
                    for key, _ in selector.select(timeout=0.5):
                        try:
                            chunk = os.read(key.fd,8192)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        progress_buffer.extend(chunk)
                        while b"\n" in progress_buffer:
                            line, _, progress_buffer = progress_buffer.partition(b"\n")
                            if len(line)>=8192:
                                failure = "Verifier progress exceeded its output limit."
                                break
                            progress = json.loads(line)
                        if len(progress_buffer)>=8192:
                            failure = "Verifier progress exceeded its output limit."
                        if failure:
                            break
                    if failure:
                        os.killpg(child.pid,signal.SIGKILL)
                        break
                    now = monotonic()
                    if now-last_renew < 2:
                        continue
                    last_renew=now
                    used,storage_failure = self.storage_limit(attempt)
                    measurements["disk_high_water_bytes"] = max(measurements["disk_high_water_bytes"],used)
                    current=observation.sample()
                    measurements["attempt_sampled_peak_memory_bytes"]=observation.sampled_peaks["memory_current_bytes"] or 0
                    measurements["aggregate_peak_memory_bytes"]=max(
                        measurements["aggregate_peak_memory_bytes"],current.get("memory_peak_bytes") or 0,
                    )
                    heartbeat()
                    if not self.renew(attempt.pk,attempt.generation,{**progress,**measurements}):
                        failure = "Verification generation lost its active claim."
                    elif now-start >= self.deadline:
                        failure = "Verification execution exceeded the one-hour deadline."
                    elif storage_failure:
                        failure = storage_failure
                    elif observation.failure():
                        failure = observation.failure()
                    if failure:
                        os.killpg(child.pid,signal.SIGKILL)
                        break
                child.wait()
            finally:
                selector.close()
                child.stdout.close()
                if child.poll() is None:
                    os.killpg(child.pid,signal.SIGKILL)
                    child.wait()
        used,storage_failure=self.storage_limit(attempt)
        measurements["disk_high_water_bytes"]=max(measurements["disk_high_water_bytes"],used)
        if not failure:
            failure=("Verification execution exceeded the one-hour deadline."
                     if monotonic()-start>=self.deadline else storage_failure)
        cgroup_report=observation.finish()
        cgroup_report["execution_stage"]="generation child execution: after snapshot creation through child exit and final storage/deadline checks; before result registration/publication"
        write_json(path/"cgroup-after.json",cgroup_report["after"])
        if observation.failure():
            failure=observation.failure()
        report_path=path/"report.json"
        if child.returncode or failure or not report_path.is_file():
            previous=report_path if report_path.is_file() else path/"partial.json"
            report=self.read_report(previous) if previous.exists() else {}
            report.update(
                status="operational_failed",build_eligible=False,
                reasons=[{"code":"child_failed","message":failure or f"Verifier child exited with code {child.returncode}."}],
            )
            if failure:
                report["resource_failure"]=failure
            if not report_path.exists():
                write_json(report_path,report)
        else:
            report=self.read_report(report_path)
        measurements["aggregate_peak_memory_bytes"]=max(
            measurements["aggregate_peak_memory_bytes"],cgroup_report["before"].get("memory_peak_bytes") or 0,
            cgroup_report["after"].get("memory_peak_bytes") or 0,
        )
        measurements["aggregate_peak_memory_scope"]="cgroup lifetime"
        measurements["attempt_sampled_peak_memory_bytes"]=observation.sampled_peaks["memory_current_bytes"] or 0
        measurements["cgroup"]=cgroup_report
        measurements["disk_high_water_bytes"]=max(measurements["disk_high_water_bytes"],inbox_usage(path))
        report["resources"]={**report.get("execution",{}),**measurements,"wall_seconds":round(monotonic()-start,3)}
        self.complete(attempt.pk,attempt.generation,report,path)
        return report

    @transaction.atomic
    def complete(self,attempt_id,generation,report,path):
        run_id = VerificationAttempt.objects.values_list("run_id",flat=True).get(pk=attempt_id)
        Run.objects.select_for_update().get(pk=run_id)
        attempt=VerificationAttempt.objects.select_for_update().get(pk=attempt_id)
        if attempt.generation!=generation or attempt.status!="running" or attempt.lease_until<=timezone.now():
            return False
        try:
            assert_current(attempt)
        except ValidationError as error:
            self.finish_failure(attempt,"input_invalid",str(error),report)
            return False
        report.update(
            verification_id=str(attempt.pk),input_fingerprint=attempt.input_fingerprint,
            requested_by=attempt.requested_by,verified_at=timezone.now().isoformat(),
            frozen_inputs=attempt.snapshot,
        )
        used,storage_failure=self.storage_limit(attempt)
        if storage_failure:
            self.finish_failure(attempt,"operational_failed",storage_failure,
                                self.resource_failure(report,storage_failure,used))
            return False
        result_root=path/"result"
        if report.get("status") not in SUCCESS:
            if result_root.is_dir() and "regions" in report and not report.get("resource_failure"):
                validate_manifest("batch",report)
                failure_meta=write_json(result_root/"manifest.json",report)
                report["failure_manifest"]={**failure_meta,"path":str((result_root/"manifest.json").relative_to(self.root))}
                used,storage_failure=self.storage_limit(attempt)
                if storage_failure:
                    self.resource_failure(report,storage_failure,used)
            self.finish_failure(attempt,report.get("status","operational_failed"),
                                report.get("resource_failure","Verification did not pass all required checks."),report)
            return False
        validate_manifest("batch",report)
        meta=write_json(result_root/"manifest.json",report)
        final=f"{attempt.snapshot['retrieval_local_date']}/{attempt.run_id}/{attempt.pk}"
        files=inventory(result_root,result_root)
        for file in files:
            with (result_root/file["path"]).open("rb") as output:
                os.fsync(output.fileno())
        for parent, directories, filenames in os.walk(result_root,topdown=False):
            sync_directory(parent)
        used,storage_failure=self.storage_limit(attempt)
        if storage_failure:
            self.finish_failure(attempt,"operational_failed",storage_failure,
                                self.resource_failure(report,storage_failure,used))
            return False
        attempt.intended={
            "generation":generation,"stage":str(result_root.relative_to(self.root)),
            "target":final,"files":[{**file,"path":f"{final}/{file['path']}","source":file["path"]} for file in files],
            "manifest_path":f"{final}/manifest.json","manifest_sha256":meta["sha256"],
        }
        attempt.status="prepared"
        attempt.tools=report["tools"]
        attempt.summary={key:value for key,value in report.items() if key!="frozen_inputs"}
        attempt.lease_until=None
        attempt.save(update_fields=["intended","status","tools","summary","lease_until"])
        return True

    @transaction.atomic
    def publish(self,attempt_id,generation):
        run_id=VerificationAttempt.objects.values_list("run_id",flat=True).get(pk=attempt_id)
        Run.objects.select_for_update().get(pk=run_id)
        attempt=VerificationAttempt.objects.select_for_update().get(pk=attempt_id)
        if attempt.status!="prepared" or attempt.generation!=generation or attempt.intended.get("generation")!=generation:
            return False
        try:
            assert_current(attempt)
        except ValidationError as error:
            self.finish_failure(attempt,"input_invalid",str(error))
            return False
        try:
            _,storage_failure=self.storage_limit(attempt)
            if storage_failure:
                raise ValidationError(storage_failure)
            stage=self.root/attempt.intended["stage"]
            # Publish the batch manifest last. Registration remains the visibility boundary.
            files=sorted(attempt.intended["files"],key=lambda file:file["path"]==attempt.intended["manifest_path"])
            for file in files:
                source=stage/file["source"]
                target=self.root/file["path"]
                make_directories(self.root,target.parent)
                directory_path=target.parent
                while directory_path != self.root:
                    os.chown(directory_path,-1,10001)
                    os.chmod(directory_path,0o750)
                    directory_path=directory_path.parent
                if not target.exists():
                    size,digest=hash_file(stage,file["source"])
                    if (size,digest)!=(file["size"],file["sha256"]):
                        raise ValidationError("A staged verification output changed before publication.")
                    os.chmod(source,0o640)
                    os.chown(source,-1,10001)
                    try:
                        os.link(source,target,follow_symlinks=False)
                    except FileExistsError:
                        pass
                size,digest=hash_file(self.root,file["path"])
                if (size,digest)!=(file["size"],file["sha256"]):
                    raise ValidationError("A published verification output conflicts with its registered intent.")
                sync_directory(target.parent)
            assert_current(attempt)
            _,storage_failure=self.storage_limit(attempt)
            if storage_failure:
                raise ValidationError(storage_failure)
        except (OSError,ValidationError) as error:
            self.finish_failure(attempt,"operational_failed",str(error))
            return False
        attempt.successful=True
        attempt.status=attempt.summary["status"]
        attempt.build_eligible=attempt.summary["build_eligible"]
        attempt.manifest_path=attempt.intended["manifest_path"]
        attempt.manifest_sha256=attempt.intended["manifest_sha256"]
        attempt.reserved_bytes=0
        attempt.finished_at=timezone.now()
        attempt.save(update_fields=[
            "successful","status","build_eligible","manifest_path","manifest_sha256","reserved_bytes","finished_at",
        ])
        attempt.executions.filter(generation=attempt.generation).update(
            status=attempt.status,finished_at=attempt.finished_at,report=attempt.summary,
        )
        from atlas_build.control import publication_receipt
        publication_receipt(attempt)
        audit("verification.completed","verifier",attempt.run,verification=str(attempt.pk),
              manifest_sha256=attempt.manifest_sha256,build_eligible=attempt.build_eligible)
        return True

    def failure_checkpoint(self, attempt, message):
        relative=f".work/{attempt.pk}/{attempt.generation}/partial.json"
        try:
            with safe_open(self.root, relative) as source:
                encoded=source.read(4*1024**2+1)
            if len(encoded)>4*1024**2:
                raise ValueError("Checkpoint exceeds its size cap.")
            report=json.loads(encoded)
            if not isinstance(report, dict):
                raise ValueError("Checkpoint is not an object.")
        except (OSError, ValueError, ValidationError):
            report={"checks_completed":[],
                    "checks_incomplete":[item["artifact_id"] for item in attempt.snapshot["artifacts"]]}
        report.update(status="operational_failed", build_eligible=False,
                      reasons=[{"code":"operational_failed","message":message[:2000]}],
                      last_progress=attempt.progress)
        try:
            with safe_open(self.root,f".work/{attempt.pk}/{attempt.generation}/cgroup-before.json") as source:
                encoded=source.read(16385)
            if len(encoded)>16384:
                raise ValueError("Cgroup checkpoint exceeds its bound.")
            before=json.loads(encoded)
            if not isinstance(before,dict):
                raise ValueError("Cgroup checkpoint is not an object.")
        except (OSError,ValueError,ValidationError):
            pass
        else:
            observation=CgroupObservation(before=before)
            cgroup=observation.finish()
            cgroup["execution_stage"]="failure/recovery observation; after may be in a later cgroup lifetime and samples do not reconstruct unobserved execution"
            report.setdefault("resources",{})["cgroup"]=cgroup
            if observation.failure():
                report["resource_failure"]=observation.failure()
        return report

    def recover(self):
        for attempt in VerificationAttempt.objects.filter(status="prepared").order_by("created_at")[:8]:
            self.publish(attempt.pk,attempt.generation)
        for candidate in VerificationAttempt.objects.filter(status="running",lease_until__lte=timezone.now()):
            with transaction.atomic():
                Run.objects.select_for_update().get(pk=candidate.run_id)
                attempt=VerificationAttempt.objects.select_for_update().get(pk=candidate.pk)
                if attempt.status=="running" and attempt.lease_until<=timezone.now():
                    message="Verifier claim expired. Retry uses the same frozen input snapshot."
                    self.finish_failure(attempt,"operational_failed",message,
                                        self.failure_checkpoint(attempt,message))

    def tick(self):
        heartbeat()
        self.recover()
        attempt=self.claim()
        if attempt:
            try:
                self.execute(attempt)
            except Exception as error:
                with transaction.atomic():
                    Run.objects.select_for_update().get(pk=attempt.run_id)
                    current=VerificationAttempt.objects.select_for_update().get(pk=attempt.pk)
                    if current.generation==attempt.generation and current.status=="running":
                        message=f"Verifier execution failed ({type(error).__name__})."
                        self.finish_failure(current,"operational_failed",message,
                                            self.failure_checkpoint(current,message))
            attempt.refresh_from_db()
            if attempt.status=="prepared":
                self.publish(attempt.pk,attempt.generation)
        return attempt is not None
