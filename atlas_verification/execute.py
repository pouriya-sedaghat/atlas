"""Private child execution. The parent owns claims, resource enforcement and publication."""
import hashlib
import json
import os
import resource
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

from django.core.exceptions import ValidationError

from .control import POLICY_VERSION, canonical
from .storage import spool, write_json
from .manifest import validate_manifest
from atlas_intake.storage import inbox_usage, sync_directory


def tool_versions():
    import django
    import google.protobuf
    import zstandard
    from django.contrib.gis.geos import geos_version
    version = subprocess.run(["osmium", "--version"], capture_output=True, text=True, timeout=5, check=True)
    return {
        "python": sys.version.split()[0], "django": django.get_version(),
        "protobuf": google.protobuf.__version__, "zstandard": zstandard.__version__,
        "geos": geos_version().decode(), "osmium": version.stdout.splitlines()[:4],
        "decoder": "atlas-proto2-v1", "policy": POLICY_VERSION,
        "source_schema_sha256": {
            name:hashlib.sha256((Path(__file__).parent/"proto"/name).read_bytes()).hexdigest()
            for name in ("osmformat.proto","fileformat.proto")
        },
    }


def osmium_check(source, expected, directory):
    output_path = directory/"osmium.json"
    error_path = directory/"osmium.stderr"
    with output_path.open("xb") as out, error_path.open("xb") as err:
        result = subprocess.run(
            ["osmium", "fileinfo", "--input-format=pbf", "--extended", "--json", "--no-progress", str(source)],
            stdout=out, stderr=err, timeout=1800,
        )
    if result.returncode:
        message=error_path.read_bytes()[:4096].decode("utf-8","replace")
        if not sum(int(value) for value in expected.values()) and "Invalid location" in message:
            return {
                "status":"unsupported_profile","counts":None,
                "reason":"Pinned Osmium JSON inspection cannot represent empty input bounds.",
                "exit_code":result.returncode,
            }
        raise RuntimeError("Mandatory Osmium full-file reconciliation could not finish.")
    if output_path.stat().st_size > 1024**2:
        raise RuntimeError("Mandatory Osmium output exceeded its bounded size.")
    data = json.loads(output_path.read_bytes())
    observed = data["data"]["count"]
    for kind in ("nodes", "ways", "relations"):
        if int(observed[kind]) != int(expected[kind]):
            raise ValidationError("Osmium and the authoritative decoder disagree on object counts.")
    error_path.unlink()
    return {"counts": {kind: int(observed[kind]) for kind in ("nodes","ways","relations")},
            "sha256": hashlib.sha256(output_path.read_bytes()).hexdigest()}



def checkpoint(directory, snapshot, regions, tools, completed):
    counts={"nodes":0,"ways":0,"relations":0}
    for region in regions.values():
        for kind,value in region.get("checks",{}).get("pbf",{}).get("counts",{}).items():
            counts[kind]+=int(value)
    partial={
        "schema_version":1,"policy_version":POLICY_VERSION,"run_id":snapshot["run_id"],
        "catalog_digest":snapshot["catalog_digest"],"regions":[],"tools":tools,
        "status":"operational_failed","build_eligible":False,"counts":counts,
        "checks_completed":sorted(completed),
        "checks_incomplete":[a["artifact_id"] for a in snapshot["artifacts"] if a["artifact_id"] not in completed],
        "region_results":[{"region_id":name,"checks":regions[name]["checks"]} for name in sorted(regions)],
    }
    temporary=directory/"partial-next.json"
    write_json(temporary,partial)
    os.replace(temporary,directory/"partial.json")
    sync_directory(directory)



def run(snapshot, directory, progress):
    from .decoder import scan_pbf
    from .geometry import verify_poly

    start = monotonic()
    result_root = directory/"result"
    spool_root = directory/"spool"
    result_root.mkdir(mode=0o750)
    spool_root.mkdir(mode=0o700)
    tools = tool_versions()
    regions = {}
    blocking = []
    warnings = []
    completed = set()
    checkpoint(directory,snapshot,regions,tools,completed)
    for artifact in snapshot["artifacts"]:
        region = artifact["region_id"]
        key = hashlib.sha256(region.encode()).hexdigest()
        folder = result_root/"regions"/key
        folder.mkdir(mode=0o750, parents=True, exist_ok=True)
        report = regions.setdefault(region, {
            "schema_version":1,"policy_version":POLICY_VERSION,"region_id":region,
            "input_fingerprint":None,"inputs":[],"checks":{},"outputs":[],
        })
        report["inputs"].append(artifact)
        if artifact["exception"]:
            report["checks"][artifact["kind"]] = {"status":"excepted","exception":artifact["exception"]}
            completed.add(artifact["artifact_id"])
            checkpoint(directory,snapshot,regions,tools,completed)
            continue
        progress({"phase":"input_identity","region":region,"kind":artifact["kind"]})
        local = spool_root/str(artifact["artifact_id"])
        try:
            spool(Path(os.environ.get("ATLAS_INBOX","/inbox")), artifact, local, progress)
        except ValidationError as error:
            check = {"status":"input_invalid","reasons":[{"code":"input_integrity","message":str(error)[:500]}]}
        else:
            if artifact["kind"] == "poly":
                check = verify_poly(local, folder, progress)
            else:
                check = scan_pbf(local, folder, progress)
                report["checks"][artifact["kind"]] = check
                checkpoint(directory,snapshot,regions,tools,completed)
                if check["status"] in {"verified","verified_with_warnings"}:
                    progress({"phase":"osmium_reconciliation","region":region})
                    try:
                        check["osmium"] = osmium_check(local, check["counts"], folder)
                        if check["osmium"].get("status")=="unsupported_profile":
                            check["status"]="unsupported_profile"
                            check["reasons"].append({
                                "code":"empty_osmium_capability",
                                "message":check["osmium"]["reason"],
                            })
                        out = folder/"osmium.json"
                        report["outputs"].append({
                            "path":out.name,"encoding":"json","size":out.stat().st_size,
                            "sha256":hashlib.sha256(out.read_bytes()).hexdigest(),
                        })
                    except ValidationError as error:
                        check = {**check,"status":"input_invalid","reasons":[
                            *check.get("reasons",[]), {"code":"count_disagreement","message":str(error)}]}
        report["checks"][artifact["kind"]] = check
        for output in check.get("outputs",[]):
            report["outputs"].append(output)
        reasons = check.get("reasons",[])
        if check["status"] in {"input_invalid","unsupported_profile","operational_failed"}:
            blocking.append({"region":region,"kind":artifact["kind"],"artifact_sha256":artifact["sha256"],
                             "status":check["status"],"reasons":reasons[:16]})
        elif check["status"] == "verified_with_warnings":
            warnings.append({"region":region,"kind":artifact["kind"],"reasons":reasons[:16]})
        completed.add(artifact["artifact_id"])
        checkpoint(directory,snapshot,regions,tools,completed)
        # No decoder or inspector will reopen this spool after this region.
        local.unlink(missing_ok=True)
    regional = []
    for region in sorted(regions):
        report = regions[region]
        key = hashlib.sha256(region.encode()).hexdigest()
        folder = result_root/"regions"/key
        report["input_fingerprint"] = hashlib.sha256(canonical(report["inputs"])).hexdigest()
        validate_manifest("region",report)
        meta = write_json(folder/"manifest.json",report)
        regional.append({"region_id":region, "path":f"regions/{key}/manifest.json",
                         "sha256":meta["sha256"],"size":meta["size"],
                         "checks":{kind:check["status"] for kind,check in report["checks"].items()},
                         "counts":report["checks"].get("pbf",{}).get("counts",{})})
    if blocking:
        statuses = {item["status"] for item in blocking}
        status = "operational_failed" if "operational_failed" in statuses else (
            "input_invalid" if "input_invalid" in statuses else "unsupported_profile")
    else:
        status = "verified_with_warnings" if warnings else "verified"
    nonempty = bool(snapshot["selected_pbfs"])
    counts = {"nodes":0,"ways":0,"relations":0}
    for region in snapshot["selected_pbfs"]:
        check = regions[region]["checks"].get("pbf",{})
        current = check.get("counts",{})
        for kind in counts:
            counts[kind] += int(current.get(kind,0))
        nonempty = nonempty and sum(int(current.get(kind,0)) for kind in counts) > 0
    return {
        "schema_version":1,"policy_version":POLICY_VERSION,"run_id":snapshot["run_id"],
        "catalog_digest":snapshot["catalog_digest"],"retrieval_local_date":snapshot["retrieval_local_date"],
        "zone":snapshot["zone"],"selected_pbfs":snapshot["selected_pbfs"],
        "boundary_only_regions":sorted(set(snapshot["regions"]) - set(snapshot["selected_pbfs"])),
        "regions":regional,
        "region_results":[{"region_id":name,"checks":regions[name]["checks"]} for name in sorted(regions)],
        "counts":counts,"status":status,"checks_completed":sorted(completed),"checks_incomplete":[],
        "build_eligible":not blocking and nonempty,"blocking":blocking[:100],"warnings":warnings[:100],
        "tools":tools,"attribution":{"source":"OpenStreetMap contributors","license":"ODbL-1.0",
        "url":"https://www.openstreetmap.org/copyright","provider":"Geofabrik",
        "metadata_policy":"Public provider contributor metadata is redacted. Encoded zero and empty values are preserved."},
        "timestamp_semantics":{"source":"PBF header and object fields","receipt":"Frozen intake provenance",
                               "verification":"Execution and manifest registration times"},
        "execution":{"wall_seconds":round(monotonic()-start,3),
                     "child_peak_rss_kib":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                     "inspector_peak_rss_kib":resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss},
    }


def main(directory_arg=None):
    directory = Path(directory_arg or sys.argv[1]).resolve(strict=True)
    snapshot = json.loads((directory/"snapshot.json").read_bytes())
    last = 0.0
    def progress(value):
        nonlocal last
        now = monotonic()
        if now - last >= 1:
            from django.conf import settings
            if inbox_usage(directory.parent) > settings.ATLAS_VERIFICATION_ATTEMPT_BYTES:
                raise RuntimeError("Verification per-attempt storage cap exceeded.")
            print(json.dumps(value, separators=(",",":")),flush=True)
            last = now
    try:
        report = run(snapshot,directory,progress)
    except BaseException as error:
        partial=directory/"partial.json"
        report=json.loads(partial.read_bytes()) if partial.exists() else {}
        report.update(
            status="operational_failed",build_eligible=False,
            blocking=[{"reasons":[{"code":"execution_failed","message":f"{type(error).__name__}: {str(error)[:500]}"}]}],
        )
    write_json(directory/"report.json",report)


if __name__ == "__main__":
    main()
