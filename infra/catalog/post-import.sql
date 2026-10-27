-- Run by the admin role after osm2pgsql finished. Records release identity, freezes the
-- database (import role loses ownership/write access) and grants read-only tile access.
\set ON_ERROR_STOP on
CREATE TABLE render.seyra_release (
  dataset_id text PRIMARY KEY,
  source_sha256 text NOT NULL,
  catalog_version text NOT NULL,
  pipeline_version text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO render.seyra_release (dataset_id, source_sha256, catalog_version, pipeline_version)
VALUES (:'dataset_id', :'source_sha256', :'catalog_version', :'pipeline_version');

-- Freeze: hand every object to the admin role, then remove the import role's access.
REASSIGN OWNED BY seyra_render_import TO CURRENT_USER;
REVOKE ALL ON SCHEMA render FROM seyra_render_import;
REVOKE ALL ON ALL TABLES IN SCHEMA render FROM seyra_render_import;
REVOKE CONNECT, TEMPORARY ON DATABASE :"render_db" FROM seyra_render_import;

GRANT CONNECT ON DATABASE :"render_db" TO seyra_tile_reader;
GRANT USAGE ON SCHEMA render TO seyra_tile_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA render TO seyra_tile_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA render REVOKE ALL ON TABLES FROM PUBLIC;

ANALYZE;
