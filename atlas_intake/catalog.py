import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from .control import audit, lock_control
from .models import CatalogRevision, Control
from .provider import ProviderError


def heartbeat():
    Control.objects.filter(pk=1).update(worker_heartbeat=timezone.now())


@transaction.atomic
def due_refresh():
    control = lock_control()
    now = timezone.now()
    interval = timedelta(days=1) if control.catalog_id and not control.catalog_error else timedelta(minutes=5)
    if (
        not control.catalog_refresh_requested and control.catalog_checked_at
        and now - control.catalog_checked_at < interval
    ):
        return False
    return True


def _mapping_key(region):
    return json.dumps([region["id"], region.get("pbf_url"), region.get("poly_mapping"),
                       region.get("poly_exception")], sort_keys=True)


def refresh_catalog(client):
    try:
        source_digest, regions = client.catalog()
    except ProviderError as exc:
        with transaction.atomic():
            control = lock_control()
            control.catalog_error = str(exc)
            control.catalog_refresh_requested = False
            control.catalog_checked_at = timezone.now()
            control.save(update_fields=["catalog_error", "catalog_refresh_requested", "catalog_checked_at"])
            audit("catalog.failed", code=exc.code)
        return None

    current = Control.objects.select_related("catalog").get(pk=1)
    previous = current.catalog
    cache = {
        _mapping_key(row): row for row in previous.regions
        if row.get("poly_url") or row.get("exception")
    } if previous and previous.source_digest == source_digest and not current.catalog_refresh_requested else {}

    def resolve(region):
        row = dict(region)
        key = _mapping_key(row)
        exception = row.get("poly_exception")
        if exception:
            row.update(poly_url="", sidecar_url="", exception=exception)
        elif key in cache:
            row.update(poly_url=cache[key]["poly_url"], sidecar_url=cache[key].get("sidecar_url", ""))
        else:
            try:
                url, sidecar = client.discover_poly(row)
                row.update(poly_url=url, sidecar_url=sidecar)
            except ProviderError as exc:
                row.update(poly_url="", sidecar_url="", poly_error=str(exc), poly_error_code=exc.code)
        return row

    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for index, row in enumerate(pool.map(resolve, regions), start=1):
            results.append(row)
            if index % 8 == 0:
                heartbeat()

    results.sort(key=lambda row: row["id"])
    digest = hashlib.sha256(
        json.dumps([source_digest, results], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with transaction.atomic():
        control = lock_control()
        revision, _ = CatalogRevision.objects.get_or_create(
            pk=digest, defaults={"source_digest": source_digest, "regions": results},
        )
        control.catalog = revision
        control.catalog_error = ""
        control.catalog_refresh_requested = False
        control.catalog_checked_at = timezone.now()
        control.save(update_fields=["catalog", "catalog_error", "catalog_refresh_requested", "catalog_checked_at"])
        audit(
            "catalog.validated", revision=digest, regions=len(results),
            unresolved=sum(not row.get("poly_url") and not row.get("exception") for row in results),
        )
    return revision
