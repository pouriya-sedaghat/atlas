# Durable laboratory serving guard

This is a trusted local experiment controller. It does not publish a release, establish a
production SLA, or replace monitoring of the gateway and every map engine.

The observer captures the current attempt token **before** an HTTP request. On a failed
request it checks the worker unit/config/runtime binding, then commits one incident under
the same advisory transaction lock used by build admission and completion. The transaction:

1. Saves bounded observation text and its SHA-256, bound to root/pipeline/job/token.
2. Marks that job and attempt failed, fences completion/heartbeats, and increments failure once.
3. Holds the shared heavy-processing slot with an infinite deadline. It cannot expire merely
   because the observer or worker crashes. An unresolved incident also explicitly blocks the reaper.

Only after that commit may the guard stop the bound worker unit. A stale token, completed job,
different root/pipeline, changed control DSN, wrong unit or different guard/data/queue runtime
must fail before stopping a service. Production uses only `atlas-candidate-worker.service`;
alternate units are restricted to disposable fictional E2E control databases and a fixed test prefix.

Recovery checks the stopped unit and the exact recorded data target: container/image/volume,
PostgreSQL system identifier, database owner marker and build identity. It removes only the
attempt's labelled importer/Martin containers. It disables LOGIN and passwords for that attempt's
import/tile/QA roles and revokes their database connection grant. It terminates only their
connections in the candidate database and administrative connections carrying the attempt's
unique `atlas-build/<job-prefix>/<token>` application name. An unrelated client in the database
is preserved and keeps admission held. Missing or ambiguous ownership also keeps the hold.

The incident is acknowledged and admission released only after these checks succeed. The
candidate stays failed; recovery never retries it or deletes its database. A repeated recovery
of an acknowledged incident does not stop another worker or release another owner's slot.
Ordinary SIGTERM without a guard incident retains the existing cancellation/retry behavior.

## Upgrade and operation

Drain the old worker before upgrading the pinned runtime/schema; do not mix a running old
worker with new guard semantics. Apply builder `init` with the new runtime to add the incident
table and grants, then pin that runtime's specification. Keep the worker stopped until the
source receipt, profile and experiment setup have been reviewed. There is no automatic
full Iran reimport. The stage-six lab upgrade has been installed in paused mode; see the
recorded deployment and observer-bundle identities before selecting executable paths.

The probe config now requires `buildConfigFile` when the guard is enabled:

```json
{
  "root": "/private/candidate-state",
  "jobId": "<64-hex-current-job>",
  "controlDsnFile": "/private/candidate-control.dsn",
  "buildConfigFile": "/private/build-config.json",
  "endpoint": "http://<inspected-old-martin-ip>:3000",
  "dataContainer": "atlas-candidate-db"
}
```

The root and control DSN file must match the bound build config. Guard configuration is
trusted operator input, never an uploaded PBF instruction. Preserve private config files and
secrets separately from public evidence. The worker's exact systemd ExecStart must use the
same Node executable, pinned repository and build-config path. Config/repository paths with
whitespace or systemd delimiter characters are refused by this conservative binding parser.

If the observer fails after committing an incident, obtain its ID from builder `status`
(`guard_incident`) or the retained observer report. Resume using the same pinned runtime/config:

```sh
node tools/recover-serving-guard.mjs /private/build-config.json INCIDENT_SHA256
```

Do not clear `processing_slot`, edit incident evidence, or requeue the job by hand to bypass
a failed cleanup. Investigate a target/identity mismatch or unknown backend first. A recovery
failure leaves the hold in place. A target not yet recorded is accepted as unallocated only
when the configured data cluster has none of that attempt's database/roles; ambiguous partial
provisioning requires investigation. No deletion-by-prefix or actual dataset GC is implemented.

The guard needs a reachable control database to commit its authority. Control-plane partitions,
disk failure and tampering by the shared Unix owner remain outside the demonstrated guarantee;
the existing worker lease watchdog still applies. Persisted incidents have to be included in
backup/recovery. Do not deploy an older reaper over unresolved incidents.

## Validation

Real PostgreSQL tests cover restart/expiry, stale tokens, duplicate delivery, completion races,
root/pipeline/observation checks, recovery fencing, ordinary cancellation and immutable evidence
grants. The fictional E2E fault tool additionally exercises systemd stop/recovery, changed target,
owned import/admin backends, preservation of an unrelated connection, revoked credentials,
and the actual HTTP observer path against an intentional 503 endpoint. It never stops the real
builder unit. Tests are not an all-engine availability experiment.

PostgreSQL documents [infinite timestamps](https://www.postgresql.org/docs/17/datatype-datetime.html),
[backend signalling](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)
and [role login/password changes](https://www.postgresql.org/docs/17/sql-alterrole.html). A signal's
return value alone is not treated as proof of shutdown; recovery checks that sessions are gone.

## Admission and observer ownership

`init` requires a drained shared slot and sets admission paused with a mandatory serving watch.
Never run it over a live old worker. The controller can read this policy but cannot enable it.
Only `init --fixture-unguarded`, on a provider `fixture` and disposable database named
`atlas_test_ingest_e2e_<8 hex>`, can bypass the watch for fictional core tests. The worker refuses
that bypass outside this fixture context. Manifests disclose the actual policy.

```sh
node "$PINNED_RUNTIME/apps/builder/dist/cli.js" admission --config "$CONFIG" --mode paused
# After reviewing readiness, exact binding and the experiment's prerequisites:
node "$VERIFIED_OBSERVER/tools/candidate-serving-probe.mjs" "$PROBE_CONFIG" "$NEW_REPORT"
# In another shell, only while the current database watch is ready:
node "$PINNED_RUNTIME/apps/builder/dist/cli.js" admission --config "$CONFIG" --mode guarded
```

These commands describe operation, not approval to enable the current Iran job. Its storage
experiment failed and admission must stay paused. Use the separately installed corrected
observer bundle from `observer-bundle.json`, not the earlier observer copied into the frozen
builder runtime. Its two regular files are readonly and its explicit apps/node_modules links
target that exact runtime. Verify the bundle file hashes as well as the builder specification.
The pipeline does not fingerprint these operator tools; their artifact identity is separate.

A successful HTTP/body observation renews a 30-second database lease. Status 200/204 received
after 5000ms is unhealthy even if an overdue AbortSignal callback has not run; the original
status remains in `wire_status`. Changed content is unhealthy too. A `.ready` file is a historic
checkpoint, not permission: claim uses database time and the current observer token. Ownership
cannot be replaced during an active attempt. A late healthy result cannot revive its expired
watch. Closing or losing the watch fences an active attempt, with `serving-watch-loss/1`
evidence distinct from an HTTP failure. Watch loss is detected by worker heartbeat or claim
scanning; it does not imply an independent external watchdog for a completely stopped host.

Pause blocks new claims; it does not cancel a healthy current attempt. Paused workers skip
source reconciliation/PBF hashing while retaining maintenance and fencing. Do not start heavy
intake/build work to test whether a failed infrastructure condition has disappeared.

Install the supplied `systemd/atlas-candidate-guard-recovery.*.in` templates with the pinned
Node binary/runtime and private config. The user timer runs root/pipeline-scoped `pending`
recovery every ten seconds. Unknown ownership/backends or unreachable control data leave
the incident held. Timer failure needs operator attention; a timer is not a durable external
monitor of its own VM. Do not configure automatic retries of a quarantined candidate.

The longer I/O diagnostic accepts an optional 20000..600000ms target window. It repeats
read-only aggregates with a 20-second per-statement limit, records event-loop delay, and
cancels its own reads on unhealthy serving or an unexpected SQL error. It never adopts the
failed database or grants publication. Preserve raw reports from earlier tool versions;
reassess elapsed-time violations without rewriting their original error counts.
