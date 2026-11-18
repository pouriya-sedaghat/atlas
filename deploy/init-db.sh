#!/bin/sh
set -eu

ATLAS_APP_PASSWORD=$(cat /run/secrets/postgres_app_password)
test -n "$ATLAS_APP_PASSWORD"
export ATLAS_APP_PASSWORD

psql --no-psqlrc --no-password --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1 --set atlas_database="$POSTGRES_DB" <<'SQL'
SET log_min_error_statement = 'panic';
\getenv atlas_app_password ATLAS_APP_PASSWORD
CREATE ROLE atlas_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD :'atlas_app_password';
ALTER DATABASE :"atlas_database" OWNER TO atlas_app;
REVOKE CONNECT ON DATABASE :"atlas_database" FROM PUBLIC;
SQL
