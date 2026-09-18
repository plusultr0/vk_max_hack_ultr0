BEGIN;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS company_recalculation_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES outbox_events(id),
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recalc_due_idx ON company_recalculation_jobs(available_at,id) WHERE status <> 'processed';
CREATE INDEX IF NOT EXISTS recalc_event_idx ON company_recalculation_jobs(event_id,status);
CREATE OR REPLACE FUNCTION enqueue_profile_recalculation() RETURNS trigger AS $$ BEGIN
  INSERT INTO company_recalculation_jobs(company_id,request_key)
  VALUES(NEW.company_id,'profile:' || NEW.company_id || ':' || NEW.profile_version) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS profile_recalculation ON company_profiles;
CREATE TRIGGER profile_recalculation AFTER INSERT ON company_profiles FOR EACH ROW EXECUTE FUNCTION enqueue_profile_recalculation();
CREATE OR REPLACE FUNCTION lock_company_profile_write() RETURNS trigger AS $$ BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS profile_company_lock ON company_profiles;
CREATE TRIGGER profile_company_lock BEFORE INSERT ON company_profiles FOR EACH ROW EXECUTE FUNCTION lock_company_profile_write();

ALTER TABLE impact_assessments ADD COLUMN IF NOT EXISTS time_state TEXT NOT NULL DEFAULT 'active';
DROP INDEX IF EXISTS impact_assessment_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS impact_assessment_identity_unique ON impact_assessments(company_id,profile_version,rule_id,rule_version,time_state);
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS semantic_hash TEXT;
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS carried_from_action_id TEXT REFERENCES action_items(id);
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS claim_token TEXT;
CREATE TABLE IF NOT EXISTS bot_webhook_events (
  event_key TEXT PRIMARY KEY,
  update_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_documents(id),
  request_key TEXT NOT NULL UNIQUE,
  input JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  claim_token TEXT,
  candidate_id TEXT REFERENCES legal_rule_candidates(id),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS extraction_due_idx ON extraction_jobs(available_at) WHERE status <> 'processed';
COMMIT;
