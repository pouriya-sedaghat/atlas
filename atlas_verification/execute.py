"""Private child execution. The parent owns claims, resource enforcement and publication."""
import hashlib
import json
import os
import re
import resource
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

from django.core.exceptions import ValidationError

from .control import POLICY_VERSION, canonical
from .storage import hash_file, spool, write_json
from .manifest import validate_manifest
from atlas_intake.storage import inbox_usage, sync_directory


OSMIUM_NO_BOUNDS = b"Geometry error: Invalid location. Usually this means a node was missing from the input data.\n"
OSMIUM_COUNT_ADAPTER = "osmium-1.18-no-node-bounds-counts-v1"
OSMIUM_KINDS = ("nodes", "ways", "relations")


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
    command = ["osmium", "fileinfo", "--input-format=pbf", "--extended", "--json", "--no-progress", str(source)]
    with output_path.open("xb") as out, error_path.open("xb") as err:
        result = subprocess.run(
            command, stdout=out, stderr=err, timeout=1800,
        )
    if result.returncode:
        # v1.18.0 constructs a box when rendering JSON even when no nodes
        # exist. Select only that complete presentation diagnostic; processing
        # errors, additional diagnostics, and partial JSON remain failures.
        with error_path.open("rb") as error:
            message = error.read(len(OSMIUM_NO_BOUNDS)+1)
        output_path.rename(directory/"osmium-json.stdout")
        if (int(expected["nodes"]) == 0 and result.returncode == 1
                and output_path.with_name("osmium-json.stdout").stat().st_size == 0
                and message == OSMIUM_NO_BOUNDS):
            error_path.rename(directory/"osmium-json.stderr")
            return osmium_no_bounds_counts(source, expected, directory, command)
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


def osmium_no_bounds_counts(source, expected, directory, json_command):
    outputs = []
    invocations = []

    def record(command, code, output_path, error_path):
        raw = []
        for path in (output_path, error_path):
            with path.open("rb") as stream:
                value = stream.read(4097)
            if len(value) > 4096:
                raise RuntimeError("Mandatory Osmium count output exceeded its bounded size.")
            raw.append(value)
            outputs.append({"path":path.name,"encoding":"text/plain","size":len(value),
                            "sha256":hashlib.sha256(value).hexdigest()})
        invocations.append({"command":command,"exit_code":code,
                            "stdout":raw[0].decode("utf-8","replace"),
                            "stderr":raw[1].decode("utf-8","replace"),
                            "stdout_path":output_path.name,"stderr_path":error_path.name})
        return raw[0]

    record(json_command, 1, directory/"osmium-json.stdout", directory/"osmium-json.stderr")
    counts = {}
    for kind in OSMIUM_KINDS:
        command = ["osmium", "fileinfo", "--input-format=pbf", "--extended",
                   "--get=data.count."+kind, "--no-progress", str(source)]
        output_path = directory/("osmium-count-"+kind+".stdout")
        error_path = directory/("osmium-count-"+kind+".stderr")
        with output_path.open("xb") as out, error_path.open("xb") as err:
            result = subprocess.run(command, stdout=out, stderr=err, timeout=1800)
        value = record(command, result.returncode, output_path, error_path)
        if result.returncode:
            raise RuntimeError("Mandatory Osmium full-file count reconciliation could not finish.")
        # Osmium uses uint64 counters and emits one ASCII decimal plus LF.
        # Bound the token before integer conversion and reject extra values,
        # signs, whitespace, alternate bases and integer overflow.
        if (not re.fullmatch(rb"(?:0|[1-9][0-9]{0,19})\n?", value)
                or int(value) > 2**64-1):
            raise RuntimeError("Mandatory Osmium returned an invalid bounded decimal count.")
        counts[kind] = int(value)
    inspection = {"adapter":OSMIUM_COUNT_ADAPTER,"counts":counts,"bounds":None,
                  "bounds_status":"absent_no_nodes","invocations":invocations,"outputs":outputs}
    if any(counts[kind] != int(expected[kind]) for kind in OSMIUM_KINDS):
        raise ValidationError("Osmium and the authoritative decoder disagree on object counts.",
                              params={"osmium":inspection})
    return inspection



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
                    except ValidationError as error:
                        check = {**check,"status":"input_invalid","reasons":[
                            *check.get("reasons",[]), {"code":"count_disagreement","message":str(error)}]}
                        if error.params and "osmium" in error.params:
                            check["osmium"] = error.params["osmium"]
                    except Exception:
                        # Operational failures keep mandatory reconciliation
                        # incomplete, with every diagnostic's byte identity in
                        # the retained checkpoint as well as on disk.
                        diagnostics = []
                        for out in sorted(folder.glob("osmium*")):
                            size, digest = hash_file(folder, out.name)
                            diagnostics.append({"path":out.name,"encoding":"application/octet-stream",
                                                "size":size,"sha256":digest})
                        check["osmium_failure_outputs"] = diagnostics
                        checkpoint(directory,snapshot,regions,tools,completed)
                        raise
                    if check.get("osmium",{}).get("adapter"):
                        report["outputs"].extend(check["osmium"]["outputs"])
                    else:
                        out = folder/"osmium.json"
                        report["outputs"].append({
                            "path":out.name,"encoding":"json","size":out.stat().st_size,
                            "sha256":hashlib.sha256(out.read_bytes()).hexdigest(),
                        })
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
