BEGIN;
CREATE TABLE IF NOT EXISTS business_fact_definitions (
  fact_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), semantic_key TEXT NOT NULL,
  definition JSONB NOT NULL, origin TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(fact_key,version), UNIQUE(semantic_key,version)
);
CREATE TABLE IF NOT EXISTS business_fact_observations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  fact_key TEXT NOT NULL, definition_version INTEGER NOT NULL,
  scope_id TEXT NOT NULL, period_key TEXT NOT NULL, period JSONB NOT NULL,
  value JSONB NOT NULL, confirmed_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(fact_key,definition_version) REFERENCES business_fact_definitions(fact_key,version)
);
CREATE INDEX IF NOT EXISTS fact_history_company ON business_fact_observations(company_id,fact_key,created_at DESC);
-- A mutable index over immutable observations, never the history itself.
CREATE TABLE IF NOT EXISTS company_fact_current (
  company_id TEXT NOT NULL REFERENCES companies(id), fact_key TEXT NOT NULL, definition_version INTEGER NOT NULL,
  scope_id TEXT NOT NULL, period_key TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES business_fact_observations(id),
  value JSONB NOT NULL, text_value TEXT, number_value NUMERIC, boolean_value BOOLEAN,
  confirmed_at TIMESTAMPTZ NOT NULL, fresh_until TIMESTAMPTZ,
  PRIMARY KEY(company_id,fact_key,definition_version,scope_id,period_key)
);
CREATE INDEX IF NOT EXISTS fact_target_text ON company_fact_current(fact_key,definition_version,period_key,text_value,company_id);
CREATE INDEX IF NOT EXISTS fact_target_number ON company_fact_current(fact_key,definition_version,period_key,number_value,company_id);
CREATE INDEX IF NOT EXISTS fact_target_boolean ON company_fact_current(fact_key,definition_version,period_key,boolean_value,company_id);
CREATE INDEX IF NOT EXISTS fact_target_arrays ON company_fact_current USING GIN(value jsonb_path_ops);
CREATE INDEX IF NOT EXISTS fact_expiry ON company_fact_current(fresh_until,company_id) WHERE fresh_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS business_fact_sync (
  company_id TEXT PRIMARY KEY REFERENCES companies(id), profile_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_fact_dependencies (
  rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, field TEXT NOT NULL,
  fact_key TEXT NOT NULL, definition_version INTEGER NOT NULL, requirement JSONB NOT NULL,
  PRIMARY KEY(rule_id,rule_version,field),
  FOREIGN KEY(rule_id,rule_version) REFERENCES legal_rules(rule_id,version),
  FOREIGN KEY(fact_key,definition_version) REFERENCES business_fact_definitions(fact_key,version)
);
CREATE INDEX IF NOT EXISTS rules_by_fact ON rule_fact_dependencies(fact_key,definition_version,rule_id);
CREATE TABLE IF NOT EXISTS fact_answer_requests (
  company_id TEXT NOT NULL REFERENCES companies(id), request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,request_id)
);
CREATE TABLE IF NOT EXISTS candidate_automation (
  candidate_id TEXT PRIMARY KEY REFERENCES legal_rule_candidates(id),
  state TEXT NOT NULL CHECK(state IN ('pending','published','needs_review')),
  gate_version TEXT NOT NULL, issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE impact_assessments ADD COLUMN IF NOT EXISTS calculation_key TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE impact_assessments ADD COLUMN IF NOT EXISTS fact_context JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE impact_assessments ADD COLUMN IF NOT EXISTS clarification_state TEXT;
ALTER TABLE impact_assessments ADD COLUMN IF NOT EXISTS next_fact_check_at TIMESTAMPTZ;
DROP INDEX IF EXISTS impact_assessment_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS impact_assessment_identity_unique ON impact_assessments(company_id,profile_version,rule_id,rule_version,time_state,calculation_key);
CREATE INDEX IF NOT EXISTS impact_fact_refresh ON impact_assessments(next_fact_check_at) WHERE next_fact_check_at IS NOT NULL;
ALTER TABLE company_recalculation_jobs ADD COLUMN IF NOT EXISTS rule_ids JSONB;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS fanout_cursor TEXT;
ALTER TABLE outbox_events ALTER COLUMN aggregate_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='outbox_events'::regclass AND conname='outbox_aggregate_guard') THEN
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_aggregate_guard CHECK(aggregate_id IS NOT NULL OR event_type='rule.refresh');
  END IF;
END $$;
ALTER TABLE review_publications ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'human';
CREATE OR REPLACE FUNCTION reject_fact_history_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_FACT_HISTORY'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_fact_definitions ON business_fact_definitions;
CREATE TRIGGER immutable_fact_definitions BEFORE UPDATE OR DELETE ON business_fact_definitions FOR EACH ROW EXECUTE FUNCTION reject_fact_history_mutation();
DROP TRIGGER IF EXISTS immutable_fact_observations ON business_fact_observations;
CREATE TRIGGER immutable_fact_observations BEFORE UPDATE OR DELETE ON business_fact_observations FOR EACH ROW EXECUTE FUNCTION reject_fact_history_mutation();
COMMIT;
