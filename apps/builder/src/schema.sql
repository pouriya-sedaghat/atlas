-- Candidate component builds are not map releases and never mutate the default pointer.
CREATE TABLE IF NOT EXISTS atlas_control.candidate_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),root_sha256 text NOT NULL,
  id text NOT NULL DEFAULT replace(gen_random_uuid()::text,'-','')
);
CREATE TABLE IF NOT EXISTS atlas_control.candidate_jobs (
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),
  source_validation_id text NOT NULL REFERENCES atlas_control.intake_validations(id),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  pipeline_sha256 text NOT NULL CHECK(pipeline_sha256 ~ '^[0-9a-f]{64}$'),
  specification jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry_wait','component_verified','review_required','failed')),
  token text,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,
  stage text NOT NULL DEFAULT 'queued',next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  manifest_sha256 text,failure_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='running')=(token IS NOT NULL AND lease_until IS NOT NULL)),
  UNIQUE(source_validation_id,payload_sha256,pipeline_sha256)
);
CREATE TABLE IF NOT EXISTS atlas_control.candidate_attempts (
  token text PRIMARY KEY,job_id text NOT NULL REFERENCES atlas_control.candidate_jobs(id),ordinal integer NOT NULL,
  database_name text NOT NULL UNIQUE,owner_role text NOT NULL UNIQUE,import_role text NOT NULL UNIQUE,tile_role text NOT NULL UNIQUE,qa_role text NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('running','completed','failed','abandoned')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz,
  UNIQUE(job_id,ordinal)
);
CREATE TABLE IF NOT EXISTS atlas_control.candidate_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id text,token text,event text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE atlas_control.candidate_attempts ADD COLUMN IF NOT EXISTS data_target jsonb;
-- A serving incident holds admission until exact-attempt shutdown has been verified.
CREATE TABLE IF NOT EXISTS atlas_control.candidate_guard_incidents (
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),
  job_id text NOT NULL REFERENCES atlas_control.candidate_jobs(id),
  token text NOT NULL REFERENCES atlas_control.candidate_attempts(token),
  root_sha256 text NOT NULL,pipeline_sha256 text NOT NULL,
  evidence_sha256 text NOT NULL,evidence_text text NOT NULL CHECK(octet_length(evidence_text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  shutdown_confirmed_at timestamptz,shutdown_witness jsonb,
  UNIQUE(job_id,token),CHECK((shutdown_confirmed_at IS NULL)=(shutdown_witness IS NULL))
);
REVOKE ALL ON atlas_control.candidate_guard_incidents FROM PUBLIC;
GRANT SELECT,INSERT ON atlas_control.candidate_guard_incidents TO atlas_candidate_controller;
GRANT UPDATE(shutdown_confirmed_at,shutdown_witness) ON atlas_control.candidate_guard_incidents TO atlas_candidate_controller;
REVOKE ALL ON atlas_control.candidate_instance,atlas_control.candidate_jobs,atlas_control.candidate_attempts,atlas_control.candidate_events FROM PUBLIC;
GRANT USAGE ON SCHEMA atlas_control TO atlas_candidate_controller;
GRANT SELECT ON atlas_control.intake_instance,atlas_control.intake_validations,atlas_control.intake_baselines,atlas_control.intake_jobs TO atlas_candidate_controller;
GRANT SELECT,UPDATE ON atlas_control.processing_slot TO atlas_candidate_controller;
GRANT SELECT ON atlas_control.candidate_instance TO atlas_candidate_controller;
GRANT SELECT,INSERT,UPDATE ON atlas_control.candidate_jobs,atlas_control.candidate_attempts TO atlas_candidate_controller;
GRANT INSERT ON atlas_control.candidate_events TO atlas_candidate_controller;
GRANT USAGE ON SEQUENCE atlas_control.candidate_events_id_seq TO atlas_candidate_controller;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO atlas_candidate_controller',current_database()); END $$;
