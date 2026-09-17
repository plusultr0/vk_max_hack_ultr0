BEGIN;

CREATE TABLE IF NOT EXISTS source_snapshots (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_documents(id),
  text_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE legal_rule_candidates
  ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT REFERENCES source_snapshots(id);

CREATE OR REPLACE FUNCTION protect_source_snapshot() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SOURCE_SNAPSHOT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_snapshot_immutable ON source_snapshots;
CREATE TRIGGER source_snapshot_immutable BEFORE UPDATE OR DELETE ON source_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_source_snapshot();

CREATE OR REPLACE FUNCTION protect_candidate_extraction() RETURNS trigger AS $$
BEGIN
  IF NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.draft IS DISTINCT FROM OLD.draft
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version THEN
    RAISE EXCEPTION 'CANDIDATE_EXTRACTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidate_extraction_immutable ON legal_rule_candidates;
CREATE TRIGGER candidate_extraction_immutable BEFORE UPDATE ON legal_rule_candidates
  FOR EACH ROW EXECUTE FUNCTION protect_candidate_extraction();

COMMIT;
