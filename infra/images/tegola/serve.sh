#!/usr/bin/env bash
# Serve one release's Tegola configuration. The DB password is read from a mounted secret file
# into this process environment only (Tegola substitutes ${SEYRA_TILE_DB_PASSWORD}); it never
# appears in the container configuration, command line or logs.
set -euo pipefail
config="${SEYRA_TEGOLA_CONFIG:-/srv/release/tegola/tegola.toml}"
secret="${SEYRA_TILE_DB_PASSWORD_FILE:-/run/secrets/tile_db_password}"
test -r "$config" || { echo "missing Tegola config $config" >&2; exit 3; }
test -r "$secret" || { echo "missing tile reader secret" >&2; exit 3; }
SEYRA_TILE_DB_PASSWORD="$(tr -d '\n' < "$secret")"
export SEYRA_TILE_DB_PASSWORD
exec /usr/local/bin/tegola serve --config "$config" --log-level "${TEGOLA_LOG_LEVEL:-INFO}"
