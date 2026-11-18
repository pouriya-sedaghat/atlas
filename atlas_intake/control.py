from datetime import UTC, datetime, timedelta
from hashlib import sha256
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Artifact, Audit, Control, Run, Schedule


def get_control():
    return Control.objects.get_or_create(pk=1)[0]


def lock_control():
    get_control()
    return Control.objects.select_for_update().get(pk=1)


def audit(action, actor="scheduler", run=None, **detail):
    Audit.objects.create(action=action, actor=actor, run=run, detail=detail)


def resolve_wall(wall_date, wall_time, zone, offset=""):
    try:
        tz = ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise ValidationError("Enter a valid IANA timezone.") from exc
    wall = datetime.combine(wall_date, wall_time)
    if wall.tzinfo is not None:
        raise ValidationError("Enter a local time and set the UTC offset separately.")
    candidates = {}
    for fold in (0, 1):
        zoned = wall.replace(tzinfo=tz, fold=fold)
        instant = zoned.astimezone(UTC)
        if instant.astimezone(tz).replace(tzinfo=None) == wall:
            raw = zoned.strftime("%z")
            label = raw[:3] + ":" + raw[3:]
            candidates[label] = instant
    if not candidates:
        raise ValidationError("This time does not exist in the selected timezone.")
    if offset:
        if offset not in candidates:
            raise ValidationError(f"Enter an applicable UTC offset ({', '.join(candidates)}).")
        return candidates[offset]
    if len(candidates) > 1:
        raise ValidationError(f"Choose a UTC offset for this time ({', '.join(candidates)}).")
    return next(iter(candidates.values()))


@transaction.atomic
def set_selection(ids, actor, *, expected_catalog_id=None, expected_selection=None):
    control = lock_control()
    if expected_catalog_id is not None and (control.catalog_id or "") != expected_catalog_id:
        raise ValidationError("The catalog changed. Review the refreshed selection and try again.")
    if expected_selection is not None and control.selection != expected_selection:
        raise ValidationError("The saved selection changed. Reload the page and try again.")
    available = {region["id"] for region in control.catalog.regions if region.get("pbf_url")} if control.catalog else set()
    selected = sorted(set(ids))
    if not set(selected) <= available.union(control.selection):
        raise ValidationError("The selection contains an unknown or unavailable PBF.")
    control.selection = selected
    control.save(update_fields=["selection"])
    audit("selection.saved", actor, pbf_ids=selected)


def supersede(control, actor):
    if control.schedule_id and Schedule.objects.filter(
        pk=control.schedule_id, status=Schedule.Status.PENDING,
    ).update(status=Schedule.Status.SUPERSEDED):
        audit("schedule.superseded", actor, schedule=str(control.schedule_id))


@transaction.atomic
def save_schedule(wall_date, wall_time, zone, offset, actor):
    due = resolve_wall(wall_date, wall_time, zone, offset)
    control = lock_control()
    supersede(control, actor)
    schedule = Schedule.objects.create(
        wall_date=wall_date, wall_time=wall_time, zone=zone, offset=offset or "",
        due_at=due, selection=control.selection,
    )
    control.mode = Control.Mode.AUTOMATIC
    control.schedule = schedule
    control.save(update_fields=["mode", "schedule"])
    audit("schedule.saved", actor, schedule=str(schedule.pk), due_at=due.isoformat(), zone=zone)
    return schedule


@transaction.atomic
def set_manual(actor):
    control = lock_control()
    supersede(control, actor)
    control.mode = Control.Mode.MANUAL
    control.save(update_fields=["mode"])
    audit("mode.manual", actor)


@transaction.atomic
def request_catalog_refresh(actor):
    control = lock_control()
    control.catalog_refresh_requested = True
    control.save(update_fields=["catalog_refresh_requested"])
    audit("catalog.requested", actor)


def _artifact(run, region, kind, url):
    extension = "osm.pbf" if kind == Artifact.Kind.PBF else "poly"
    hierarchy = region["path"]
    stem = hierarchy.rsplit("/", 1)[-1]
    return Artifact(
        run=run, region_id=region["id"], region_name=region["name"], kind=kind,
        requested_url=url,
        relative_path=f"{hierarchy}/{run.local_date}/{run.pk}/{stem}.{extension}",
    )


def _new_run(control, key, origin, actor, now, schedule=None):
    if not control.catalog_id:
        raise ValidationError("A validated catalog is required before dispatch.")
    zone = schedule.zone if schedule else settings.ATLAS_ZONE
    selection = schedule.selection if schedule else control.selection
    run = Run.objects.create(
        catalog=control.catalog, request_key=key, origin=origin, schedule=schedule,
        selection=selection, limits=dict(settings.ATLAS_LIMITS), actor=actor, zone=zone,
        created_at=now, local_date=now.astimezone(ZoneInfo(zone)).date(),
    )
    existing = {}
    artifacts = []
    for region in control.catalog.regions:
        existing[region["id"]] = region
        poly = _artifact(run, region, Artifact.Kind.POLY, region.get("poly_url", ""))
        poly.sidecar_url = region.get("sidecar_url", "")
        if not poly.requested_url:
            poly.exception = region.get("exception", {})
            poly.status = Artifact.Status.EXCEPTED if poly.exception else Artifact.Status.UNAVAILABLE
            poly.error = poly.exception.get("reason") or region.get("poly_error") or "No vetted POLY URL for this revision."
            poly.error_code = "poly_excepted" if poly.exception else region.get("poly_error_code", "poly_unresolved")
        artifacts.append(poly)

    for region_id in selection:
        region = existing.get(region_id)
        if region and region.get("pbf_url"):
            artifacts.append(_artifact(run, region, Artifact.Kind.PBF, region["pbf_url"]))
        else:
            artifacts.append(Artifact(
                run=run, region_id=region_id, region_name=region["name"] if region else region_id,
                kind=Artifact.Kind.PBF, status=Artifact.Status.UNAVAILABLE,
                error_code="pbf_unavailable", error="Selected PBF is unavailable in the frozen catalog.",
            ))

    Artifact.objects.bulk_create(artifacts)
    audit("run.created", actor, run, catalog=run.catalog_id, origin=origin, zone=zone, selected=selection)
    audit_rows = [
        Audit(run=run, actor=actor, action="poly.exception_applied", detail={
            "region": artifact.region_id, "exception": artifact.exception,
        })
        for artifact in artifacts if artifact.status == Artifact.Status.EXCEPTED
    ]
    Audit.objects.bulk_create(audit_rows)
    return run


@transaction.atomic
def launch_manual(request_key, actor):
    if not isinstance(request_key, str) or not request_key or len(request_key) > 96:
        raise ValidationError("Invalid launch request key. Reload the page.")
    control = lock_control()
    key = f"manual:{actor}:{request_key}"
    # Usernames and request keys can be long. Store a stable bounded key.
    key = "manual:" + sha256(key.encode()).hexdigest()
    previous = Run.objects.filter(request_key=key).first()
    if previous:
        return previous
    if control.mode != Control.Mode.MANUAL:
        raise ValidationError("Switch to Manual mode before starting a new manual retrieval.")
    return _new_run(control, key, Control.Mode.MANUAL, actor, timezone.now())


@transaction.atomic
def dispatch_due(now=None):
    control = lock_control()
    if control.mode != Control.Mode.AUTOMATIC or not control.schedule_id:
        return None
    schedule = control.schedule
    now = now or timezone.now()
    if schedule.status != Schedule.Status.PENDING or now < schedule.due_at:
        return None
    if now >= schedule.due_at + timedelta(hours=24):
        schedule.status = Schedule.Status.MISSED
        schedule.save(update_fields=["status"])
        audit("schedule.missed", schedule=str(schedule.pk), reason="24-hour dispatch window closed")
        return None
    if not control.catalog_id:
        return None
    run = _new_run(control, f"schedule:{schedule.pk}", Control.Mode.AUTOMATIC, "scheduler", now, schedule)
    schedule.status = Schedule.Status.DISPATCHED
    schedule.save(update_fields=["status"])
    audit("schedule.dispatched", "scheduler", run, schedule=str(schedule.pk))
    return run


@transaction.atomic
def retry_artifact(run_id, artifact_id, actor):
    lock_control()
    run = Run.objects.select_for_update().get(pk=run_id)
    artifact = Artifact.objects.select_for_update().get(pk=artifact_id, run=run)
    if artifact.status in {Artifact.Status.PENDING, Artifact.Status.TRANSFERRING, Artifact.Status.PREPARED}:
        return artifact
    if run.status in {Run.Status.SEALED, Run.Status.INTEGRITY_FAILED} or not artifact.retryable:
        raise ValidationError("This artifact is ineligible for retry.")
    if artifact.status == Artifact.Status.PUBLICATION_PAUSED:
        artifact.status = Artifact.Status.PREPARED
        artifact.publication_failures = 0
        artifact.retry_at = None
        artifact.retryable = False
        artifact.error_code = artifact.error = ""
        artifact.save(update_fields=[
            "status", "publication_failures", "retry_at", "retryable", "error_code", "error",
        ])
        artifact.attempts.filter(generation=artifact.generation).update(status="prepared", error="")
        audit("artifact.publication_resumed", actor, run, artifact=artifact.pk, generation=artifact.generation)
        return artifact
    if artifact.status != Artifact.Status.FAILED:
        raise ValidationError("This artifact is ineligible for retry.")
    artifact.status = Artifact.Status.PENDING
    artifact.retry_at = None
    artifact.error = artifact.error_code = ""
    artifact.finished_at = None
    artifact.save(update_fields=["status", "retry_at", "error", "error_code", "finished_at"])
    if run.status == Run.Status.INCOMPLETE:
        run.status = Run.Status.QUEUED
        run.preflight_passed = False
        run.issue = ""
        run.save(update_fields=["status", "preflight_passed", "issue"])
    audit("artifact.retry_requested", actor, run, artifact=artifact.pk, region=artifact.region_id, kind=artifact.kind)
    return artifact
