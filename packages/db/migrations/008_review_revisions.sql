BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_snapshot_identity ON legal_rule_candidates(id,source_snapshot_id);
CREATE TABLE IF NOT EXISTS review_drafts (
  candidate_id TEXT PRIMARY KEY,
  source_snapshot_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(candidate_id,source_snapshot_id) REFERENCES legal_rule_candidates(id,source_snapshot_id)
);
CREATE TABLE IF NOT EXISTS review_revisions (
  candidate_id TEXT NOT NULL REFERENCES review_drafts(candidate_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('draft','ready')),
  document JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  compilation JSONB NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id,revision)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='review_current_revision_fk' AND conrelid='review_drafts'::regclass) THEN
    ALTER TABLE review_drafts ADD CONSTRAINT review_current_revision_fk FOREIGN KEY(candidate_id,current_revision)
      REFERENCES review_revisions(candidate_id,revision) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION protect_review_revision() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'REVIEW_REVISION_IMMUTABLE';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_revision_immutable ON review_revisions;
CREATE TRIGGER review_revision_immutable BEFORE UPDATE OR DELETE ON review_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_review_revision();

CREATE OR REPLACE FUNCTION protect_review_identity() RETURNS trigger AS $$ BEGIN
  IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.current_revision <> OLD.current_revision + 1 THEN
    RAISE EXCEPTION 'REVIEW_HEAD_INVALID_CHANGE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_identity_immutable ON review_drafts;
CREATE TRIGGER review_identity_immutable BEFORE UPDATE ON review_drafts FOR EACH ROW EXECUTE FUNCTION protect_review_identity();

CREATE OR REPLACE FUNCTION protect_candidate_review_state() RETURNS trigger AS $$ BEGIN
  IF OLD.review_state IN ('approved','rejected') AND NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    RAISE EXCEPTION 'CANDIDATE_TERMINAL_STATE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS candidate_review_state_guard ON legal_rule_candidates;
CREATE TRIGGER candidate_review_state_guard BEFORE UPDATE ON legal_rule_candidates FOR EACH ROW EXECUTE FUNCTION protect_candidate_review_state();

COMMIT;
