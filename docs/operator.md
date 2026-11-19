# Atlas Part 1A operator guide

For input verification, its separate verifier identity and mounts, migration procedure, supported profile and recovery, continue with the [Part 1B operator guide](operator-verification.md). When deploying Part 1B, include `verifier` alongside `web` and `worker` in start, stop, health and matched-backup operations.

## Prepare the VM

Run the commands from the Atlas checkout. The application image runs web and worker processes as UID/GID `10001:10001`. The pinned PostgreSQL image uses `999:999`. The database listens only on the internal Compose network. Gunicorn is mapped to VM loopback, and only the worker can write to the inbox.

Provision the VM directories and secrets once for a new deployment. If the data lives on a dedicated volume, mount it before preparing these directories. Compose preserves the host permissions on secret files. Both PostgreSQL and the application need to read the application password.

```sh
sudo install -d -m 0755 /srv/atlas /srv/atlas/data
sudo install -d -m 0700 -o 999 -g 999 /srv/atlas/data/postgres
sudo install -d -m 0750 -o 10001 -g 10001 /srv/atlas/data/inbox
sudo install -d -m 2750 -o 10002 -g 10001 /srv/atlas/data/verification
sudo install -d -m 0700 -o 10002 -g 10002 /srv/atlas/data/verification/.work
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /srv/atlas/secrets
install -m 0600 deploy/compose.env.example /srv/atlas/secrets/compose.env
(
    set -eC
    umask 077
    for atlas_secret in postgres_bootstrap_password postgres_app_password django_secret_key; do
        openssl rand -hex 32 > "/srv/atlas/secrets/$atlas_secret"
    done
)
sudo chown 999:999 /srv/atlas/secrets/postgres_bootstrap_password
sudo chown 10001:999 /srv/atlas/secrets/postgres_app_password
sudo chown 10001:10001 /srv/atlas/secrets/django_secret_key
sudo chmod 0400 /srv/atlas/secrets/postgres_bootstrap_password
sudo chmod 0440 /srv/atlas/secrets/postgres_app_password /srv/atlas/secrets/django_secret_key
```

Use mounted disks for PostgreSQL and the inbox. For a custom location, set `ATLAS_POSTGRES_DIR`, `ATLAS_INBOX_DIR` and `ATLAS_SECRET_DIR` in the VM environment file and apply the same ownership and modes at those paths. Check the backing filesystem, available capacity and permissions before starting the services.

```sh
docker version
docker compose version
sudo findmnt --target /srv/atlas/data/postgres
sudo findmnt --target /srv/atlas/data/inbox
sudo df -hP /srv/atlas/data/postgres /srv/atlas/data/inbox
sudo stat -c '%a %u:%g %n' /srv/atlas/data/{postgres,inbox} \
    /srv/atlas/secrets/{postgres_app_password,postgres_bootstrap_password,django_secret_key}
```

The inbox budget is 50 GiB including staging, plus a filesystem free-space reserve of 20 GiB. Plan for at least 70 GiB of usable capacity for these two together, with additional headroom if PostgreSQL, backups, Docker layers or other data share the disk. Each run can reserve up to 2 GiB of artifacts. A full 2 GiB reservation requires at least 22 GiB currently free before accounting for other outstanding reservations. The per-file limits are 1 GiB for a PBF and 2 MiB for a POLY. At most two transfers run within one active retrieval. Manifests and existing files consume inbox space, so an empty 50 GiB inbox can fit at most 25 full-size runs and may fit fewer in practice. Keep the staging area on the inbox filesystem so publication remains atomic.

The sample environment file lists the pilot limits as positive byte counts. Set `ATLAS_MAX_PBF_BYTES`, `ATLAS_MAX_POLY_BYTES`, `ATLAS_MAX_RUN_BYTES`, `ATLAS_MAX_INBOX_BYTES` and `ATLAS_MIN_FREE_BYTES` there to configure the same policy for web and worker. `ATLAS_ZONE` sets the IANA zone for manual runs and defaults to `Asia/Tehran`. Each automatic schedule stores its own zone.

## Start services and create an operator

The examples use this shell function. For a loopback-only smoke deployment, use an independent project name, VM environment file, data and secret directories, and an unused loopback port. Preserve the same directory and secret permissions.

```sh
atlas_compose() { docker compose -p atlas --env-file /srv/atlas/secrets/compose.env "$@"; }
atlas_compose config --quiet
atlas_compose pull db
atlas_compose build web
atlas_compose run --rm --no-deps --entrypoint sh worker -ec '
    test -r /inbox && test -w /inbox
    atlas_probe=$(mktemp /inbox/.atlas-mount-check.XXXXXX)
    rm -- "$atlas_probe"
'
atlas_compose run --rm --no-deps --entrypoint sh web -ec 'test -r /inbox && test ! -w /inbox'
atlas_compose up -d --wait db
atlas_compose run --rm web python manage.py migrate --noinput
atlas_compose up -d --no-build --wait web worker
atlas_compose ps
```

PostgreSQL initializes an `atlas_bootstrap` superuser and an `atlas_app` login on an empty data directory. The web, worker and migrations connect as `atlas_app`, which owns the `atlas` database and has no cluster-level administrative privileges. The bootstrap password is mounted only in the database container. Initialization scripts run only on an empty PostgreSQL data directory. Rotate an existing role's password in PostgreSQL and update its corresponding secret file as one maintenance operation.

Create a named operator interactively. The `atlas_intake.operate` permission grants access to the intake panel and its actions. Use the same method to provision individual accounts for audit attribution.

```sh
atlas_compose run --rm web python manage.py shell -c '
from getpass import getpass
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.contrib.auth.password_validation import validate_password
from django.db import transaction

operator = get_user_model()(username=input("Operator username: "))
password = getpass("Password: ")
if password != getpass("Repeat password: "):
    raise SystemExit("The passwords differ.")
operator.full_clean(exclude=["password"])
validate_password(password, operator)
operator.set_password(password)
permission = Permission.objects.get(content_type__app_label="atlas_intake", codename="operate")
with transaction.atomic():
    operator.save()
    operator.user_permissions.add(permission)
'
```

For operator access, terminate TLS at a VM-local reverse proxy on the private operator network. Send requests to `127.0.0.1:8000`, preserve the request host, and replace any incoming `X-Forwarded-Proto` with `https`. Set the actual hostname in `ATLAS_ALLOWED_HOSTS` alongside `localhost`, set the HTTPS origin in `ATLAS_CSRF_TRUSTED_ORIGINS`, and set `ATLAS_SECURE_COOKIES`, `ATLAS_TRUST_FORWARDED_PROTO` and `ATLAS_SSL_REDIRECT` to `1`. For a VM-local HTTP smoke, use the loopback listener directly or forward it privately with SSH and use the sample cookie and proxy settings.

## Run intake

1. Sign in at `/login/`. Confirm Manual mode and wait for the catalog revision on the dashboard. **Refresh catalog** requests a new fetch. If refresh fails, record the reported error and inspect whether the previous revision remains available.
2. For the live pilot, search the tree for Iran and select its PBF. Leave Monaco's PBF unselected and save the selection. Each catalog region gets a POLY intent regardless of PBF selection. Launch the retrieval in Manual mode and keep its run ID and displayed date.
3. Open the run detail to inspect progress, the source and checksum records, relative paths, and any incomplete files. Use **Retry file** for an eligible individual failure. A PBF retry retains its saved dated target and any established validators. A vanished or changed dated file requires a new run. A stale boundary shows its previous retrieval date and cannot satisfy the current run. A transient POLY discovery error appears on the dashboard while the last validated catalog remains available.

When an artifact shows **Publication paused**, resolve the filesystem issue and choose **Resume publication** on the run page. Each publication cycle allows up to three attempts. The worker keeps the staged file and verified intent, and the run can release the retrieval queue while waiting for publication. A paused file remains in the inbox budget until publication succeeds.

Record the frozen revision, selection and region counts, checksums, relevant validators, relative inbox paths and seal status. Only a sealed run with verified current integrity can feed a later phase. Review capacity before a second intentional launch. Keep finalized assets and manifests throughout Part 1A.

## Schedule recurring retrieval

1. Save the desired PBF selection on the dashboard. For the Iran pilot, select Iran and leave Monaco unselected. Every occurrence includes a POLY intent for each region of its frozen catalog.
2. In the Automatic schedule form, enter the local activation and expiry dates and times, an IANA timezone, and the elapsed interval in whole minutes. The defaults are `Asia/Tehran` and 1440 minutes (24 hours). Enter the applicable UTC offset separately for each bound that occurs twice. The form rejects nonexistent local times.
3. Save the revision. The first planned time is one interval after activation and must be at or after the save time. For example, activation at 02:00 on January 6 and expiry at 02:00 on January 9 with a 24-hour interval in `Asia/Tehran` gives planned times at 02:00 on January 7 and January 8. Every planned time must be strictly before expiry. Atlas adds elapsed intervals in UTC, so the displayed local hour can change across a daylight-saving transition.
4. Check the schedule on the dashboard and the outcomes in **Schedule history**. A due occurrence can wait for the retrieval slot or a validated catalog until the earliest of the next planned time, 24 hours after its own planned time, and expiry. Queued work has priority. When polling resumes after a delay, Atlas records elapsed unserved windows as missed and considers the latest eligible occurrence. On a run page, compare its planned time with its actual admission time in the saved zone. Atlas uses the local date of admission for the inbox path, and late admissions keep the original cadence.
5. At expiry, reload the dashboard to see **Expired** with no next occurrence, including when the worker is offline. The mode stays Automatic. Save a replacement revision or switch to Manual to supersede remaining slots. To change the selection for future occurrences, save the selection and then save a new schedule revision. Previously admitted runs keep their frozen catalog, settings and selection.

An existing one-off from the previous release retains its original planned time and at most one admission within its original 24-hour window. You can replace it with a recurring revision or switch to Manual.

## Check health and recover after a restart

```sh
atlas_compose ps
curl --fail --silent --show-error http://127.0.0.1:8000/health/
atlas_compose exec -T worker python manage.py atlas_worker_health
atlas_compose logs --tail=80 db web worker
```

Database health uses an authenticated query as `atlas_app`. Web health verifies database access and the migrations table. Worker health checks the database heartbeat. For a restart check, record a run ID, its catalog revision, and the SHA-256 of a finalized inbox file from the run detail. Run `atlas_compose restart` and check service health again. Reopen the same run and compare its metadata. Read a finalized artifact from the web container's read-only inbox and verify its digest against the saved value.

```sh
atlas_compose exec -T web sha256sum /inbox/asia/iran/YYYY-MM-DD/RUN_ID/iran.osm.pbf
```

Use the actual path from the run. On restart, the worker reconciles durable publication intents, expired claims, and existing final files. If a completed file is absent or its fingerprint has changed, keep the original record and the affected bytes for review. If the database failed during its first initialization, check its logs and the host secret ownership. After correcting the cause, preserve the partially initialized directory and point Compose to a new, empty directory. Recover a database that already contains operator data from the matching backup.

## Back up before upgrading from schema 0002

Record the existing checkout revision and check that a known run and its inbox files are readable. Set `ATLAS_BACKUP_DIR` to a new, private directory outside the checkout on persistent backup storage. Stop both app processes while capturing the matching database dump and inbox tree. Include deployment configuration and secret files in the VM's private backup procedure.

```sh
(
    set -euC
    test -d "${ATLAS_BACKUP_DIR:?Set the private backup directory}"
    atlas_compose stop web worker
    umask 077
    git rev-parse HEAD > "$ATLAS_BACKUP_DIR/atlas-revision"
    atlas_compose exec -T db pg_dump -U atlas_bootstrap -d atlas -Fc > "$ATLAS_BACKUP_DIR/atlas.dump"
    sudo tar --numeric-owner -C /srv/atlas/data/inbox -cf - . > "$ATLAS_BACKUP_DIR/inbox.tar"
    test -s "$ATLAS_BACKUP_DIR/atlas.dump"
    test -s "$ATLAS_BACKUP_DIR/inbox.tar"
)
```

Use the configured inbox mount in the archive commands if it differs from `/srv/atlas/data/inbox`. For a backup outside an upgrade, bring the app processes back up with `atlas_compose up -d --wait web worker` after the backup finishes.

Keep web and worker stopped for the upgrade. Switch the checkout to the approved release, build its application image and migrate the existing database explicitly.

```sh
atlas_compose build web
atlas_compose run --rm -T web python manage.py migrate --plan
atlas_compose run --rm -T web python manage.py migrate --noinput
atlas_compose run --rm -T web python manage.py migrate --check
atlas_compose up -d --no-build --wait web worker
```

Check service health. Reopen a historical scheduled run and verify its original ID, planned instant, catalog and artifact paths. Check the queue and any still-pending legacy schedule. Its original 24-hour window still governs admission, so elapsed windows may have closed during maintenance.

## Restore a matched database and inbox

To roll back the recurrence upgrade after multiple runs share a schedule revision, restore the matched pre-upgrade dump and inbox archive with the checkout revision recorded in that backup. The old database schema permits one run per schedule. Keep the upgraded database and inbox directories for diagnosis and recovery of runs created after the backup.

Stop the stack before switching its mounts. Prepare fresh PostgreSQL and inbox directories with the ownership and permissions from **Prepare the VM**, point Compose at both directories, and set the application's checkout to the recorded revision. Initialize the fresh PostgreSQL directory, then restore the matching database dump and trusted inbox archive. Adjust the inbox path below to the fresh configured mount.

```sh
(
    set -eu
    test -s "${ATLAS_BACKUP_DIR:?Set the private backup directory}/atlas.dump"
    test -s "$ATLAS_BACKUP_DIR/inbox.tar"
    atlas_compose up -d --wait db
    atlas_compose exec -T db pg_restore -U atlas_bootstrap --role=atlas_app --no-owner \
        --single-transaction --exit-on-error -d atlas < "$ATLAS_BACKUP_DIR/atlas.dump"
    sudo tar --numeric-owner -xpf "$ATLAS_BACKUP_DIR/inbox.tar" -C /srv/atlas/data/inbox
    atlas_compose build web
    atlas_compose run --rm -T web python manage.py migrate --noinput
    atlas_compose up -d --no-build --wait web worker
)
```

Check service health, the restored schedule and queue state, and a known run's metadata and artifact digests.

## Run the deterministic checks

Use an isolated Compose project and database mount. Start its `db` service, build `web`, and create the Django test database once in that isolated cluster. The application login has no `CREATEDB` privilege, so `--keepdb` reuses the separate database.

```sh
atlas_compose exec -T db createdb -U atlas_bootstrap -O atlas_app test_atlas
atlas_compose run --rm -T web python manage.py check
atlas_compose run --rm -T web python manage.py makemigrations --check --dry-run
atlas_compose run --rm -T web python manage.py migrate --noinput
atlas_compose run --rm -T web python manage.py migrate --check
atlas_compose run --rm -T worker python manage.py test --keepdb
```

## Verify the 24-hour cadence on the VM

Use a fresh loopback-only Compose project and persistent mounts prepared as above. Build from the candidate commit and keep the VM clock synchronized. Wait for the catalog, save the Iran PBF selection, and create a 1440-minute schedule with its activation in the future. Leave at least three planned occurrences before expiry to exercise a missed window.

Drive admissions at controlled UTC instants through `atlas_intake.control.dispatch_due(now=...)` in a Django shell in the candidate container. Poll the first planned instant concurrently from separate database connections and replay it to confirm exactly one run is admitted. Let the normal worker use the live provider and finish the run. Record the schedule cursor, run metadata, status and artifact hashes. Restart Compose, check service health and persistence, then repeat the exact-time admission at the next planned instant, 24 hours after the first.

Compare both runs' catalog intent counts and verify their final paths and bytes against their recorded hashes. Recheck the first run's hashes after the second run settles. To model an offline window, stop the isolated worker, skip polling the third slot, and poll at expiry. Confirm the dashboard shows expiry at the controlled time while the worker is offline. After polling at expiry, confirm the missed slot appears in the audit, the cursor advances and the run count stays at two. Record the controlled admission times and wall-clock transfer times separately.
