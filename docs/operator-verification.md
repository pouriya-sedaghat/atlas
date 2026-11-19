# Atlas Part 1B operator guide

Input verification uses the same operator accounts and PostgreSQL control plane as intake. An account needs `atlas_intake.operate` to read results or request work. Open `/verification/`, choose the retrieval date, then choose the exact run UUID. Runs sharing a retrieval date remain separate. The run page shows its frozen catalog digest, selected PBFs, boundary-only regions, recorded provider exceptions and integrity state before **Request verification** is available.

## Prepare and upgrade

Use the deployment commands and secret creation in [the intake guide](operator.md), with these additional directories and permissions. Web and intake run as `10001:10001`; verification runs as `10002:10002`, with supplementary groups `10001` and `999` for read access to accepted inputs and shared secrets. PostgreSQL remains `999:999`. The inbox is writable only in the intake worker container. Verification mounts the inbox read-only. The verification root is writable only by the verifier; web receives the same root read-only. Its `.work` directory is mode `0700`, owned by UID `10002`, so neither web nor the intake writer can read private spools or generation scratch.

```sh
sudo install -d -m 0750 -o 10001 -g 10001 /srv/atlas/data/inbox
sudo install -d -m 2750 -o 10002 -g 10001 /srv/atlas/data/verification
sudo install -d -m 0700 -o 10002 -g 10002 /srv/atlas/data/verification/.work
sudo chown 10001:999 /srv/atlas/secrets/postgres_app_password
sudo chmod 0440 /srv/atlas/secrets/postgres_app_password
sudo chown 10001:10001 /srv/atlas/secrets/django_secret_key
sudo chmod 0440 /srv/atlas/secrets/django_secret_key
```

Existing inbox directories must permit group `10001` traversal and files must permit group reads. During a maintenance window, preserve the accepted bytes and apply `0750` to directories and `0640` to regular files under the configured inbox; do not follow symlinks. Check before restarting intake that its newly published files use the same group permissions. Keep the verification root on persistent storage and retain its published history. If it shares a filesystem with intake, capacity reservations include both workloads under the same database capacity lock.

The sample environment adds `ATLAS_VERIFICATION_DIR=/srv/atlas/data/verification`, mounted at `ATLAS_VERIFICATION_ROOT=/verification`. The approved pilot limits are one verifier, `cpus: 1.0`, `mem_limit: 2g` (2 GiB), a 3,600-second deadline, 21,474,836,480 bytes per attempt and 64,424,509,440 bytes for the verification root. These limits include scratch, spools, indexes, retained failure generations and published outputs. Retain the existing 20 GiB filesystem free-space reserve and 50 GiB inbox budget. Do not increase limits to make a failing run pass; capture the measured shortfall for review. Plan capacity for a complete second intentional verification before requesting it.

Memory acceptance uses the enforced `memory.max` of 2,147,483,648 bytes covering the verifier and its children. A transient `memory.peak` excursion alone is not a resource failure: [the kernel documents temporary usage above `memory.max`](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html). Retain its actual value. `resources.aggregate_peak_memory_bytes` is explicitly scoped to the cgroup lifetime, because the observer does not reset the peak counter. `attempt_sampled_peak_memory_bytes` is the largest sampled `memory.current` value, not an isolated process RSS measurement. The child and inspector RSS fields remain separate.

`resources.cgroup` records effective `cpu.max`, memory/swap settings, before/after current/peak values, charged anonymous/file-cache memory, observation timestamps and OOM/OOM-kill deltas. Its normal window starts after the generation snapshot and ends after child exit and final storage/deadline checks, before result registration/publication. Sampled maxima are observations, not a continuous high-water measurement. Historical OOM events do not fail a new generation; new observed OOM events block it. Missing final counters are reported as unavailable, while an already observed OOM failure remains sticky. Failure/recovery reports retain the initial snapshot and identify a changed cgroup lifetime or an unobserved interval. Allocation/child execution failures remain operational failures. Keep the configured ceiling; do not lower it merely to suppress a peak-counter excursion.

```sh
atlas_compose exec -T verifier python -c 'import json; from atlas_verification.resources import cgroup_snapshot; print(json.dumps(cgroup_snapshot(), indent=2))'
```

Before the first Part 1B migration, stop `web`, `worker` and `verifier`. Record the checkout revision and capture a matched PostgreSQL dump, inbox archive and verification-root archive, together with private deployment configuration and secrets. A backup from Part 1A has no verification-root archive; initialize an empty verification root for that upgrade. Never restore a database that registers successful outputs without restoring its matching verification root.

```sh
atlas_compose stop web worker verifier
atlas_compose build web
atlas_compose run --rm -T web python manage.py migrate --plan
atlas_compose run --rm -T web python manage.py migrate --noinput
atlas_compose run --rm -T web python manage.py migrate --check
atlas_compose run --rm --no-deps --entrypoint sh verifier -ec '
    test -r /inbox && test ! -w /inbox
    test -w /verification && test -w /verification/.work
    test "$(stat -c %a /verification/.work)" = 700
'
atlas_compose run --rm --no-deps --entrypoint sh web -ec '
    test -r /verification && test ! -w /verification
    test ! -r /verification/.work
'
atlas_compose up -d --no-build --wait web worker verifier
```

Part 1B adds `atlas_verification.0001_initial` without rewriting historical retrieval records. To roll back, stop all application services and restore the pre-upgrade matched database and inbox with the recorded checkout revision into fresh data directories. Preserve the upgraded database, inbox and verification root for diagnosis. Do not reverse migrations against a database containing verification history as a substitute for a matched restore.

## Requests, progress and recovery

**Request verification** freezes the accepted artifact identities, source provenance, selected coverage, catalog digest, exception scope and policy. The server attributes the request to the signed-in operator. An accepted operator request key replays the original attempt, even if the acquisition is later invalidated. A distinct intentional request produces a new attempt and retains all previous history. Manual and Automatic retrievals use this same flow.

Open an attempt to inspect its input fingerprint, generation, lease, durable progress, completed and incomplete checks, tool versions, per-generation reports and original accepted input SHA-256 values. A POLY-only run can complete verification while remaining build-ineligible. Valid empty PBF snapshots complete verification with the valid-empty finding and remain build-ineligible. When pinned Osmium 1.18.0 cannot render absent node bounds in JSON, the narrow `osmium-1.18-no-node-bounds-counts-v1` adapter performs three complete-file count inspections of the same stable spool. Each command must succeed and return one bounded nonnegative decimal count agreeing with the decoder. The report records the adapter version, all commands and raw results, hashed diagnostics and explicitly absent bounds. General inspector errors, malformed responses, timeouts and count disagreements retain their blocking outcomes. Supported relations-only snapshots use the same reconciliation path when node bounds are absent. Missing way nodes or any required boundary failure block the entire batch. Missing relation members produce typed warnings. A boundary-only region's required POLY is checked even when its PBF was not selected. A previously approved provider exception remains visible at its original scope.

An **Operational failure** may be retried after its resource or runtime cause is resolved. The retry retains the attempt and snapshot and creates a new execution generation. Input-invalid and unsupported-profile outcomes require diagnosis or a separately approved implementation/policy change; they cannot be converted into success by operational retry. A new intentional verification is available from the retrieval page.

```sh
atlas_compose ps
atlas_compose exec -T verifier python manage.py atlas_verify_health
atlas_compose logs --tail=80 verifier web db
docker inspect "$(atlas_compose ps -q verifier)" \
    --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.Config.User}}'
```

The verifier health command checks the durable PostgreSQL heartbeat. A child killed by a memory limit, deadline or restart cannot publish under an expired generation. Restart recovery reconciles prepared publication intents; an expired running claim becomes an operational failure with its original snapshot retained. Inspect the attempt before choosing retry. Stop and restart the isolated stack to verify this behavior without touching an active production verification.

Keep failure-generation reports and successful output history during the pilot. The 60 GiB root cap includes both. Clean only abandoned scratch whose database generation and publication records prove it is unused; never delete `.work` wholesale or unlink registered output paths to free space. Back up the matching database and output root first. If capacity is exhausted, retain the failure and report measured usage for review.

## Source and output semantics

The authoritative decoder uses generated proto2 messages from the pinned official OSM schemas. The supported profile is OSM v0.6 snapshots with ordinary nodes, dense nodes, ways and relations in raw or zlib blobs. Unsupported required features, history/deletion shapes, unsupported compression and unhandled data-bearing fields produce explicit findings. Unknown optional feature names alone do not invalidate input. See the schema provenance and object JSON Schemas in the source tree for generation and field contracts.

`objects.jsonl.zst` contains versioned deterministic JSON records, including exact integer identity and nanodegree coordinate strings, ordered tag pairs, ordered way references, ordered typed relation members and metadata presence flags. An absent metadata field differs from explicit zero or empty text. Proto2 repeated fields cannot distinguish encoded empty from absent; the output preserves the source semantics that proto2 exposes. Provider contributor metadata may be redacted; an encoded empty or zero value remains present. Coordinate precision, timestamp granularity and encoded presence are retained in the block sidecar. Source object timestamps, header replication time, HTTP Last-Modified, intake receipt and verification time have different meanings.

POLYs are interpreted in the provider longitude/latitude plane, with section order and inclusion/subtraction roles retained. GEOS checks topology without silently repairing invalid rings. `-180` and `+180` remain distinct; Antarctica's full-longitude rectangle and published multipart antimeridian regions use this planar policy. This result does not prescribe a later spherical or projected interpretation.

The explicit POLY profile is 2 MiB, 100,000 encoded vertices and 1,024 sections per file; larger profiles are unsupported and remain ineligible.

Osmium `fileinfo --extended --json` independently counts the same fingerprinted private PBF spool and must agree with the authoritative extraction. Its broader format support does not expand Atlas's accepted profile. The complete disk-backed typed-reference pass is authoritative for reference findings. The pinned runtime includes Python 3.14.10, Django 5.2.19, protobuf 6.33.5, Zstandard 0.25.0, Osmium 1.18.0 (libosmium 2.22.0), GEOS 3.13.1 and GDAL 3.10.3. Python and native dependency closures are locked in `requirements.txt` and `requirements-native.txt`; the Python base and PostgreSQL images use digest pins. Rebuild from those pins and record the candidate image ID and runtime tool report in acceptance evidence.

## Published results and handoff

Successful immutable output is published under:

```text
verification/<retrieval-local-date>/<run-id>/<verification-id>/manifest.json
verification/<retrieval-local-date>/<run-id>/<verification-id>/regions/<sha256-of-region-id>/manifest.json
verification/<retrieval-local-date>/<run-id>/<verification-id>/regions/<sha256-of-region-id>/objects.jsonl.zst
```

The region manifest maps the collision-resistant directory key back to the original region ID. Batch and regional manifest schema versions are `1`, with policy `atlas-input-v1`. The batch manifest records its verification and retrieval IDs, input fingerprint, catalog digest, frozen source identities, coverage, regional paths and digests, checks, findings, counts, tools, attribution, timestamp semantics and build eligibility. The SHA-256 stored in PostgreSQL identifies the actual serialized batch-manifest bytes.

The authenticated attempt page validates current input eligibility and the batch-manifest digest before exposing the manifest link. A changed/missing manifest, unsupported version or later acquisition invalidation removes usable handoff eligibility. Part 1C must call `get_handoff(attempt_id, verify_outputs=True)` and verify current source eligibility plus every registered output digest before import. A successful verification with `build_eligible=false` remains useful evidence but cannot feed a candidate build.

For acceptance evidence, identify the exact sealed source run, execute two distinct intentional attempts, record their manifest hashes and semantic stream digests, reconcile the entire independent output stream, and retain the resource high-water measurements. Capture all 554 POLY outcomes, including Monaco when its PBF is unselected, and any blocking provider finding with its exact input digest. Real input bytes, extracted records, manifests, secrets and runtime logs remain outside Git.


## PR #2 follow-up acceptance

Use an explicitly synthetic sealed fixture catalog in the isolated test database to exercise normal request entry, the actual child, native inspection, fenced publication and a digest-verified `get_handoff()`. A valid nonempty fixture must be build-eligible; a valid empty fixture must verify and stay build-ineligible. Altering a registered fixture output must revoke the handoff. Synthetic fixtures do not replace a provider source or its provenance.

Jiangsu's retained self-intersection is an accepted blocking source finding under `atlas-input-v1`. Preserve the original reports and source identity; the negative corpus and the independent positive fixture establish the two software paths. A corrected upstream boundary enters through a new acquisition, and is not a prerequisite for completing the software review.

For the approved follow-up, identify old and new evidence explicitly. Re-run the recorded Iran/554-POLY corpus on the exact new candidate and compare every input fingerprint, reference finding, regional outcome and deterministic output identity with the prior two exact-candidate attempts. Reuse unaffected fidelity evidence only when those bytes and outcomes match; otherwise run two complete new attempts and explain the difference. Preserve the original restart receipt and rehash new retained results after Compose restart.

Diagnose a current catalog rejection at its exact public URL, JSON field and validation rule without mutating the last-known-good catalog or frozen requests. Transfer comparisons must use one validated dated pin across interleaved idle/concurrent observations and retain failed/partial transfers. Record request/read timing separately from local write/flush/fsync and CPU timing. A controlled local replay can isolate local contention when provider behavior is unstable. Label controlled-idle pauses and retain an automatic bounded resume guard; the verifier parent, lease, heartbeat and execution deadline remain active. Any provider compatibility proposal is reviewed separately and must preserve frozen source identities and checksum validation.
