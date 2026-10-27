-- Roles are provisioned by the database administrator, not by the parser/coordinator.
REVOKE ALL ON ALL TABLES IN SCHEMA atlas_control FROM PUBLIC;
GRANT USAGE ON SCHEMA atlas_control TO atlas_ingest_worker,atlas_ingest_reviewer,atlas_ingest_signer;
GRANT SELECT ON atlas_control.intake_instance,atlas_control.intake_jobs,atlas_control.intake_attempts,
  atlas_control.intake_validations,atlas_control.intake_baselines TO atlas_ingest_worker;
GRANT SELECT,INSERT,UPDATE ON atlas_control.intake_delivery_rejections TO atlas_ingest_worker;
GRANT INSERT ON atlas_control.intake_jobs,atlas_control.intake_attempts TO atlas_ingest_worker;
GRANT UPDATE(state,attempts,failures,lease_token,lease_until,next_attempt_at,validation_id,blob_verified,failure_code,updated_at)
  ON atlas_control.intake_jobs TO atlas_ingest_worker;
GRANT UPDATE(state,ended_at) ON atlas_control.intake_attempts TO atlas_ingest_worker;
GRANT INSERT(id,source_sha256,source_bytes,spec_sha256,provenance_sha256,region,manifest,state,worker_token)
  ON atlas_control.intake_validations TO atlas_ingest_worker;
GRANT UPDATE(state,worker_token,report_sha256,decision,decision_sha256,baseline_id,validated_at)
  ON atlas_control.intake_validations TO atlas_ingest_worker;
GRANT SELECT ON atlas_control.intake_instance,atlas_control.intake_jobs,atlas_control.intake_validations,
  atlas_control.intake_reviews,atlas_control.intake_baselines TO atlas_ingest_reviewer,atlas_ingest_signer;
GRANT INSERT ON atlas_control.intake_reviews,atlas_control.intake_baselines TO atlas_ingest_reviewer;
GRANT UPDATE(state) ON atlas_control.intake_validations TO atlas_ingest_reviewer;
GRANT UPDATE(validation_id,actor,rationale,updated_at) ON atlas_control.intake_baselines TO atlas_ingest_reviewer;
GRANT UPDATE(state,sign_token,sign_lease_until,sign_failures,sign_next_attempt_at,decision,decision_sha256,baseline_id,
  payload_sha256,bundle_sha256,public_key_sha256,accepted_at) ON atlas_control.intake_validations TO atlas_ingest_signer;
GRANT INSERT ON atlas_control.intake_events TO atlas_ingest_worker,atlas_ingest_reviewer,atlas_ingest_signer;
GRANT USAGE ON SEQUENCE atlas_control.intake_events_id_seq TO atlas_ingest_worker,atlas_ingest_reviewer,atlas_ingest_signer;
GRANT USAGE ON SEQUENCE atlas_control.intake_reviews_id_seq TO atlas_ingest_reviewer;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC',current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO atlas_ingest_worker,atlas_ingest_reviewer,atlas_ingest_signer',current_database());
END $$;
