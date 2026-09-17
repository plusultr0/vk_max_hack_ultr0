CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  number TEXT,
  issuer TEXT,
  publication_date TEXT,
  official_url TEXT NOT NULL,
  source_dataset_url TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  raw JSONB NOT NULL,
  relevance_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  relevance_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_state TEXT NOT NULL DEFAULT 'unreviewed',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS source_documents_relevance_idx
  ON source_documents(review_state, relevance_score DESC, publication_date DESC);

CREATE TABLE IF NOT EXISTS legal_rule_candidates (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT NOT NULL,
  draft JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_state TEXT NOT NULL DEFAULT 'pending',
  reviewer_note TEXT,
  approved_rule_id TEXT,
  approved_rule_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS legal_rule_candidates_review_idx
  ON legal_rule_candidates(review_state, created_at DESC);
