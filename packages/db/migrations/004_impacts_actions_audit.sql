CREATE UNIQUE INDEX IF NOT EXISTS impact_assessment_identity_unique
  ON impact_assessments(company_id, profile_version, rule_id, rule_version);

CREATE INDEX IF NOT EXISTS impact_assessments_company_created_idx
  ON impact_assessments(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS action_items_impact_idx ON action_items(impact_id);
CREATE INDEX IF NOT EXISTS action_items_deadline_idx ON action_items(deadline) WHERE execution_status IN ('open','in_progress');

CREATE TABLE IF NOT EXISTS impact_feedback (
  id BIGSERIAL PRIMARY KEY,
  impact_id TEXT NOT NULL REFERENCES impact_assessments(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_company_created_idx ON audit_log(company_id, created_at DESC);
