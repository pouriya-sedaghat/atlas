-- Seyra control metadata (map release audit trail only). No user, tracking, relation, SOS or
-- authentication tables: those modules require their own requirements intake.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE seyra_control.release_events (
  id bigserial PRIMARY KEY,
  dataset_id text NOT NULL CHECK (dataset_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  event text NOT NULL CHECK (event IN ('imported', 'import_failed', 'activation_started', 'activated', 'activation_failed', 'recovered', 'rollback', 'pruned')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_events_dataset_idx ON seyra_control.release_events (dataset_id, occurred_at);

-- Runtime API role: read-only on control metadata; geography distance uses PostGIS functions only.
GRANT USAGE ON SCHEMA seyra_control TO seyra_api;
GRANT SELECT ON ALL TABLES IN SCHEMA seyra_control TO seyra_api;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
