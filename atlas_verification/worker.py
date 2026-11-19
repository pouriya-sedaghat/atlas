import hashlib
import json
import os
import selectors
import shutil
import signal
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
        cap = settings.ATLAS_VERIFICATION_ATTEMPT_BYTES
        if (
            usage + outstanding + cap > settings.ATLAS_VERIFICATION_ROOT_BYTES
            or shutil.disk_usage(self.root).free - outstanding - intake - cap < settings.ATLAS_LIMITS["free"]
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
        attempt.error = message[:2000]
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
              generation=attempt.generation,status=status,error=message[:500])

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
        measurements = {"disk_high_water_bytes":inbox_usage(path),"aggregate_peak_memory_bytes":0}
        failure = None
        with stderr.open("xb") as errors:
            child = subprocess.Popen(command,stdout=subprocess.PIPE,stderr=errors,start_new_session=True,bufsize=0)
            selector = selectors.DefaultSelector()
            selector.register(child.stdout,selectors.EVENT_READ)
            last_renew = 0.0
            progress = {"phase":"starting"}
            try:
                while child.poll() is None:
                    now = monotonic()
                    for key, _ in selector.select(timeout=0.5):
                        line = key.fileobj.readline(8193)
                        if len(line)>8192:
                            failure = "Verifier progress exceeded its output limit."
                            break
                        if line:
                            progress = json.loads(line)
                    if now-last_renew < 2:
                        continue
                    last_renew=now
                    used = inbox_usage(self.root/f".work/{attempt.pk}")
                    public = self.root/attempt.snapshot["retrieval_local_date"]/str(attempt.run_id)/str(attempt.pk)
                    if public.exists():
                        used += inbox_usage(public)
                    measurements["disk_high_water_bytes"] = max(measurements["disk_high_water_bytes"],used)
                    memory = Path("/sys/fs/cgroup/memory.current")
                    if memory.exists():
                        measurements["aggregate_peak_memory_bytes"] = max(
                            measurements["aggregate_peak_memory_bytes"],int(memory.read_text()),
                        )
                    heartbeat()
                    if not self.renew(attempt.pk,attempt.generation,{**progress,**measurements}):
                        failure = "Verification generation lost its active claim."
                    elif now-start >= self.deadline:
                        failure = "Verification execution exceeded the one-hour deadline."
                    elif used > settings.ATLAS_VERIFICATION_ATTEMPT_BYTES or inbox_usage(self.root)>settings.ATLAS_VERIFICATION_ROOT_BYTES:
                        failure = "Verification exceeded its storage cap."
                    elif shutil.disk_usage(self.root).free < settings.ATLAS_LIMITS["free"]:
                        failure = "Filesystem free-space reserve was reached."
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
        if child.returncode or failure or not (path/"report.json").is_file():
            partial=path/"partial.json"
            report=json.loads(partial.read_bytes()) if partial.exists() else {}
            report.update(
                status="operational_failed",build_eligible=False,
                reasons=[{"code":"child_failed","message":failure or f"Verifier child exited with code {child.returncode}."}],
            )
            if not (path/"report.json").exists():
                write_json(path/"report.json",report)
        else:
            raw = (path/"report.json").read_bytes()
            if len(raw)>4*1024**2:
                raise ValueError("Verification report exceeded its size cap.")
            report=json.loads(raw)
        peak=Path("/sys/fs/cgroup/memory.peak")
        if peak.exists():
            measurements["aggregate_peak_memory_bytes"]=max(
                measurements["aggregate_peak_memory_bytes"],int(peak.read_text()),
            )
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
        result_root=path/"result"
        if report.get("status") not in SUCCESS:
            if result_root.is_dir() and "regions" in report:
                validate_manifest("batch",report)
                failure_meta=write_json(result_root/"manifest.json",report)
                report["failure_manifest"]={**failure_meta,"path":str((result_root/"manifest.json").relative_to(self.root))}
            self.finish_failure(attempt,report.get("status","operational_failed"),
                                "Verification did not pass all required checks.",report)
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
