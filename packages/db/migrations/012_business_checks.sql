BEGIN;
CREATE TABLE IF NOT EXISTS business_check_answers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  check_key TEXT NOT NULL,
  check_version INTEGER NOT NULL CHECK(check_version>0),
  impact_id TEXT NOT NULL REFERENCES impact_assessments(id),
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  basis_hash TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  answer TEXT NOT NULL CHECK(answer IN ('present','missing','unknown')),
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id,request_id),
  FOREIGN KEY(rule_id,rule_version) REFERENCES legal_rules(rule_id,version)
);
CREATE INDEX IF NOT EXISTS business_check_answers_current
  ON business_check_answers(company_id,check_key,created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION protect_business_check_answers() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BUSINESS_CHECK_HISTORY_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS business_check_answers_immutable ON business_check_answers;
CREATE TRIGGER business_check_answers_immutable BEFORE UPDATE OR DELETE ON business_check_answers
  FOR EACH ROW EXECUTE FUNCTION protect_business_check_answers();
COMMIT;
