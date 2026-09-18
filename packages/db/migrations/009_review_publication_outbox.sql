BEGIN;

CREATE TABLE IF NOT EXISTS review_publications (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  actor_id TEXT NOT NULL,
  reviewer_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(candidate_id,revision) REFERENCES review_revisions(candidate_id,revision),
  FOREIGN KEY(candidate_id,source_snapshot_id) REFERENCES legal_rule_candidates(id,source_snapshot_id)
);

CREATE TABLE IF NOT EXISTS review_publication_rules (
  publication_id TEXT NOT NULL REFERENCES review_publications(id),
  phase_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  compilation JSONB NOT NULL,
  PRIMARY KEY(publication_id,phase_id),
  UNIQUE(rule_id,rule_version),
  FOREIGN KEY(rule_id,rule_version) REFERENCES legal_rules(rule_id,version)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL REFERENCES review_publications(id),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((status = 'processed') = (processed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS outbox_available_idx ON outbox_events(available_at,created_at)
  WHERE status IN ('pending','failed');

COMMIT;
