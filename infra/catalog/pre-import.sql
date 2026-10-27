-- Run by the admin role inside a NEW, empty render database (never an existing release DB).
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA render AUTHORIZATION seyra_render_import;
REVOKE ALL ON DATABASE :"render_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"render_db" TO seyra_render_import;
