-- Additive intake control schema. Import/data-serving roles must not own this schema.
CREATE SCHEMA IF NOT EXISTS atlas_control;
REVOKE ALL ON SCHEMA atlas_control FROM PUBLIC;
CREATE TABLE IF NOT EXISTS atlas_control.intake_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  id text NOT NULL DEFAULT replace(gen_random_uuid()::text,'-',''),
  root_sha256 text
);
INSERT INTO atlas_control.intake_instance(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS atlas_control.intake_jobs (
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{32}$'),
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  spec_sha256 text NOT NULL CHECK(spec_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry_wait','completed','rejected','failed')),
  attempts integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  validation_id text,
  blob_verified boolean NOT NULL DEFAULT false,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS intake_jobs_schedule ON atlas_control.intake_jobs(state,next_attempt_at,created_at);
CREATE TABLE IF NOT EXISTS atlas_control.intake_delivery_rejections (
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{32}$'),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS atlas_control.intake_attempts (
  token text PRIMARY KEY CHECK(token ~ '^[0-9a-f]{32}$'),
  job_id text NOT NULL REFERENCES atlas_control.intake_jobs(id),
  ordinal integer NOT NULL,
  state text NOT NULL CHECK(state IN ('running','completed','failed','abandoned','cleaned')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  UNIQUE(job_id,ordinal)
);
CREATE TABLE IF NOT EXISTS atlas_control.intake_validations (
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{32}$'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bigint NOT NULL CHECK(source_bytes>0),
  spec_sha256 text NOT NULL CHECK(spec_sha256 ~ '^[0-9a-f]{64}$'),
  provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
  region text NOT NULL,
  manifest jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('processing','review_required','signing_pending','signing','accepted','rejected')),
  worker_token text,
  report_sha256 text,
  decision jsonb,
  decision_sha256 text,
  baseline_id text,
  validated_at timestamptz,
  sign_token text,
  sign_lease_until timestamptz,
  sign_failures integer NOT NULL DEFAULT 0,
  sign_next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload_sha256 text,
  bundle_sha256 text,
  public_key_sha256 text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_sha256,spec_sha256,provenance_sha256),
  CHECK((state='signing')=(sign_token IS NOT NULL AND sign_lease_until IS NOT NULL)),
  CHECK(state<>'accepted' OR (payload_sha256 IS NOT NULL AND bundle_sha256 IS NOT NULL AND public_key_sha256 IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS atlas_control.intake_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  validation_id text NOT NULL REFERENCES atlas_control.intake_validations(id),
  report_sha256 text NOT NULL,
  decision_sha256 text NOT NULL,
  action text NOT NULL CHECK(action IN ('approve','reject')),
  actor text NOT NULL,
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(validation_id,decision_sha256)
);
CREATE TABLE IF NOT EXISTS atlas_control.intake_baselines (
  region text PRIMARY KEY,
  validation_id text NOT NULL REFERENCES atlas_control.intake_validations(id),
  actor text NOT NULL,
  rationale text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS atlas_control.intake_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id text,
  validation_id text,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
