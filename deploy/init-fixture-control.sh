#!/bin/sh
set -eu
ATLAS_PROVISIONER_PASSWORD=$(cat /run/secrets/postgres_provisioner_password)
export ATLAS_PROVISIONER_PASSWORD
psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
SET log_min_error_statement='panic';
\getenv provisioner_password ATLAS_PROVISIONER_PASSWORD
CREATE ROLE atlas_build_provisioner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
 PASSWORD :'provisioner_password';
GRANT CONNECT ON DATABASE atlas_fixture TO atlas_build_provisioner;
GRANT USAGE ON SCHEMA public TO atlas_build_provisioner;
SQL
