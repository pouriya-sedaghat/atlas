import json
from pathlib import Path, PurePosixPath
import re
from uuid import uuid4

from django.conf import settings
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST, require_safe

from atlas_intake.models import Run
from atlas_intake.views import operator
from . import control
from .models import VerificationAttempt
from .manifest import validate_manifest
from .diagnostics import diagnostic_json
from .storage import read_checked


def _errors(error):
    return error.messages if isinstance(error, ValidationError) else ["The published verification result is unavailable or has changed."]


def _run_context(run):
    artifacts = list(run.artifacts.order_by("region_id", "kind", "pk"))
    selected = set(run.selection)
    context = {
        "run": run,
        "artifacts": artifacts,
        "boundary_only": sorted(region["id"] for region in run.catalog.regions if region["id"] not in selected),
        "exceptions": [artifact for artifact in artifacts if artifact.exception],
        "request_key": str(uuid4()),
        "attempts": run.verifications.order_by("-created_at", "-pk")[:50],
    }
    try:
        control.frozen_inputs(run)
        context["eligible"] = True
    except ValidationError as error:
        context["eligibility_error"] = " ".join(error.messages)
    return context


@operator
@require_safe
def index(request):
    runs = Run.objects.select_related("catalog").order_by("-local_date", "-created_at", "-pk")
    return render(request, "atlas_verification/index.html", {
        "run_page": Paginator(runs, 30).get_page(request.GET.get("page")),
    })


@operator
@require_safe
def run_detail(request, run_id):
    run = get_object_or_404(Run.objects.select_related("catalog"), pk=run_id)
    return render(request, "atlas_verification/run.html", _run_context(run))


@operator
@require_POST
def request_verification(request, run_id):
    run = get_object_or_404(Run.objects.select_related("catalog"), pk=run_id)
    try:
        attempt = control.request_verification(run.pk, request.POST.get("request_key", ""), request.user.get_username())
    except ValidationError as error:
        for message in error.messages:
            messages.error(request, message)
        return render(request, "atlas_verification/run.html", _run_context(run), status=400)
    return redirect("verification:attempt_detail", attempt_id=attempt.pk)


@operator
@require_POST
def retry_verification(request, attempt_id):
    attempt = get_object_or_404(VerificationAttempt, pk=attempt_id)
    try:
        attempt = control.retry_verification(attempt.pk, request.user.get_username())
    except ValidationError as error:
        for message in error.messages:
            messages.error(request, message)
        return _render_attempt(request, attempt, status=400)
    return redirect("verification:attempt_detail", attempt_id=attempt.pk)


def _render_attempt(request, attempt, status=200):
    manifest = None
    manifest_error = ""
    if attempt.successful:
        try:
            control.assert_current(attempt)
            manifest = control.read_manifest(attempt)
        except (ValidationError, OSError, ValueError) as error:
            manifest_error = " ".join(_errors(error))
    regional = []
    for record in attempt.summary.get("regions", []):
        match = re.fullmatch(r"regions/([a-f0-9]{64})/manifest\.json", record.get("path", ""))
        regional.append({**record, "key": match[1] if match else ""})
    executions = list(attempt.executions.order_by("-generation"))
    for execution in executions:
        execution.report_diagnostic = diagnostic_json(execution.report)
    return render(request, "atlas_verification/attempt.html", {
        "attempt": attempt,
        "snapshot": attempt.snapshot,
        "progress_json": diagnostic_json(attempt.progress),
        "summary_json": diagnostic_json(attempt.summary),
        "tools_json": diagnostic_json(attempt.tools),
        "manifest": manifest,
        "manifest_json": diagnostic_json(manifest) if manifest else "",
        "manifest_error": manifest_error,
        "handoff_eligible": bool(manifest and attempt.build_eligible and manifest.get("build_eligible") is True),
        "executions": executions,
        "regional_results": regional,
    }, status=status)


@operator
@require_safe
def attempt_detail(request, attempt_id):
    attempt = get_object_or_404(VerificationAttempt.objects.select_related("run"), pk=attempt_id)
    return _render_attempt(request, attempt)


@operator
@require_safe
def manifest(request, attempt_id):
    attempt = get_object_or_404(VerificationAttempt, pk=attempt_id)
    try:
        control.assert_current(attempt)
        control.read_manifest(attempt)
        document = read_checked(Path(settings.ATLAS_VERIFICATION_ROOT), attempt.manifest_path,
                                attempt.manifest_sha256, 4 * 1024**2)
    except (ValidationError, OSError, ValueError) as error:
        return JsonResponse({"errors": _errors(error)}, status=409)
    response = HttpResponse(document, content_type="application/json")
    response["Content-Disposition"] = f'inline; filename="{attempt.pk}-manifest.json"'
    return response


@operator
@require_safe
def region_manifest(request, attempt_id, region_key):
    attempt = get_object_or_404(VerificationAttempt, pk=attempt_id)
    try:
        control.assert_current(attempt)
        batch = control.read_manifest(attempt)
        relative = f"regions/{region_key}/manifest.json"
        entry = next((item for item in batch.get("regions", []) if item.get("path") == relative), None)
        if entry is None:
            raise Http404("The region is not part of this verification result.")
        path = (PurePosixPath(attempt.manifest_path).parent / relative).as_posix()
        data = read_checked(Path(settings.ATLAS_VERIFICATION_ROOT), path, entry["sha256"], 4 * 1024**2)
        report = json.loads(data)
        validate_manifest("region", report)
        if (report.get("schema_version") != 1 or report.get("policy_version") != control.POLICY_VERSION
                or report.get("region_id") != entry["region_id"]):
            raise ValidationError("The regional verification manifest identity or version is unsupported.")
    except (ValidationError, OSError, ValueError) as error:
        return JsonResponse({"errors": _errors(error)}, status=409)
    return render(request, "atlas_verification/region.html", {
        "attempt": attempt, "region": report, "manifest_sha256": entry["sha256"],
        "report_json": diagnostic_json(report),
    })
