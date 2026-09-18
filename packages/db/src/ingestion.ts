import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { LegalRuleSchema, type LegalRule } from '@reg/domain';
import type { SourceDocument } from '@reg/ingestion';
import { EXTRACTION_VERSION, regulatoryReviewWarnings, validateRegulatoryExtraction, type RegulatoryExtraction } from '@reg/llm';
import { seedHash } from './canonical.js';
import { getPool } from './client.js';
import { recalculateRuleForAllCompanies } from './impacts.js';
import { reviewRequirements } from '@reg/review';

export async function startIngestionRun(source: string, sourceUrl: string) {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO ingestion_runs(id,source,source_url,status) VALUES($1,$2,$3,'running')`,
    [id, source, sourceUrl],
  );
  return id;
}

export async function finishIngestionRun(input: {
  runId: string;
  status: 'success'|'failed';
  fetchedCount?: number;
  createdCount?: number;
  changedCount?: number;
  candidateCount?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await getPool().query(
    `UPDATE ingestion_runs SET status=$2,fetched_count=$3,created_count=$4,changed_count=$5,candidate_count=$6,
      error=$7,metadata=$8,finished_at=now() WHERE id=$1`,
    [input.runId, input.status, input.fetchedCount ?? 0, input.createdCount ?? 0, input.changedCount ?? 0,
      input.candidateCount ?? 0, input.error ?? null, JSON.stringify(input.metadata ?? {})],
  );
}

export async function stageSourceDocuments(input: {
  documents: SourceDocument[];
  relevance: (document: SourceDocument) => { score: number; matchedTerms: string[] };
}) {
  const client = await getPool().connect();
  let created = 0;
  let changed = 0;
  let candidates = 0;
  const documentIds: string[] = [];
  try {
    await client.query('BEGIN');
    for (const document of input.documents) {
      const sourcePrefix = document.source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'source';
      const externalPart = document.externalId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48);
      const id = `${sourcePrefix}-${externalPart}`;
      documentIds.push(id);
      const existing = await client.query('SELECT raw_hash FROM source_documents WHERE source=$1 AND external_id=$2', [document.source, document.externalId]);
      const relevant = input.relevance(document);
      const reviewState = relevant.score >= 0.25 ? 'candidate' : 'unreviewed';
      if (!existing.rowCount) created += 1;
      else if (existing.rows[0].raw_hash !== document.rawHash) changed += 1;
      if (reviewState === 'candidate') candidates += 1;
      await client.query(
        `INSERT INTO source_documents(
          id,source,external_id,title,number,issuer,publication_date,official_url,source_dataset_url,
          raw_hash,raw,relevance_score,relevance_terms,review_state,first_seen_at,last_seen_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now(),now())
        ON CONFLICT(source,external_id) DO UPDATE SET
          title=EXCLUDED.title,number=EXCLUDED.number,issuer=EXCLUDED.issuer,publication_date=EXCLUDED.publication_date,
          official_url=EXCLUDED.official_url,source_dataset_url=EXCLUDED.source_dataset_url,raw_hash=EXCLUDED.raw_hash,
          raw=EXCLUDED.raw,relevance_score=EXCLUDED.relevance_score,relevance_terms=EXCLUDED.relevance_terms,
          review_state=CASE
            WHEN source_documents.raw_hash <> EXCLUDED.raw_hash THEN EXCLUDED.review_state
            WHEN source_documents.review_state IN ('approved','rejected') THEN source_documents.review_state
            ELSE EXCLUDED.review_state
          END,
          last_seen_at=now(),updated_at=now()`,
        [id, document.source, document.externalId, document.title, document.number, document.issuer,
          document.publicationDate, document.officialUrl, document.sourceDatasetUrl, document.rawHash,
          JSON.stringify(document.raw), relevant.score, JSON.stringify(relevant.matchedTerms), reviewState],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { created, changed, candidates, documentIds };
}

export async function listSourceDocuments(input: { state?: string; limit?: number } = {}) {
  const values: unknown[] = [];
  let where = '';
  if (input.state) {
    values.push(input.state);
    where = `WHERE review_state=$${values.length}`;
  }
  values.push(input.limit ?? 100);
  const result = await getPool().query(
    `SELECT id,source,external_id,title,number,issuer,publication_date,official_url,relevance_score,relevance_terms,review_state,first_seen_at,last_seen_at
     FROM source_documents ${where} ORDER BY relevance_score DESC, publication_date DESC NULLS LAST LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function getSourceDocument(id: string) {
  const result = await getPool().query('SELECT * FROM source_documents WHERE id=$1', [id]);
  return result.rows[0] ?? null;
}

export async function saveRuleCandidate(input: {
  sourceDocumentId: string;
  provider: string;
  model?: string | null;
  draft: RegulatoryExtraction;
}, transaction?: PoolClient) {
  const extraction = validateRegulatoryExtraction(input.draft);
  const { sourceSnapshot, ...draft } = extraction;
  const id = randomUUID();
  const snapshotId = randomUUID();
  const client = transaction ?? await getPool().connect();
  try {
    if (!transaction) await client.query('BEGIN');
    const source = await client.query('SELECT official_url FROM source_documents WHERE id=$1 FOR SHARE', [input.sourceDocumentId]);
    if (!source.rowCount) throw new Error('SOURCE_DOCUMENT_NOT_FOUND');
    if (source.rows[0].official_url !== sourceSnapshot.officialUrl) throw new Error('SOURCE_SNAPSHOT_URL_MISMATCH');
    await client.query(
      'INSERT INTO source_snapshots(id,source_document_id,text_hash,snapshot) VALUES($1,$2,$3,$4)',
      [snapshotId, input.sourceDocumentId, sourceSnapshot.textHash, JSON.stringify(sourceSnapshot)],
    );
    await client.query(
      `INSERT INTO legal_rule_candidates(id,source_document_id,source_snapshot_id,provider,model,prompt_version,draft,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, input.sourceDocumentId, snapshotId, input.provider, input.model ?? null, EXTRACTION_VERSION,
        JSON.stringify(draft), JSON.stringify(extraction.evidence)],
    );
    if (!transaction) await client.query('COMMIT');
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK');
    throw error;
  } finally { if (!transaction) client.release(); }
  return id;
}

export async function getRuleCandidate(id: string) {
  const result = await getPool().query(
    `SELECT c.*, s.snapshot AS source_snapshot, COALESCE(s.snapshot->>'sourceTitle',d.title) AS source_title
     FROM legal_rule_candidates c JOIN source_documents d ON d.id=c.source_document_id
     LEFT JOIN source_snapshots s ON s.id=c.source_snapshot_id WHERE c.id=$1`, [id],
  );
  const candidate = result.rows[0];
  if (!candidate) return null;
  if (candidate.source_snapshot) {
    const extraction = validateRegulatoryExtraction({ ...candidate.draft, sourceSnapshot: candidate.source_snapshot });
    return { ...candidate, review_warnings: regulatoryReviewWarnings(extraction), review_requirements: reviewRequirements(extraction) };
  }
  return { ...candidate, review_warnings: [{ code: 'LEGACY_REEXTRACTION_REQUIRED', message: 'Для этого черновика нет неизменяемого снимка; требуется повторное извлечение.' }] };
}

export async function listRuleCandidates(state = 'pending', limit = 100) {
  const result = await getPool().query(
    `SELECT c.*, COALESCE(s.snapshot->>'sourceTitle',d.title) AS source_title,
       COALESCE(s.snapshot->>'officialUrl',d.official_url) AS official_url
     FROM legal_rule_candidates c JOIN source_documents d ON d.id=c.source_document_id
     LEFT JOIN source_snapshots s ON s.id=c.source_snapshot_id
     WHERE c.review_state=$1 ORDER BY c.created_at DESC LIMIT $2`,
    [state, limit],
  );
  return result.rows;
}

export async function rejectRuleCandidate(id: string, note?: string) {
  const result = await getPool().query(
    `UPDATE legal_rule_candidates SET review_state='rejected',reviewer_note=$2,reviewed_at=now() WHERE id=$1 AND review_state='pending' RETURNING *`,
    [id, note ?? null],
  );
  if (!result.rowCount) {
    const exists = await getPool().query('SELECT 1 FROM legal_rule_candidates WHERE id=$1', [id]);
    if (exists.rowCount) throw new Error('CANDIDATE_ALREADY_REVIEWED');
  }
  return result.rows[0] ?? null;
}

export async function publishReviewedRuleCandidate(input: {
  candidateId: string;
  approvedRule: Omit<LegalRule, 'seedHash'> | LegalRule;
  reviewerNote?: string;
  relation?: { type: 'amends'|'supersedes'|'extends'|'cancels'; evidenceRef?: string | null; effectiveFrom?: string | null };
}) {
  const raw = { ...input.approvedRule } as Record<string, unknown>;
  delete raw.seedHash;
  const rule = LegalRuleSchema.parse({ ...raw, seedHash: seedHash(raw), reviewStatus: 'reviewed' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query('SELECT * FROM legal_rule_candidates WHERE id=$1 FOR UPDATE', [input.candidateId]);
    if (!candidate.rowCount) throw new Error('CANDIDATE_NOT_FOUND');
    if (candidate.rows[0].review_state !== 'pending') throw new Error('CANDIDATE_ALREADY_REVIEWED');
    const review = await client.query('SELECT 1 FROM review_drafts WHERE candidate_id=$1', [input.candidateId]);
    if (review.rowCount) throw new Error('REVIEW_REVISION_REQUIRES_BUNDLE_PUBLICATION');
    if (!candidate.rows[0].source_snapshot_id) throw new Error('LEGACY_CANDIDATE_REEXTRACTION_REQUIRED');
    const snapshotResult = await client.query('SELECT snapshot FROM source_snapshots WHERE id=$1', [candidate.rows[0].source_snapshot_id]);
    const extraction = validateRegulatoryExtraction({ ...candidate.rows[0].draft, sourceSnapshot: snapshotResult.rows[0]?.snapshot });
    if (extraction.phases.length !== 1) throw new Error('MULTI_PHASE_OR_EMPTY_CANDIDATE_REQUIRES_REVIEW_WORKFLOW');
    const actExisting = await client.query('SELECT 1 FROM legal_acts WHERE act_id=$1', [rule.actId]);
    if (!actExisting.rowCount) {
      const source = await client.query('SELECT * FROM source_documents WHERE id=$1', [candidate.rows[0].source_document_id]);
      if (!source.rowCount) throw new Error('SOURCE_DOCUMENT_NOT_FOUND');
      const doc = source.rows[0];
      await client.query(
        `INSERT INTO legal_acts(act_id,title,number,issuer,publication_date,official_url,retrieved_at,verification_status,raw_text_hash,data)
         VALUES($1,$2,$3,$4,$5,$6,now(),'reviewed',$7,$8)`,
        [rule.actId, extraction.sourceSnapshot.sourceTitle, doc.number, doc.issuer ?? 'Не указан', doc.publication_date || null,
          extraction.sourceSnapshot.officialUrl, extraction.sourceSnapshot.textHash,
          JSON.stringify({ sourceDocumentId: doc.id, source: doc.source, sourceSnapshotId: candidate.rows[0].source_snapshot_id })],
      );
    }
    const existing = await client.query('SELECT seed_hash FROM legal_rules WHERE rule_id=$1 AND version=$2', [rule.ruleId, rule.version]);
    if (existing.rowCount) {
      if (existing.rows[0].seed_hash !== rule.seedHash) throw new Error('IMMUTABLE_RULE_VERSION_CONFLICT');
    } else {
      await client.query(
        `INSERT INTO legal_rules(rule_id,version,act_id,seed_hash,legal_status,review_status,valid_from,valid_to,checked_at,data)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rule.ruleId, rule.version, rule.actId, rule.seedHash, rule.legalStatus, rule.reviewStatus,
          rule.validFrom, rule.validTo, rule.checkedAt, JSON.stringify(rule)],
      );
    }
    if (input.relation && rule.version > 1) {
      const previousVersion = rule.version - 1;
      const previous = await client.query('SELECT 1 FROM legal_rules WHERE rule_id=$1 AND version=$2', [rule.ruleId, previousVersion]);
      if (previous.rowCount) {
        await client.query(
          `INSERT INTO regulatory_relations(from_rule_id,from_version,to_rule_id,to_version,relation_type,effective_from,evidence_ref,is_synthetic)
           VALUES($1,$2,$1,$3,$4,$5,$6,false) ON CONFLICT DO NOTHING`,
          [rule.ruleId, previousVersion, rule.version, input.relation.type, input.relation.effectiveFrom ?? rule.checkedAt, input.relation.evidenceRef ?? null],
        );
      }
    }
    await client.query(
      `UPDATE legal_rule_candidates SET review_state='approved',reviewer_note=$2,approved_rule_id=$3,
       approved_rule_version=$4,reviewed_at=now() WHERE id=$1`,
      [input.candidateId, input.reviewerNote ?? null, rule.ruleId, rule.version],
    );
    await client.query('UPDATE source_documents SET review_state=\'approved\',updated_at=now() WHERE id=$1', [candidate.rows[0].source_document_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const recalculated = await recalculateRuleForAllCompanies(rule.ruleId, rule.version);
  return { rule, recalculated: recalculated.length };
}

export async function listIngestionRuns(limit = 30) {
  const result = await getPool().query('SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT $1', [limit]);
  return result.rows;
}
