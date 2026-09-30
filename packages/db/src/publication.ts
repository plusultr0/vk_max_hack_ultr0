import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LegalRuleSchema } from '@reg/domain';
import { validateRegulatoryExtraction } from '@reg/llm';
import { calendarDate, compileReview, parseReviewDocument, reviewHash, automaticReviewIssues } from '@reg/review';
import { getPool } from './client.js';
import { seedHash } from './canonical.js';
import { ReviewError } from './review.js';
import { ensureBuiltinFacts, installFactDefinitions, registerRuleDependencies } from './facts.js';

export const PublishReviewSchema = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewerNote: z.string().trim().min(1).max(10000).optional(),
  relation: z.object({
    type: z.enum(['amends', 'supersedes', 'extends', 'cancels']),
    evidenceRef: z.string().trim().min(1).max(10000).nullable().optional(),
    effectiveFrom: calendarDate.nullable().optional(),
  }).strict().optional(),
}).strict();

export async function publishReadyReviewRevision(input: z.infer<typeof PublishReviewSchema> & {
  candidateId: string; revision: number; actorId: string;
}) {
  const { candidateId, revision, actorId, ...body } = input;
  z.string().min(1).max(200).parse(candidateId);
  z.number().int().positive().max(2147483647).parse(revision);
  const actor = z.string().trim().min(1).max(200).parse(actorId);
  const request = PublishReviewSchema.parse(body);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Candidate first: shared lock order with review edits, reject and legacy publish.
    const candidate = (await client.query('SELECT * FROM legal_rule_candidates WHERE id=$1 FOR UPDATE', [candidateId])).rows[0];
    if (!candidate) throw new ReviewError('CANDIDATE_NOT_FOUND', 404);
    if (candidate.review_state !== 'pending') throw new ReviewError('CANDIDATE_ALREADY_REVIEWED', 409);
    if (!candidate.source_snapshot_id) throw new ReviewError('REVIEW_SOURCE_SNAPSHOT_REQUIRED', 409);
    const head = (await client.query('SELECT * FROM review_drafts WHERE candidate_id=$1 FOR UPDATE', [candidateId])).rows[0];
    if (!head) throw new ReviewError('REVIEW_NOT_FOUND', 404);
    if (head.current_revision !== revision) throw new ReviewError('REVIEW_REVISION_CONFLICT', 409);
    const saved = (await client.query('SELECT * FROM review_revisions WHERE candidate_id=$1 AND revision=$2 FOR UPDATE',
      [candidateId, revision])).rows[0];
    if (!saved) throw new ReviewError('REVIEW_NOT_FOUND', 404);
    if (saved.state !== 'ready') throw new ReviewError('REVIEW_NOT_READY', 422);
    const document = parseReviewDocument(saved.document);
    if (request.contentHash !== saved.content_hash || reviewHash(document) !== saved.content_hash) {
      throw new ReviewError('REVIEW_CONTENT_HASH_MISMATCH', 409);
    }
    const snapshot = (await client.query('SELECT * FROM source_snapshots WHERE id=$1 FOR SHARE', [candidate.source_snapshot_id])).rows[0];
    if (!snapshot || head.source_snapshot_id !== snapshot.id || snapshot.source_document_id !== candidate.source_document_id) {
      throw new ReviewError('REVIEW_SOURCE_SNAPSHOT_INVALID', 422);
    }
    let extraction: ReturnType<typeof validateRegulatoryExtraction>;
    try {
      extraction = validateRegulatoryExtraction({ ...candidate.draft, sourceSnapshot: snapshot.snapshot });
      if (snapshot.text_hash !== extraction.sourceSnapshot.textHash) throw new Error('SNAPSHOT_HASH_MISMATCH');
    } catch { throw new ReviewError('REVIEW_SOURCE_SNAPSHOT_INVALID', 422); }

    if(document.approvalMode==='machine_validated') {
      const gates=automaticReviewIssues(extraction,document);
      if(gates.length)throw new ReviewError('AUTOMATIC_GATE_FAILED',422,gates);
    }
    await ensureBuiltinFacts(client);
    if(document.factDefinitions)await installFactDefinitions(client,document.factDefinitions,document.approvalMode==='machine_validated'?'machine':'human');

    // Verify the persisted compilation as well as compiling again. Reproduce its
    // check date so a midnight boundary cannot masquerade as data corruption.
    const stored = saved.compilation;
    const checkedAt = calendarDate.safeParse(stored?.rules?.[0]?.rule?.checkedAt);
    if (!checkedAt.success) throw new ReviewError('REVIEW_COMPILATION_INVALID', 422);
    const verified = compileReview(document, extraction, checkedAt.data);
    if (!verified.ready || verified.issues.length || !verified.rules.length) {
      throw new ReviewError('REVIEW_NOT_READY', 422, verified.issues);
    }
    if (reviewHash(stored) !== reviewHash(verified)) throw new ReviewError('REVIEW_COMPILATION_MISMATCH', 422);
    const compilation = compileReview(document, extraction, new Date().toISOString().slice(0, 10));
    if (!compilation.ready || compilation.issues.length || !compilation.rules.length) throw new ReviewError('REVIEW_NOT_READY', 422);
    const rules = compilation.rules.map((item) => {
      const { seedHash: _hash, ...raw } = item.rule;
      const published = { ...raw, reviewStatus: 'reviewed', tags: raw.tags.filter((t) => t !== 'review-preview').concat('review-published',document.approvalMode==='machine_validated'?'machine-validated':'human-reviewed') };
      return LegalRuleSchema.parse({ ...published, seedHash: seedHash(published) });
    });
    // The staging row can change after extraction. Do not borrow its unreviewed
    // number/issuer/date or approve a newer staged document as a side effect.
    const metadata=extraction.sourceSnapshot.sourceMetadata;
    await client.query(`INSERT INTO legal_acts(act_id,title,number,issuer,publication_date,official_url,retrieved_at,verification_status,raw_text_hash,data)
      VALUES($1,$2,$6,$7,$8,$3,now(),'reviewed',$4,$5) ON CONFLICT(act_id) DO NOTHING`,
    [document.actId, extraction.sourceSnapshot.sourceTitle,
      extraction.sourceSnapshot.officialUrl, snapshot.text_hash,
      JSON.stringify({ sourceDocumentId: candidate.source_document_id, sourceSnapshotId: snapshot.id, approvalMode: document.approvalMode ?? 'human' }),
      metadata?.number??null,metadata?.issuer??'Не указан',metadata?.publicationDate??null]);
    const act = (await client.query('SELECT * FROM legal_acts WHERE act_id=$1 FOR UPDATE', [document.actId])).rows[0];
    if (act.raw_text_hash !== snapshot.text_hash || act.official_url !== extraction.sourceSnapshot.officialUrl) {
      throw new ReviewError('LEGAL_ACT_SOURCE_CONFLICT', 409);
    }
    const publicationId = randomUUID();
    await client.query(`INSERT INTO review_publications(id,candidate_id,revision,source_snapshot_id,content_hash,actor_id,reviewer_note,approval_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [publicationId, candidateId, revision, snapshot.id, saved.content_hash, actor, request.reviewerNote ?? null, document.approvalMode??'human']);
    for (const rule of [...rules].sort((a, b) => a.ruleId < b.ruleId ? -1 : 1)) {
      const inserted = await client.query(`INSERT INTO legal_rules(rule_id,version,act_id,seed_hash,legal_status,review_status,valid_from,valid_to,checked_at,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(rule_id,version) DO NOTHING RETURNING rule_id`,
      [rule.ruleId, rule.version, rule.actId, rule.seedHash, rule.legalStatus, rule.reviewStatus,
        rule.validFrom, rule.validTo, rule.checkedAt, JSON.stringify(rule)]);
      await registerRuleDependencies(client,rule);
      // Existing versions must never be silently relabelled as reviewed.
      if (!inserted.rowCount) throw new ReviewError('IMMUTABLE_RULE_VERSION_CONFLICT', 409);
      const compiled = compilation.rules.find((item) => item.rule.ruleId === rule.ruleId)!;
      await client.query(`INSERT INTO review_publication_rules(publication_id,phase_id,rule_id,rule_version,compilation)
        VALUES($1,$2,$3,$4,$5)`, [publicationId, compiled.phaseId, rule.ruleId, rule.version, JSON.stringify({ ...compiled, rule })]);
      if (request.relation) {
        const previous = await client.query('SELECT 1 FROM legal_rules WHERE rule_id=$1 AND version=$2 FOR SHARE', [rule.ruleId, rule.version - 1]);
        if (!previous.rowCount) throw new ReviewError('RELATION_PREVIOUS_VERSION_REQUIRED', 422);
        await client.query(`INSERT INTO regulatory_relations(from_rule_id,from_version,to_rule_id,to_version,relation_type,effective_from,evidence_ref,is_synthetic)
          VALUES($1,$2,$1,$3,$4,$5,$6,false)`,
        [rule.ruleId, rule.version - 1, rule.version, request.relation.type, request.relation.effectiveFrom ?? rule.checkedAt, request.relation.evidenceRef ?? null]);
      }
    }
    // Legacy singular columns are only meaningful for a one-rule publication.
    await client.query(`UPDATE legal_rule_candidates SET review_state='approved',reviewer_note=$2,
      approved_rule_id=$3,approved_rule_version=$4,reviewed_at=now() WHERE id=$1`,
    [candidateId, request.reviewerNote ?? null, rules.length === 1 ? rules[0]!.ruleId : null, rules.length === 1 ? rules[0]!.version : null]);
    const eventId = randomUUID();
    const payload = { schemaVersion: 1, publicationId, candidateId, revision, contentHash: saved.content_hash,
      sourceSnapshotId: snapshot.id, sourceTextHash: snapshot.text_hash, compilerVersion: compilation.compilerVersion,
      actorId: actor, approvalMode: document.approvalMode ?? 'human', reviewerNote: request.reviewerNote ?? null, relation: request.relation ?? null,
      rules: rules.map((rule) => ({ ruleId: rule.ruleId, version: rule.version, seedHash: rule.seedHash })) };
    await client.query(`INSERT INTO audit_log(actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES($4,$1,'review.published','legal_rule_candidate',$2,$3)`, [actor, candidateId, JSON.stringify(payload), document.approvalMode==='machine_validated'?'system':'admin']);
    await client.query(`INSERT INTO outbox_events(id,event_type,aggregate_id,payload,idempotency_key)
      VALUES($1,'review.published',$2,$3,$4)`, [eventId, publicationId, JSON.stringify(payload), `review.published:${candidateId}:${revision}`]);
    if(document.approvalMode==='machine_validated')await client.query(`INSERT INTO candidate_automation(candidate_id,state,gate_version)
      VALUES($1,'published','automatic-v1') ON CONFLICT(candidate_id) DO UPDATE SET state='published',issues='[]'::jsonb,updated_at=now()`,[candidateId]);
    await client.query('COMMIT');
    return { ...payload, eventId, published: true, outboxStatus: 'pending' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
