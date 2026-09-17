CREATE TABLE IF NOT EXISTS legal_acts (
  act_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  number TEXT,
  issuer TEXT NOT NULL,
  publication_date DATE,
  official_url TEXT NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  verification_status TEXT NOT NULL,
  raw_text_hash TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legal_rules (
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  act_id TEXT NOT NULL REFERENCES legal_acts(act_id),
  seed_hash TEXT NOT NULL,
  legal_status TEXT NOT NULL,
  review_status TEXT NOT NULL,
  valid_from DATE,
  valid_to DATE,
  checked_at DATE NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, version)
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  owner_max_user_id TEXT,
  name TEXT,
  inn TEXT,
  pilot_segment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_profiles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  profile_version INTEGER NOT NULL,
  data JSONB NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, profile_version)
);

CREATE TABLE IF NOT EXISTS impact_assessments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  profile_version INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  review_state TEXT NOT NULL,
  compliance_state TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from DATE,
  previous_assessment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_id, rule_version) REFERENCES legal_rules(rule_id, version)
);

CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  impact_id TEXT NOT NULL REFERENCES impact_assessments(id),
  action_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  deadline DATE,
  deadline_kind TEXT NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'open',
  review_required BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (impact_id, action_key)
);

CREATE TABLE IF NOT EXISTS regulatory_relations (
  id BIGSERIAL PRIMARY KEY,
  from_rule_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_rule_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  effective_from DATE,
  evidence_ref TEXT,
  is_synthetic BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (from_rule_id, from_version, to_rule_id, to_version, relation_type)
);

CREATE TABLE IF NOT EXISTS demo_profile_fixtures (
  fixture_id TEXT PRIMARY KEY,
  seed_version TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demo_expected_assessments (
  fixture_key TEXT PRIMARY KEY,
  seed_version TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seed_execution_log (
  id BIGSERIAL PRIMARY KEY,
  seed_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_acts INTEGER NOT NULL DEFAULT 0,
  created_rules INTEGER NOT NULL DEFAULT 0,
  created_profiles INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
