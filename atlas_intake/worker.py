import logging
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from time import monotonic
from uuid import uuid4

from django.conf import settings
from django.db import close_old_connections, connection, transaction
from django.db.models import F, Q, Sum
from django.utils import timezone

from .catalog import heartbeat
from .control import audit, lock_control
from .models import Artifact, Attempt, Run
from .provider import Client, ProviderError
from .storage import below, inbox_usage, make_directories, matches, sync_directory

logger = logging.getLogger(__name__)
LEASE = timedelta(minutes=3)
RETRY_DELAYS = (5, 25)
ACTIVE = (Artifact.Status.PENDING, Artifact.Status.TRANSFERRING, Artifact.Status.PREPARED)
SUCCEEDED = (Artifact.Status.COMPLETE, Artifact.Status.EXCEPTED)
STAGE_NAME = re.compile(r"([0-9]+)-([0-9]+)-[0-9a-f]{32}\.part")


class StaleClaim(Exception):
    pass


class Worker:
    def __init__(self, client=None, root=None):
        self.client = client or Client()
        self.root = Path(root or settings.ATLAS_INBOX).resolve(strict=True)
        if not self.root.is_dir():
            raise OSError("Inbox is not a directory.")
        self.staging = below(self.root, ".staging")
        make_directories(self.root, self.staging)
        if self.staging.stat().st_dev != self.root.stat().st_dev:
            raise OSError("Staging and inbox must share a filesystem.")
        self.next_sweep = 0

    @transaction.atomic
    def active_run(self):
        lock_control()
        run = Run.objects.filter(status=Run.Status.RUNNING).order_by("created_at", "pk").first()
        if run is None:
            run = Run.objects.select_for_update().filter(status=Run.Status.QUEUED).order_by("created_at", "pk").first()
            if run:
                run.status = Run.Status.RUNNING
                run.save(update_fields=["status"])
                audit("run.started", "worker", run)
        return run

    @transaction.atomic
    def claim(self, run, artifact_id=None, *, pin_only=False):
        lock_control()
        run = Run.objects.select_for_update().get(pk=run.pk)
        if run.status != Run.Status.RUNNING:
            return None
        if run.artifacts.filter(status=Artifact.Status.TRANSFERRING).count() >= 2:
            return None
        now = timezone.now()
        available = (Artifact.objects.select_for_update().filter(run=run, status=Artifact.Status.PENDING)
                     .filter(Q(retry_at=None) | Q(retry_at__lte=now)))
        if artifact_id:
            available = available.filter(pk=artifact_id)
        artifact = available.order_by("kind", "pk").first()
        if artifact is None:
            return None
        artifact.generation += 1
        artifact.attempt_count += 1
        artifact.status = Artifact.Status.TRANSFERRING
        artifact.lease_until = now + LEASE
        artifact.retry_at = None
        artifact.finished_at = None
        artifact.bytes_received = 0
        artifact.stage_path = "" if pin_only else (
            f".staging/{artifact.pk}-{artifact.generation}-{uuid4().hex}.part"
        )
        artifact.save(update_fields=[
            "generation", "attempt_count", "status", "lease_until", "retry_at", "finished_at",
            "stage_path", "bytes_received",
        ])
        Attempt.objects.create(
            artifact=artifact, generation=artifact.generation, stage_path=artifact.stage_path,
            started_at=now,
        )
        return artifact

    @staticmethod
    def _owned(artifact_id, generation):
        artifact = Artifact.objects.select_for_update().get(pk=artifact_id)
        if (
            artifact.generation != generation or artifact.status != Artifact.Status.TRANSFERRING
            or artifact.lease_until is None or artifact.lease_until <= timezone.now()
        ):
            raise StaleClaim
        return artifact

    @transaction.atomic
    def _save_pin(self, artifact, data, *, complete):
        row = self._owned(artifact.pk, artifact.generation)
        row.resolved_url = data["url"]
        row.resolved_at = row.resolved_at or timezone.now()
        row.expected_length = data["length"]
        row.http_last_modified = data.get("last_modified", "")
        row.pin = data
        row.lease_until = timezone.now() + LEASE
        if complete:
            row.pinned_at = timezone.now()
            row.checksum_status = "pending" if data.get("md5") else "unavailable"
        row.save(update_fields=[
            "resolved_url", "resolved_at", "expected_length", "http_last_modified", "pin",
            "lease_until", "pinned_at", "checksum_status",
        ])
        return row

    def _pin_pbf(self, artifact):
        if artifact.pinned_at:
            return artifact
        if not artifact.resolved_url:
            initial = self.client.resolve_pbf(artifact.requested_url)
            artifact = self._save_pin(artifact, initial, complete=False)
        if artifact.expected_length is not None and artifact.expected_length > artifact.run.limits["pbf"]:
            raise ProviderError("artifact_limit", "The selected PBF exceeds the per-file pilot limit.")
        pin = self.client.pbf_pin(artifact.resolved_url)
        for key in ("url", "length", "etag", "last_modified"):
            if artifact.pin.get(key) and artifact.pin[key] != pin.get(key):
                raise ProviderError("validator_changed", "The dated PBF changed after resolution.")
        if pin["length"] > artifact.run.limits["pbf"]:
            raise ProviderError("artifact_limit", "The selected PBF exceeds the per-file pilot limit.")
        return self._save_pin(artifact, pin, complete=True)

    @transaction.atomic
    def _release_pin(self, artifact):
        row = self._owned(artifact.pk, artifact.generation)
        row.status = Artifact.Status.PENDING
        row.lease_until = None
        row.error_code = row.error = ""
        row.save(update_fields=["status", "lease_until", "error_code", "error"])
        row.attempts.filter(generation=row.generation).update(status="pinned", finished_at=timezone.now())

    def _preflight(self, run):
        unpinned = run.artifacts.filter(kind=Artifact.Kind.PBF, status=Artifact.Status.PENDING, pinned_at=None)
        for artifact_id in unpinned.values_list("pk", flat=True):
            artifact = self.claim(run, artifact_id, pin_only=True)
            if not artifact:
                continue
            try:
                self._release_pin(self._pin_pbf(artifact))
            except ProviderError as exc:
                self.fail(artifact, exc)
                if exc.code == "artifact_limit":
                    self.block_budget(run, "A selected PBF exceeds the per-file pilot limit.")
                    return False
            except StaleClaim:
                continue
            heartbeat()
        if unpinned.exists() or run.artifacts.filter(status=Artifact.Status.TRANSFERRING).exists():
            return False
        known = sum(
            (artifact.actual_length or artifact.expected_length or 0)
            for artifact in run.artifacts.exclude(status__in=(Artifact.Status.UNAVAILABLE, Artifact.Status.EXCEPTED))
        )
        if known > run.limits["run"]:
            self.block_budget(run, "Known artifact sizes exceed the run pilot limit.")
            return False
        Run.objects.filter(pk=run.pk, status=Run.Status.RUNNING).update(preflight_passed=True)
        return True

    @transaction.atomic
    def block_budget(self, run, message):
        row = Run.objects.select_for_update().get(pk=run.pk)
        if row.status != Run.Status.RUNNING:
            return
        row.artifacts.filter(status=Artifact.Status.PENDING).update(
            status=Artifact.Status.FAILED, error_code="run_limit", error=message, retryable=False,
        )
        row.issue = message
        row.save(update_fields=["issue"])
        audit("run.limit_blocked", "worker", row, reason=message)

    @transaction.atomic
    def _reserve(self, artifact):
        lock_control()
        run = Run.objects.select_for_update().get(pk=artifact.run_id)
        row = self._owned(artifact.pk, artifact.generation)
        if run.status != Run.Status.RUNNING:
            raise ProviderError("run_inactive", "The run is no longer active.", retryable=True)
        cap = run.limits[row.kind]
        if row.expected_length is not None and row.expected_length > cap:
            raise ProviderError("artifact_limit", "The artifact exceeds the per-file pilot limit.")
        other = Artifact.objects.exclude(pk=artifact.pk).filter(reserved_bytes__gt=0)
        reserved_for_run = other.filter(run=run).aggregate(total=Sum("reserved_bytes"))["total"] or 0
        completed = run.artifacts.filter(status=Artifact.Status.COMPLETE).aggregate(total=Sum("actual_length"))["total"] or 0
        remaining = run.limits["run"] - completed - reserved_for_run
        budget = row.expected_length if row.expected_length is not None else min(remaining, cap)
        if budget <= 0 or budget > remaining:
            # An outstanding transfer may free a reservation sized from a cap.
            raise ProviderError("run_limit", "The artifact exceeds the remaining run byte budget.",
                                retryable=bool(reserved_for_run))
        block_size = os.statvfs(self.root).f_frsize

        def allocated(size):
            return (size + block_size - 1) // block_size * block_size

        outstanding = 0
        for prior in other.only("stage_path", "reserved_bytes"):
            try:
                staged = below(self.root, prior.stage_path).stat().st_size
            except FileNotFoundError:
                staged = 0
            outstanding += max(allocated(prior.reserved_bytes) - allocated(staged), 0)
        usage = inbox_usage(self.root)
        free = shutil.disk_usage(self.root).free
        projected = outstanding + allocated(budget)
        if usage + projected > run.limits["inbox"] or free - projected < run.limits["free"]:
            raise ProviderError("disk_pressure", "Inbox budget or filesystem free-space reserve would be exceeded.",
                                retryable=True)
        row.reserved_bytes = budget
        row.lease_until = timezone.now() + LEASE
        row.save(update_fields=["reserved_bytes", "lease_until"])
        return budget

    def _transfer(self, artifact):
        try:
            if artifact.kind == Artifact.Kind.PBF:
                artifact = self._pin_pbf(artifact)
            else:
                data = self.client.poly_pin(artifact.requested_url, artifact.sidecar_url)
                artifact = self._save_pin(artifact, data, complete=True)
            limit = self._reserve(artifact)
            stage = below(self.root, artifact.stage_path)
            updated = monotonic()
            last_bytes = 0

            def progress(received):
                nonlocal updated, last_bytes
                now = monotonic()
                if now - updated < 2 and received - last_bytes < 16 * 1024**2:
                    return
                if not Artifact.objects.filter(
                    pk=artifact.pk, generation=artifact.generation, status=Artifact.Status.TRANSFERRING,
                    lease_until__gt=timezone.now(),
                ).update(bytes_received=received, lease_until=timezone.now() + LEASE):
                    raise StaleClaim
                updated, last_bytes = now, received
                heartbeat()

            with stage.open("xb") as output:
                result = self.client.download(artifact.pin, artifact.kind, output, limit, progress)
                output.flush()
                os.fsync(output.fileno())
            sync_directory(stage.parent)
            self.prepare(artifact, result)
        except StaleClaim:
            return
        except ProviderError as exc:
            if artifact.kind == Artifact.Kind.POLY and exc.code == "validator_changed":
                exc = ProviderError(exc.code, str(exc), retryable=True)
            self.fail(artifact, exc)
            return
        except (OSError, ValueError):
            self.fail(artifact, ProviderError("storage_io", "The inbox or staging file could not be accessed.",
                                              retryable=True))
            return
        self.publish(artifact.pk, artifact.generation)

    @transaction.atomic
    def prepare(self, artifact, result):
        row = self._owned(artifact.pk, artifact.generation)
        if result["length"] > row.reserved_bytes:
            raise ProviderError("artifact_limit", "Transfer exceeded its reserved capacity.")
        row.intent = {
            **result, "generation": row.generation, "target": row.relative_path, "stage": row.stage_path,
        }
        row.status = Artifact.Status.PREPARED
        row.bytes_received = result["length"]
        row.save(update_fields=["intent", "status", "bytes_received"])
        row.attempts.filter(generation=row.generation).update(status="prepared")

    def install_link(self, row):
        target = below(self.root, row.intent["target"])
        stage = below(self.root, row.intent["stage"])
        length, digest = row.intent["length"], row.intent["sha256"]
        make_directories(self.root, target.parent)
        if target.parent.stat().st_dev != self.staging.stat().st_dev:
            raise ValueError("Publication would cross inbox filesystems.")
        if not target.exists():
            if not matches(stage, length, digest):
                return False
            try:
                os.link(stage, target, follow_symlinks=False)
            except FileExistsError:
                pass
        if not matches(target, length, digest):
            return False
        sync_directory(target.parent)
        return True

    @transaction.atomic
    def publish(self, artifact_id, generation):
        run_id = Artifact.objects.values_list("run_id", flat=True).get(pk=artifact_id)
        run = Run.objects.select_for_update().get(pk=run_id)
        row = Artifact.objects.select_for_update().get(pk=artifact_id)
        if (
            row.status != Artifact.Status.PREPARED or row.generation != generation
            or row.intent.get("generation") != generation or row.intent.get("target") != row.relative_path
            or row.intent.get("stage") != row.stage_path
        ):
            return False
        try:
            valid = self.install_link(row)
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError, ValueError):
            valid = False
        except OSError:
            row.retry_at = timezone.now() + timedelta(seconds=30)
            row.error_code = "publication_io"
            row.error = "Publication could not finish. The verified staging file is retained for recovery."
            row.save(update_fields=["retry_at", "error_code", "error"])
            if not row.attempts.filter(generation=generation, status="publication_io").exists():
                row.attempts.filter(generation=generation).update(status="publication_io")
                audit("artifact.publication_io", "worker", run, artifact=row.pk)
            logger.warning("Publication I/O failed for artifact %s; intent remains prepared.", artifact_id)
            return False
        if not valid:
            self._integrity_failure(run, row, "Publication bytes conflict with the committed intent.")
            return False
        stage = below(self.root, row.stage_path)
        row.actual_length = row.intent["length"]
        row.sha256 = row.intent["sha256"]
        row.http_last_modified = row.intent.get("last_modified") or row.http_last_modified
        row.checksum_status = "verified" if row.pin.get("md5") else "unavailable"
        row.status = Artifact.Status.COMPLETE
        row.finished_at = row.integrity_checked_at = timezone.now()
        row.reserved_bytes = 0
        row.lease_until = None
        row.retryable = False
        row.retry_at = None
        row.error = row.error_code = ""
        row.save(update_fields=[
            "actual_length", "sha256", "http_last_modified", "checksum_status", "status", "finished_at",
            "integrity_checked_at", "reserved_bytes", "lease_until", "retryable", "retry_at", "error", "error_code",
        ])
        row.attempts.filter(generation=generation).update(status="complete", finished_at=row.finished_at)
        audit("artifact.completed", "worker", run, artifact=row.pk, region=row.region_id, kind=row.kind)
        transaction.on_commit(lambda: self._remove_stage(stage), robust=True)
        return True

    @staticmethod
    def _remove_stage(stage):
        stage.unlink(missing_ok=True)
        sync_directory(stage.parent)

    @staticmethod
    def _integrity_failure(run, row, reason):
        row.status = Artifact.Status.INTEGRITY_FAILED
        row.error_code = "integrity_failed"
        row.error = reason
        row.reserved_bytes = 0
        row.lease_until = None
        row.retryable = False
        row.save(update_fields=["status", "error_code", "error", "reserved_bytes", "lease_until", "retryable"])
        row.attempts.filter(generation=row.generation, finished_at=None).update(
            status="integrity_failed", finished_at=timezone.now(), error=reason,
        )
        run.status = Run.Status.INTEGRITY_FAILED
        run.issue = reason
        run.save(update_fields=["status", "issue"])
        audit("artifact.integrity_failed", "worker", run, artifact=row.pk, reason=reason)

    @transaction.atomic
    def fail(self, artifact, error, *, expired_only=False):
        run = Run.objects.select_for_update().get(pk=artifact.run_id)
        row = Artifact.objects.select_for_update().get(pk=artifact.pk)
        if row.status != Artifact.Status.TRANSFERRING or row.generation != artifact.generation:
            return
        now = timezone.now()
        if expired_only and (row.lease_until is None or row.lease_until > now):
            return
        recent = row.attempts.filter(generation__lt=row.generation).order_by("-generation").values_list("status", flat=True)
        streak = 0
        for status in recent[:len(RETRY_DELAYS)]:
            if status != "auto_retry":
                break
            streak += 1
        retry_at = now + timedelta(seconds=RETRY_DELAYS[streak]) if error.retryable and streak < len(RETRY_DELAYS) else None
        row.status = Artifact.Status.PENDING if retry_at else Artifact.Status.FAILED
        row.retry_at = retry_at
        row.error = str(error)
        row.error_code = error.code
        row.retryable = error.retryable
        row.lease_until = None
        row.reserved_bytes = 0
        row.finished_at = None if retry_at else now
        if error.code == "sidecar_missing":
            row.checksum_status = "unavailable"
        elif error.code in {"checksum_mismatch", "invalid_sidecar"}:
            row.checksum_status = "failed"
        row.save(update_fields=[
            "status", "retry_at", "error", "error_code", "retryable", "lease_until",
            "reserved_bytes", "finished_at", "checksum_status",
        ])
        row.attempts.filter(generation=artifact.generation).update(
            status="auto_retry" if retry_at else "failed", finished_at=now, error=str(error),
        )
        audit("artifact.failed", "worker", run=run, artifact=row.pk, code=error.code,
              attempt=row.generation, retry_at=retry_at.isoformat() if retry_at else None)

    def reclaim_expired(self):
        expired = Artifact.objects.filter(status=Artifact.Status.TRANSFERRING, lease_until__lte=timezone.now())
        for artifact in expired.order_by("pk")[:32]:
            self.fail(artifact, ProviderError("lease_expired", "Worker claim expired before publication.",
                                              retryable=True), expired_only=True)

    def recover_publications(self):
        ready = Artifact.objects.filter(status=Artifact.Status.PREPARED).filter(
            Q(retry_at=None) | Q(retry_at__lte=timezone.now()),
        )
        for artifact_id, generation in ready.order_by("pk").values_list("pk", "generation")[:8]:
            self.publish(artifact_id, generation)
            heartbeat()

    def verify_artifact(self, artifact_id):
        row = Artifact.objects.get(pk=artifact_id)
        if row.status != Artifact.Status.COMPLETE:
            return
        try:
            valid = matches(below(self.root, row.relative_path), row.actual_length, row.sha256)
        except (OSError, ValueError):
            valid = False
        with transaction.atomic():
            run = Run.objects.select_for_update().get(pk=row.run_id)
            row = Artifact.objects.select_for_update().get(pk=artifact_id)
            if row.status != Artifact.Status.COMPLETE:
                return
            if not valid:
                self._integrity_failure(run, row, "Completed inbox file is missing or differs from its recorded identity.")
            else:
                row.integrity_checked_at = timezone.now()
                row.save(update_fields=["integrity_checked_at"])

    def integrity_tick(self, startup):
        cutoff = max(startup, timezone.now() - timedelta(hours=24))
        for artifact_id in Artifact.objects.filter(status=Artifact.Status.COMPLETE).filter(
            Q(integrity_checked_at__lte=cutoff) | Q(integrity_checked_at=None)
        ).order_by(F("integrity_checked_at").asc(nulls_first=True), "pk").values_list("pk", flat=True)[:8]:
            self.verify_artifact(artifact_id)
            heartbeat()

    @transaction.atomic
    def clean_staging(self):
        cutoff = timezone.now().timestamp() - 86400
        removed = 0
        for stage in self.staging.iterdir():
            match = STAGE_NAME.fullmatch(stage.name)
            if not match or stage.is_symlink() or not stage.is_file() or stage.stat().st_mtime > cutoff:
                continue
            row = Artifact.objects.select_for_update().filter(pk=int(match[1])).first()
            relative = stage.relative_to(self.root).as_posix()
            if row and row.stage_path == relative and (
                row.status == Artifact.Status.PREPARED or
                (row.status == Artifact.Status.TRANSFERRING and row.lease_until > timezone.now())
            ):
                continue
            stage.unlink(missing_ok=True)
            removed += 1
            if removed >= 32:
                break
        if removed:
            sync_directory(self.staging)

    @transaction.atomic
    def settle(self, run):
        row = Run.objects.select_for_update().get(pk=run.pk)
        if row.status != Run.Status.RUNNING or row.artifacts.filter(status__in=ACTIVE).exists():
            return
        if row.artifacts.exclude(status__in=SUCCEEDED).exists():
            row.status = Run.Status.INCOMPLETE
            row.issue = row.issue or "One or more frozen retrieval intents remain incomplete."
        else:
            row.status = Run.Status.SEALED
            row.sealed_at = timezone.now()
        row.save(update_fields=["status", "sealed_at", "issue"])
        audit(f"run.{row.status}", "worker", row)

    def _in_thread(self, artifact):
        close_old_connections()
        try:
            self._transfer(artifact)
        finally:
            connection.close()

    def work_tick(self, *, parallel=True, transfers=True):
        run = self.active_run()
        if not run:
            return False
        if not run.preflight_passed and not self._preflight(run):
            self.settle(run)
            return False
        if transfers:
            artifacts = []
            for _ in range(2 if parallel else 1):
                artifact = self.claim(run)
                if artifact:
                    artifacts.append(artifact)
            if parallel and artifacts:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(self._in_thread, artifacts))
            else:
                for artifact in artifacts:
                    self._transfer(artifact)
            self.settle(run)
            return bool(artifacts)
        return False
