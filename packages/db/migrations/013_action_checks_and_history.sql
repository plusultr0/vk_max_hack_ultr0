BEGIN;
-- Action checklist writes keep only request receipts here. The execution status
-- itself lives exclusively in action_items, shared by Mini App and the bot.
CREATE TABLE IF NOT EXISTS business_check_action_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action_id TEXT NOT NULL REFERENCES action_items(id),
  check_key TEXT NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('present','missing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id,request_id)
);
-- Existing 0.9.18 checklist observations are immutable history. Import a matching
-- explicit answer at most once, never over a more recent action/bot update.
CREATE TABLE IF NOT EXISTS business_check_action_imports (
  legacy_answer_id TEXT PRIMARY KEY REFERENCES business_check_answers(id),
  action_id TEXT NOT NULL REFERENCES action_items(id),
  applied BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_company_id_desc
  ON audit_log(company_id,id DESC);
COMMIT;
