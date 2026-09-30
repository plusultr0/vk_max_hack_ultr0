import { z } from 'zod';
import { validateRegulatoryExtraction } from '@reg/llm';
import { assertReviewIdentity, compileReview, createReviewDocument, parseReviewDocument, previewReview, reviewHash,
  type ReviewCompilation } from '@reg/review';
import { getPool } from './client.js';
import { getRuleCandidate } from './ingestion.js';

export class ReviewError extends Error {
  constructor(public code: string, public statusCode: number, public details?: unknown) { super(code); }
}
export const SaveReviewSchema = z.object({
  baseRevision: z.number().int().positive(),
  state: z.enum(['draft', 'ready']),
  reason: z.string().trim().min(1).max(10000),
  document: z.unknown().refine((v) => v !== undefined, 'document is required'),
}).strict();

type StoredReview = {
  candidateId: string; sourceSnapshotId: string; revision: number; state: 'draft' | 'ready';
  document: ReturnType<typeof parseReviewDocument>; contentHash: string; compilation: ReviewCompilation;
  actorId: string; reason: string; createdAt: string;
};
function hydrate(row: any): StoredReview {
  const document = parseReviewDocument(row.document);
  if (reviewHash(document) !== row.content_hash) throw new Error('REVIEW_CONTENT_HASH_MISMATCH');
  return { candidateId: row.candidate_id, sourceSnapshotId: row.source_snapshot_id, revision: row.revision, state: row.state,
    document, contentHash: row.content_hash, compilation: row.compilation, actorId: row.actor_id, reason: row.reason,
    createdAt: new Date(row.created_at).toISOString() };
}
export async function getCandidateReview(candidateId: string, revision?: number) {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new ReviewError('INVALID_REVISION', 400);
  const result = await getPool().query(
    `SELECT r.*, d.source_snapshot_id FROM review_drafts d JOIN review_revisions r
     ON r.candidate_id=d.candidate_id AND r.revision=COALESCE($2::integer,d.current_revision)
     WHERE d.candidate_id=$1`, [candidateId, revision ?? null]);
  return result.rowCount ? hydrate(result.rows[0]) : null;
}
export async function listReviewRevisions(candidateId: string) {
  const result = await getPool().query(`SELECT revision,state,content_hash,actor_id,reason,created_at
    FROM review_revisions WHERE candidate_id=$1 ORDER BY revision DESC`, [candidateId]);
  return result.rows;
}

async function writeRevision(input: { candidateId: string; actorId: string; save?: z.infer<typeof SaveReviewSchema> }) {
  const actor = z.string().trim().min(1).max(200).parse(input.actorId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Same lock order as legacy publication; rejected/published candidates cannot acquire new revisions.
    const candidate = await client.query(`SELECT c.*,s.snapshot FROM legal_rule_candidates c
      LEFT JOIN source_snapshots s ON s.id=c.source_snapshot_id WHERE c.id=$1 FOR UPDATE OF c`, [input.candidateId]);
    const row = candidate.rows[0];
    if (!row) throw new ReviewError('CANDIDATE_NOT_FOUND', 404);
    if (row.review_state !== 'pending') throw new ReviewError('CANDIDATE_ALREADY_REVIEWED', 409);
    if (!row.snapshot) throw new ReviewError('LEGACY_CANDIDATE_REEXTRACTION_REQUIRED', 409);
    const extraction = validateRegulatoryExtraction({ ...row.draft, sourceSnapshot: row.snapshot });
    const head = await client.query(`SELECT d.current_revision,r.document FROM review_drafts d JOIN review_revisions r
      ON r.candidate_id=d.candidate_id AND r.revision=d.current_revision WHERE d.candidate_id=$1`, [input.candidateId]);
    if (!input.save && head.rowCount) throw new ReviewError('REVIEW_ALREADY_EXISTS', 409);
    if (input.save && !head.rowCount) throw new ReviewError('REVIEW_NOT_FOUND', 404);
    if (input.save && input.save.baseRevision !== head.rows[0].current_revision) throw new ReviewError('REVIEW_REVISION_CONFLICT', 409, { currentRevision: head.rows[0].current_revision });
    const document = input.save ? parseReviewDocument(input.save.document) : createReviewDocument(extraction);
    // Machine provenance may only be asserted by the internal automation actor.
    if (document.approvalMode==='machine_validated' && actor!=='system:autonomous-v1') document.approvalMode='human';
    if (input.save) {
      try { assertReviewIdentity(parseReviewDocument(head.rows[0].document), document); }
      catch (error) { throw new ReviewError(error instanceof Error ? error.message : 'REVIEW_IDENTITY_CHANGED', 422); }
    }
    const compilation = compileReview(document, extraction, new Date().toISOString().slice(0, 10));
    // Broken provenance is invalid even in a draft. Semantic issues may be saved for later editing.
    const structuralIssues = compilation.issues.filter((i) => ['DUPLICATE_ID','INVALID_ORIGIN','SOURCE_ITEM_COVERAGE','UNKNOWN_RESOLUTION'].includes(i.code));
    if (structuralIssues.length) throw new ReviewError('REVIEW_PROVENANCE_INVALID', 422, structuralIssues);
    const state = input.save?.state ?? 'draft';
    if (state === 'ready' && !compilation.ready) throw new ReviewError('REVIEW_NOT_READY', 422, compilation.issues);
    const revision = input.save ? input.save.baseRevision + 1 : 1;
    const reason = input.save?.reason ?? 'Создан отдельный черновик проверки из неизменяемого извлечения.';
    if (!input.save) await client.query('INSERT INTO review_drafts(candidate_id,source_snapshot_id,current_revision) VALUES($1,$2,$3)', [input.candidateId, row.source_snapshot_id, revision]);
    await client.query(`INSERT INTO review_revisions(candidate_id,revision,state,document,content_hash,compilation,actor_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.candidateId, revision, state, JSON.stringify(document), compilation.contentHash, JSON.stringify(compilation), actor, reason]);
    if (input.save) await client.query('UPDATE review_drafts SET current_revision=$2 WHERE candidate_id=$1', [input.candidateId, revision]);
    await client.query(`INSERT INTO audit_log(actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES($4,$1,'review.revision_created','legal_rule_candidate',$2,$3)`, [actor, input.candidateId, JSON.stringify({ revision, state, reason, contentHash: compilation.contentHash, approvalMode: document.approvalMode ?? 'human' }), actor === 'system:autonomous-v1' ? 'system' : 'admin']);
    const result = await client.query('SELECT r.*,$3::text AS source_snapshot_id FROM review_revisions r WHERE candidate_id=$1 AND revision=$2', [input.candidateId, revision, row.source_snapshot_id]);
    await client.query('COMMIT');
    return hydrate(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function createCandidateReview(candidateId: string, actorId: string) { return writeRevision({ candidateId, actorId }); }
export async function saveCandidateReview(candidateId: string, value: unknown, actorId: string) {
  return writeRevision({ candidateId, actorId, save: SaveReviewSchema.parse(value) });
}
export async function previewCandidateReview(candidateId: string, input: {
  revision: number; contentHash: string; asOf: string; profile: Parameters<typeof previewReview>[1]['profile']; tradeObjectId?: string; factValues?: Record<string, unknown>;
}) {
  const saved = await getCandidateReview(candidateId);
  if (!saved) throw new ReviewError('REVIEW_NOT_FOUND', 404);
  if (saved.revision !== input.revision || saved.contentHash !== input.contentHash) throw new ReviewError('REVIEW_REVISION_CONFLICT', 409);
  const candidate = await getRuleCandidate(candidateId);
  if (!candidate || candidate.review_state !== 'pending') throw new ReviewError('CANDIDATE_ALREADY_REVIEWED', 409);
  const extraction = validateRegulatoryExtraction({ ...candidate.draft, sourceSnapshot: candidate.source_snapshot });
  const compilation = compileReview(saved.document, extraction, input.asOf);
  if (!compilation.ready) throw new ReviewError('REVIEW_NOT_READY', 422, compilation.issues);
  return { revision: saved.revision, contentHash: saved.contentHash, asOf: input.asOf,
    hypothetical: true, published: false, items: previewReview(compilation, input) };
}
