# Atlas Part 1A operator guide

## Prepare the VM

Run the commands from the Atlas checkout. The application image runs web and worker processes as UID/GID `10001:10001`. The pinned PostgreSQL image uses `999:999`. The database listens only on the internal Compose network. Gunicorn is mapped to VM loopback, and only the worker can write to the inbox.

Provision the VM directories and secrets once for a new deployment. If the data lives on a dedicated volume, mount it before preparing these directories. Compose preserves the host permissions on secret files. Both PostgreSQL and the application need to read the application password.

```sh
sudo install -d -m 0755 /srv/atlas /srv/atlas/data
sudo install -d -m 0700 -o 999 -g 999 /srv/atlas/data/postgres
sudo install -d -m 0700 -o 10001 -g 10001 /srv/atlas/data/inbox
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
sudo chmod 0400 /srv/atlas/secrets/postgres_bootstrap_password /srv/atlas/secrets/django_secret_key
sudo chmod 0440 /srv/atlas/secrets/postgres_app_password
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
3. Open the run detail to inspect progress, the source and checksum records, relative paths, and any incomplete files. Use **Retry file** for an eligible individual failure. A PBF retry retains its saved dated target and any established validators. A vanished or changed dated file requires a new run. A stale boundary shows its previous retrieval date and cannot satisfy the current run.
4. For a one-off automatic retrieval, save the desired selection and schedule a local date and time with its IANA zone. The form asks for a UTC offset when the wall time occurs twice and rejects a nonexistent time. The worker dispatches a pending occurrence within 24 hours after its due time. Switching to Manual supersedes a pending occurrence. Each dispatched run keeps its saved zone and groups by the local date on which it was created.

Record the frozen revision, selection and region counts, checksums, relevant validators, relative inbox paths and seal status. Only a sealed run with verified current integrity can feed a later phase. Review capacity before a second intentional launch. Keep finalized assets and manifests throughout Part 1A.

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

Use the actual path from the run. On restart, the worker reconciles durable publication intents, expired claims, and existing final files. If a completed file is absent or its fingerprint has changed, keep the original record and the affected bytes for review. If an update includes a migration, stop the web and worker, build the new image, apply migrations explicitly, then start both services and check health. If the database failed during its first initialization, check its logs and the host secret ownership. After correcting the cause, preserve the partially initialized directory and point Compose to a new, empty directory. Recover a database that already contains operator data from the matching backup.

For a consistent operator backup, set `ATLAS_BACKUP_DIR` to an existing private backup directory outside the checkout, on persistent storage. Use a new destination for each backup. Stop both app processes while capturing the matching database dump and inbox tree. Include the VM deployment configuration and secret files in the VM's private backup procedure.

```sh
(
    set -eu
    test -d "${ATLAS_BACKUP_DIR:?Set a private backup directory}"
    atlas_compose stop web worker
    umask 077
    atlas_compose exec -T db pg_dump -U atlas_bootstrap -d atlas -Fc > "$ATLAS_BACKUP_DIR/atlas.dump"
    sudo tar --numeric-owner -C /srv/atlas/data/inbox -cf - . > "$ATLAS_BACKUP_DIR/inbox.tar"
    atlas_compose up -d --wait web worker
)
```

Restore into fresh PostgreSQL and inbox directories with the stopped stack and keep the prior directories for diagnosis. Initialize the fresh database with `atlas_compose up -d --wait db`. Restore the matching dump with `pg_restore` as bootstrap using the application role and extract the trusted inbox archive preserving numeric ownership. Apply migrations with the matching application checkout, start the services, then recheck health, a known run and its artifact digests. Adjust the inbox path in the archive commands when using an alternate mount.

```sh
(
    set -eu
    atlas_compose exec -T db pg_restore -U atlas_bootstrap --role=atlas_app --no-owner \
        --single-transaction --exit-on-error -d atlas < "$ATLAS_BACKUP_DIR/atlas.dump"
    sudo tar --numeric-owner -xpf "$ATLAS_BACKUP_DIR/inbox.tar" -C /srv/atlas/data/inbox
    atlas_compose run --rm web python manage.py migrate --noinput
    atlas_compose up -d --wait web worker
)
```

## Run the deterministic checks

Use an isolated Compose project and database mount. Start its `db` service, build `web`, and create the Django test database once in that isolated cluster. The application login has no `CREATEDB` privilege, so `--keepdb` reuses the separate database.

```sh
atlas_compose exec -T db createdb -U atlas_bootstrap -O atlas_app test_atlas
atlas_compose run --rm -T web python manage.py check
atlas_compose run --rm -T web python manage.py makemigrations --check --dry-run
atlas_compose run --rm -T worker python manage.py test --keepdb
```
