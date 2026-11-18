from collections import defaultdict

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db.models import Count, F, Q, Window
from django.db.models.functions import RowNumber
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_POST, require_safe

from . import control
from .forms import LaunchForm, ScheduleForm, SelectionForm
from .models import Artifact, Audit, Control, Run, Schedule
from .polygon_preview import read_boundary


def operator(view):
    view = permission_required("atlas_intake.operate", raise_exception=True)(view)
    view = login_required(login_url="atlas_intake:login")(view)
    return never_cache(view)


def region_tree(regions, selection):
    children = defaultdict(list)
    selected = set(selection)
    for region in sorted(regions, key=lambda entry: (entry["name"].casefold(), entry["id"])):
        children[region.get("parent") or None].append(region)

    def branch(parent, ancestry):
        result = []
        for region in children[parent]:
            names = [*ancestry, region["name"]]
            descendants = branch(region["id"], names)
            checked = region["id"] in selected and bool(region.get("pbf_url"))
            result.append(
                {
                    **region,
                    "children": descendants,
                    "checked": checked,
                    "expand": checked or any(child["expand"] for child in descendants),
                    "search": " ".join([*names, region["id"], region.get("pbf_url") or "POLY only"]),
                }
            )
        return result

    return branch(None, [])


def _selection_form(state, data=None):
    return SelectionForm(
        data,
        catalog_id=state.catalog_id or "",
        regions=state.catalog.regions if state.catalog_id else [],
        selection=state.selection,
    )


def _render_dashboard(request, *, schedule_form=None, status=200):
    state = control.get_control()
    regions = state.catalog.regions if state.catalog_id else []
    next_schedule = state.schedule if state.mode == Control.Mode.AUTOMATIC else None
    pending = next_schedule if next_schedule and next_schedule.status == Schedule.Status.PENDING else None
    initial = {"zone": settings.ATLAS_ZONE}
    if pending:
        initial.update(
            wall_date=pending.wall_date,
            wall_time=pending.wall_time,
            zone=pending.zone,
            offset=pending.offset,
        )

    runs = (
        Run.objects.annotate(
            file_count=Count("artifacts"),
            finished_count=Count(
                "artifacts", filter=Q(artifacts__status__in=[Artifact.Status.COMPLETE, Artifact.Status.EXCEPTED])
            ),
        )
        .order_by("-local_date", "-created_at", "-pk")
    )
    page = Paginator(runs, 30).get_page(request.GET.get("page"))
    return render(
        request,
        "atlas_intake/dashboard.html",
        {
            "state": state,
            "region_tree": region_tree(regions, state.selection),
            "region_count": len(regions),
            "selection_form": _selection_form(state),
            "schedule_form": schedule_form if schedule_form is not None else ScheduleForm(initial=initial),
            "pending": pending,
            "schedule_history": Schedule.objects.exclude(status=Schedule.Status.PENDING).order_by("-created_at", "-pk")[:8],
            "launch_form": LaunchForm(),
            "run_page": page,
            "activity": Audit.objects.filter(run__isnull=True).order_by("-created_at", "-pk")[:12],
            "atlas_zone": settings.ATLAS_ZONE,
        },
        status=status,
    )


def _invalid_action(request, error):
    for message in error.messages:
        messages.error(request, message)
    return _render_dashboard(request, status=400)


@operator
@require_safe
def dashboard(request):
    return _render_dashboard(request)


@operator
@require_POST
def save_selection(request):
    form = _selection_form(control.get_control(), request.POST)
    if not form.is_valid():
        return _invalid_action(request, ValidationError(form.errors.as_data()))
    snapshot = form.cleaned_data["selection_token"]
    try:
        control.set_selection(
            form.selected_ids(),
            request.user.get_username(),
            expected_catalog_id=snapshot["catalog"],
            expected_selection=snapshot["selection"],
        )
    except ValidationError as exc:
        return _invalid_action(request, exc)
    messages.success(request, "PBF selection saved.")
    return redirect("atlas_intake:dashboard")


@operator
@require_POST
def schedule(request):
    form = ScheduleForm(request.POST)
    if form.is_valid():
        try:
            control.save_schedule(**form.cleaned_data, actor=request.user.get_username())
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            messages.success(request, "Automatic retrieval scheduled.")
            return redirect("atlas_intake:dashboard")
    return _render_dashboard(request, schedule_form=form, status=400)


@operator
@require_POST
def manual_mode(request):
    control.set_manual(request.user.get_username())
    messages.success(request, "Switched to Manual mode.")
    return redirect("atlas_intake:dashboard")


@operator
@require_POST
def refresh_catalog(request):
    control.request_catalog_refresh(request.user.get_username())
    messages.success(request, "Catalog refresh requested.")
    return redirect("atlas_intake:dashboard")


@operator
@require_POST
def launch(request):
    form = LaunchForm(request.POST)
    if not form.is_valid():
        return _invalid_action(request, ValidationError("Reload the panel to start a retrieval."))
    try:
        run = control.launch_manual(str(form.cleaned_data["request_key"]), request.user.get_username())
    except ValidationError as exc:
        return _invalid_action(request, exc)
    return redirect("atlas_intake:run_detail", run_id=run.pk)


def _fallback_boundaries(run, artifacts):
    stale_ids = [
        item.region_id for item in artifacts if item.kind == Artifact.Kind.POLY and item.status != Artifact.Status.COMPLETE
    ]
    candidates = (
        Artifact.objects.filter(
            region_id__in=stale_ids,
            kind=Artifact.Kind.POLY,
            status=Artifact.Status.COMPLETE,
            finished_at__isnull=False,
        )
        .exclude(run=run)
        .select_related("run")
        .annotate(
            newest=Window(
                expression=RowNumber(),
                partition_by=F("region_id"),
                order_by=[F("finished_at").desc(), F("pk").desc()],
            )
        )
        .filter(newest=1)
    )
    return {artifact.region_id: artifact for artifact in candidates}


@operator
@require_safe
def run_detail(request, run_id):
    run = get_object_or_404(Run.objects.select_related("schedule"), pk=run_id)
    artifacts = list(run.artifacts.prefetch_related("attempts").order_by("region_id", "kind"))
    stale = _fallback_boundaries(run, artifacts)
    records = [
        {"artifact": artifact, "stale": stale.get(artifact.region_id) if artifact.kind == Artifact.Kind.POLY else None}
        for artifact in artifacts
    ]
    activity = Paginator(Audit.objects.filter(run=run).order_by("-created_at", "-pk"), 50)
    return render(
        request,
        "atlas_intake/run.html",
        {
            "run": run,
            "records": records,
            "finished_count": sum(
                item.status in (Artifact.Status.COMPLETE, Artifact.Status.EXCEPTED) for item in artifacts
            ),
            "activity_page": activity.get_page(request.GET.get("activity")),
        },
    )


@operator
@require_POST
def retry(request, run_id, artifact_id):
    get_object_or_404(Artifact, run_id=run_id, pk=artifact_id)
    try:
        control.retry_artifact(run_id, artifact_id, request.user.get_username())
    except ValidationError as exc:
        for message in exc.messages:
            messages.error(request, message)
    else:
        messages.success(request, "Retry requested.")
    return redirect("atlas_intake:run_detail", run_id=run_id)


@operator
@require_safe
def boundary(request, run_id, artifact_id):
    artifact = get_object_or_404(
        Artifact, pk=artifact_id, run_id=run_id, kind=Artifact.Kind.POLY, status=Artifact.Status.COMPLETE
    )
    try:
        rings = read_boundary(
            settings.ATLAS_INBOX,
            artifact.relative_path,
            artifact.actual_length,
            artifact.sha256,
        )
    except (OSError, ValueError):
        return JsonResponse({"error": "The stored boundary is unavailable for preview."}, status=409)
    return JsonResponse({"rings": rings})
