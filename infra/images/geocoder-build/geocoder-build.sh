#!/usr/bin/env bash
# Build-time geocoder export: temporary Nominatim database -> Photon JSON dump.
#   /in/input.osm.pbf   owner-supplied source (read-only mount)
#   /work               job-owned temporary workspace (deleted contents only after success)
#   /out                staging output directory for the export (must be empty)
# No network access is required: auxiliary Wikipedia/importance/phrase data is not used and
# the database listens on loopback inside this container only.
set -euo pipefail
threads="${SEYRA_BUILD_THREADS:-2}"
in=/in/input.osm.pbf
work=/work
out=/out
test -r "$in" || { echo "missing input $in" >&2; exit 2; }
if [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "refusing to write into non-empty $out" >&2; exit 2; fi
if [ -n "$(ls -A "$work" 2>/dev/null)" ]; then echo "refusing to reuse non-empty workspace $work" >&2; exit 2; fi

PGBIN=/usr/lib/postgresql/16/bin
export PGDATA="$work/pgdata" PGHOST="$work/run" PGPORT=5432
mkdir -p "$PGHOST" "$work/project"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth-local=peer --auth-host=reject -E UTF8 --locale=C.UTF-8 >/dev/null
cat >> "$PGDATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PGHOST'
fsync = off
synchronous_commit = off
full_page_writes = off
max_wal_size = 4GB
shared_buffers = ${SEYRA_BUILD_PG_SHARED_BUFFERS:-512MB}
maintenance_work_mem = ${SEYRA_BUILD_PG_MAINT_MEM:-1GB}
work_mem = 64MB
CONF
# Peer auth on the local socket; loopback TCP only for the Photon JDBC export. The server
# listens on 127.0.0.1 inside this ephemeral, network-less container.
cat > "$PGDATA/pg_hba.conf" <<HBA
local all all peer
host all postgres 127.0.0.1/32 trust
HBA
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$work/postgres.log" -w start >/dev/null
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Nominatim requires its (unused) web role to exist as a login role; pg_hba still rejects it.
psql -q -d postgres -c 'CREATE ROLE "www-data" LOGIN' >/dev/null

cd "$work/project"
cat > .env <<ENV
NOMINATIM_DATABASE_DSN="pgsql:dbname=nominatim;host=$PGHOST;port=$PGPORT;user=postgres"
NOMINATIM_DATABASE_WEBUSER=www-data
NOMINATIM_OSM2PGSQL_BINARY=/usr/local/bin/osm2pgsql
NOMINATIM_TOKENIZER=icu
ENV
echo "[geocoder] nominatim import (reverse-only, no updates)"
/opt/nominatim/bin/nominatim import --osm-file "$in" --threads "$threads" --reverse-only --no-updates 2>&1 | sed 's/^/[nominatim] /'
echo "[geocoder] photon export"
java ${PHOTON_JAVA_OPTS:--Xmx1g} -jar /opt/photon/photon.jar dump-nominatim-db \
  -host 127.0.0.1 -port 5432 -database nominatim -user postgres \
  -languages fa,en -extra-tags ALL -export-file "$out/nominatim-export.jsonl" 2>&1 | sed 's/^/[photon-dump] /'
test -s "$out/nominatim-export.jsonl" || { echo "empty Photon export" >&2; exit 4; }
/opt/nominatim/bin/nominatim --version > "$out/nominatim-version.txt"
cleanup
trap - EXIT
# Remove only the job-owned temporary database/project after a verified export.
rm -rf "$PGDATA" "$PGHOST" "$work/project" "$work/postgres.log"
echo "[geocoder] export complete: $(wc -l < "$out/nominatim-export.jsonl") records"
