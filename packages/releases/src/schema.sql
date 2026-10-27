-- One small control schema; never the imported rendering/raw database.
CREATE SCHEMA IF NOT EXISTS atlas_control;
REVOKE ALL ON SCHEMA atlas_control FROM PUBLIC;
CREATE TABLE IF NOT EXISTS atlas_control.releases (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  endpoints jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','available','draining','retired','deleting','deleted','quarantined')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  retired_at timestamptz,
  pinned boolean NOT NULL DEFAULT false,
  deletion_token text
);
CREATE TABLE IF NOT EXISTS atlas_control.defaults (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 0,
  current_id text REFERENCES atlas_control.releases(id),
  previous_id text REFERENCES atlas_control.releases(id)
);
INSERT INTO atlas_control.defaults(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS atlas_control.sessions (
  token_sha256 text PRIMARY KEY,
  release_id text NOT NULL REFERENCES atlas_control.releases(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX IF NOT EXISTS sessions_release_expiry ON atlas_control.sessions(release_id,expires_at);
CREATE TABLE IF NOT EXISTS atlas_control.requests (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES atlas_control.releases(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_release_expiry ON atlas_control.requests(release_id,expires_at);
CREATE TABLE IF NOT EXISTS atlas_control.build_references (
  job_id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES atlas_control.releases(id)
);
CREATE TABLE IF NOT EXISTS atlas_control.events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event text NOT NULL,
  release_id text,
  detail jsonb NOT NULL DEFAULT '{}'
);
