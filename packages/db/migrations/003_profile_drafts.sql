CREATE TABLE IF NOT EXISTS company_profile_drafts (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  answered_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_profile_version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_profiles_company_version_idx
  ON company_profiles(company_id, profile_version DESC);
