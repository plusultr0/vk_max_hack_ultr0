import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { makeManualOfficialDocument, scorePilotRelevance } from '@reg/ingestion';
import { reviewHash } from '@reg/review';
import { completeTestReview, testExtraction } from '../../review/test/fixture.js';
import { closePool, getPool } from './client.js';
import { saveRuleCandidate, stageSourceDocuments, publishReviewedRuleCandidate, rejectRuleCandidate } from './ingestion.js';
import { createCandidateReview, saveCandidateReview } from './review.js';
import { publishReadyReviewRevision } from './publication.js';
import { seedHash } from './canonical.js';
import { recalculateCompany, recalculateRuleForAllCompanies } from './impacts.js';

if (process.env.ALLOW_INTEGRATION_TESTS !== 'true') throw new Error('Set ALLOW_INTEGRATION_TESTS=true for isolated schema tests');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const schema = `s96_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^s96_test_[a-f0-9]{32}$/);
let api: ChildProcess | undefined;
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = new URL(process.env.DATABASE_URL);
  database.searchParams.set('options', `-c search_path=${schema},public`);
  process.env.DATABASE_URL = database.toString();
  const pool = getPool();
  const migrationDir = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (let pass = 0; pass < 2; pass++) for (const file of migrations) await pool.query(await readFile(new URL(file, migrationDir), 'utf8'));
  const extraction = testExtraction();
  const source = makeManualOfficialDocument({ title: extraction.title, officialUrl: extraction.sourceSnapshot.officialUrl, sourceText: extraction.sourceSnapshot.sourceText });
  const sourceDocumentId = (await stageSourceDocuments({ documents: [source], relevance: scorePilotRelevance })).documentIds[0]!;
  async function makeReview(state: 'draft' | 'ready' = 'ready') {
    const candidateId = await saveRuleCandidate({ sourceDocumentId, provider: 'synthetic-test', draft: extraction });
    const first = await createCandidateReview(candidateId, 'test-reviewer');
    if (state === 'draft') return first;
    return saveCandidateReview(candidateId, { baseRevision: 1, state, reason: 'Synthetic publication test only.', document: completeTestReview(first.document) }, 'test-reviewer');
  }
  type Saved = Awaited<ReturnType<typeof makeReview>>;
  const publish = (saved: Saved) => publishReadyReviewRevision({
    candidateId: saved.candidateId, revision: saved.revision, contentHash: saved.contentHash, actorId: 'test-publisher', reviewerNote: 'Synthetic fixture.',
  });
  async function counters() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM legal_acts) AS acts,
      (SELECT count(*) FROM legal_rules) AS rules,
      (SELECT count(*) FROM review_publications) AS publications,
      (SELECT count(*) FROM review_publication_rules) AS links,
      (SELECT count(*) FROM regulatory_relations) AS relations,
      (SELECT count(*) FROM audit_log WHERE event_type='review.published') AS audits,
      (SELECT count(*) FROM outbox_events) AS outbox,
      (SELECT count(*) FROM legal_rule_candidates WHERE review_state='approved') AS approved,
      (SELECT count(*) FROM source_documents WHERE review_state='approved') AS approved_sources`)).rows[0];
  }
  // Insert a deliberately corrupt next revision, without disabling immutable guards.
  // This simulates invalid persisted data, not anything exposed by the public API.
  async function corrupt(saved: Saved, change: { document?: unknown; contentHash?: string; compilation?: unknown }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO review_revisions(candidate_id,revision,state,document,content_hash,compilation,actor_id,reason)
        VALUES($1,$2,'ready',$3,$4,$5,'test-corruption','Synthetic invalid persisted data')`,
      [saved.candidateId, saved.revision + 1, JSON.stringify(change.document ?? saved.document), change.contentHash ?? saved.contentHash, JSON.stringify(change.compilation ?? saved.compilation)]);
      await client.query('UPDATE review_drafts SET current_revision=$2 WHERE candidate_id=$1', [saved.candidateId, saved.revision + 1]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { ...saved, revision: saved.revision + 1, contentHash: change.contentHash ?? saved.contentHash };
  }
  const empty = await counters();
  await assert.rejects(publish(await makeReview('draft')), /REVIEW_NOT_READY/);
  const ready = await makeReview();
  await assert.rejects(publish({ ...ready, revision: 99 }), /REVIEW_REVISION_CONFLICT/);
  await assert.rejects(publish({ ...ready, contentHash: '0'.repeat(64) }), /REVIEW_CONTENT_HASH_MISMATCH/);
  await assert.rejects(publish(await corrupt(await makeReview(), { contentHash: '0'.repeat(64) })), /REVIEW_CONTENT_HASH_MISMATCH/);
  const invalidCompilation = await makeReview();
  const tampered = structuredClone(invalidCompilation.compilation);
  tampered.rules[0]!.rule.title = 'Forged compilation rule';
  await assert.rejects(publish(await corrupt(invalidCompilation, { compilation: tampered })), /REVIEW_COMPILATION_MISMATCH/);
  const invalidDocument = await makeReview();
  const broken = structuredClone(invalidDocument.document);
  broken.phases[0]!.originIndex = 999;
  await assert.rejects(publish(await corrupt(invalidDocument, { document: broken, contentHash: reviewHash(broken) })), /REVIEW_NOT_READY/);
  const legacyId = randomUUID();
  await pool.query("INSERT INTO legal_rule_candidates(id,source_document_id,provider,prompt_version,draft) VALUES($1,$2,'mock','legacy','{}')", [legacyId, sourceDocumentId]);
  await assert.rejects(publish({ ...ready, candidateId: legacyId }), /REVIEW_SOURCE_SNAPSHOT_REQUIRED/);
  const badSnapshotId = randomUUID(), badCandidateId = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('INSERT INTO source_snapshots(id,source_document_id,text_hash,snapshot) VALUES($1,$2,$3,$4)',
      [badSnapshotId, sourceDocumentId, '0'.repeat(64), JSON.stringify(extraction.sourceSnapshot)]);
    await setup.query(`INSERT INTO legal_rule_candidates(id,source_document_id,source_snapshot_id,provider,prompt_version,draft)
      SELECT $1,source_document_id,$2,provider,prompt_version,draft FROM legal_rule_candidates WHERE id=$3`,
    [badCandidateId, badSnapshotId, ready.candidateId]);
    await setup.query('INSERT INTO review_drafts(candidate_id,source_snapshot_id,current_revision) VALUES($1,$2,1)', [badCandidateId, badSnapshotId]);
    await setup.query(`INSERT INTO review_revisions(candidate_id,revision,state,document,content_hash,compilation,actor_id,reason)
      VALUES($1,1,'ready',$2,$3,$4,'test-corruption','Invalid snapshot fixture')`,
    [badCandidateId, JSON.stringify(ready.document), ready.contentHash, JSON.stringify(ready.compilation)]);
    await setup.query('COMMIT');
  } catch (error) { await setup.query('ROLLBACK'); throw error; }
  finally { setup.release(); }
  await assert.rejects(publish({ ...ready, candidateId: badCandidateId, revision: 1 }), /REVIEW_SOURCE_SNAPSHOT_INVALID/);
  await assert.rejects(publish({ ...ready, candidateId: randomUUID() }), /CANDIDATE_NOT_FOUND/);
  const rejected = await makeReview();
  await rejectRuleCandidate(rejected.candidateId);
  await assert.rejects(publish(rejected), /CANDIDATE_ALREADY_REVIEWED/);
  const stale = await makeReview();
  await saveCandidateReview(stale.candidateId, { baseRevision: stale.revision, state: 'draft', reason: 'Reopened.', document: stale.document }, 'test-reviewer');
  await assert.rejects(publish(stale), /REVIEW_REVISION_CONFLICT/);
  await assert.rejects(publishReviewedRuleCandidate({ candidateId: ready.candidateId, approvedRule: ready.compilation.rules[0]!.rule }), /REVIEW_REVISION_REQUIRES_BUNDLE_PUBLICATION/);
  assert.deepEqual(await counters(), empty);

  // Inject failures late in the transaction, after rules, candidate and audit.
  for (const table of ['audit_log', 'outbox_events'] as const) {
    await pool.query(`CREATE OR REPLACE FUNCTION reject_test_publication() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'TEST_PUBLICATION_FAILURE'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_publication BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_test_publication()`);
    try {
      await assert.rejects(publish(ready), /TEST_PUBLICATION_FAILURE/);
      assert.deepEqual(await counters(), empty);
      const state = (await pool.query('SELECT review_state,reviewed_at,approved_rule_id,reviewer_note FROM legal_rule_candidates WHERE id=$1', [ready.candidateId])).rows[0];
      assert.deepEqual(state, { review_state: 'pending', reviewed_at: null, approved_rule_id: null, reviewer_note: null });
    } finally { await pool.query(`DROP TRIGGER reject_test_publication ON ${table}`); }
  }
  await assert.rejects(publishReadyReviewRevision({ candidateId: ready.candidateId, revision: ready.revision, contentHash: ready.contentHash,
    actorId: 'test-publisher', relation: { type: 'amends' } }), /RELATION_PREVIOUS_VERSION_REQUIRED/);
  assert.deepEqual(await counters(), empty);

  // Later ingestion must not contaminate the immutable reviewed snapshot.
  await pool.query(`UPDATE source_documents SET title='Newer unreviewed title',number='NEW',issuer='NEW',
    publication_date='not-a-calendar-date',raw_hash='new-source-content',review_state='unreviewed' WHERE id=$1`, [sourceDocumentId]);
  const race = await Promise.allSettled([publish(ready), publish(ready)]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'CANDIDATE_ALREADY_REVIEWED');
  const published = (race.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof publish>>>).value;
  assert.equal(published.rules.length, 3);
  assert.deepEqual(await counters(), { acts: '1', rules: '3', publications: '1', links: '3', relations: '0', audits: '1', outbox: '1', approved: '1', approved_sources: '0' });
  const publishedAct = (await pool.query('SELECT title,number,issuer,publication_date FROM legal_acts WHERE act_id=$1', [ready.document.actId])).rows[0];
  assert.deepEqual(publishedAct, { title: extraction.sourceSnapshot.sourceTitle, number: null, issuer: 'Не указан', publication_date: null });
  assert.equal((await pool.query('SELECT review_state FROM source_documents WHERE id=$1', [sourceDocumentId])).rows[0].review_state, 'unreviewed');
  const once = await counters();
  await assert.rejects(publish(ready), /CANDIDATE_ALREADY_REVIEWED/);
  assert.deepEqual(await counters(), once);
  const event = (await pool.query('SELECT * FROM outbox_events WHERE id=$1', [published.eventId])).rows[0];
  assert.equal(event.status, 'pending'); assert.equal(event.attempts, 0); assert.equal(event.processed_at, null);
  assert.ok(event.available_at); assert.equal(event.aggregate_id, published.publicationId);
  assert.equal(event.payload.sourceSnapshotId, ready.sourceSnapshotId);
  assert.equal(event.idempotency_key, `review.published:${ready.candidateId}:${ready.revision}`);
  await assert.rejects(pool.query(`INSERT INTO outbox_events(id,event_type,aggregate_id,payload,idempotency_key)
    VALUES($1,'review.published',$2,'{}',$3)`, [randomUUID(), published.publicationId, event.idempotency_key]), /unique constraint/);
  const links = await pool.query(`SELECT p.source_snapshot_id,r.compilation,l.data FROM review_publications p
    JOIN review_publication_rules r ON r.publication_id=p.id JOIN legal_rules l ON l.rule_id=r.rule_id AND l.version=r.rule_version
    WHERE p.id=$1`, [published.publicationId]);
  for (const row of links.rows) {
    assert.equal(row.source_snapshot_id, ready.sourceSnapshotId);
    assert.equal(row.data.reviewStatus, 'reviewed');
    assert.equal(row.data.seedHash, seedHash(row.data));
    assert.equal(row.data.tags.includes('review-preview'), false);
    assert.equal(row.compilation.temporalPolicy, 'start-inclusive-end-exclusive');
    assert.deepEqual(row.compilation.rule, row.data);
  }
  await assert.rejects(saveCandidateReview(ready.candidateId, { baseRevision: ready.revision, state: 'draft', reason: 'Too late.', document: ready.document }, 'test-reviewer'), /CANDIDATE_ALREADY_REVIEWED/);
  const collision = await makeReview();
  const collidingDocument = structuredClone(collision.document);
  // Put the collision last to exercise rollback of earlier inserts and links too.
  const existingId = ready.document.phases[0]!.ruleId;
  collidingDocument.phases.forEach((phase, i) => { phase.ruleId = i === 2 ? existingId : `aaa-new-${randomUUID()}`; });
  const colliding = await saveCandidateReview(collision.candidateId, { baseRevision: collision.revision,
    state: 'ready', reason: 'Version collision fixture.', document: collidingDocument }, 'test-reviewer');
  await assert.rejects(publish(colliding), /IMMUTABLE_RULE_VERSION_CONFLICT/);
  assert.deepEqual(await counters(), once);
  const actCollision = await makeReview();
  await pool.query(`INSERT INTO legal_acts(act_id,title,issuer,official_url,retrieved_at,verification_status,raw_text_hash,data)
    VALUES($1,'Synthetic act','Test','https://different.example/test',now(),'reviewed','different','{}')`, [actCollision.document.actId]);
  const beforeActCollision = await counters();
  await assert.rejects(publish(actCollision), /LEGAL_ACT_SOURCE_CONFLICT/);
  assert.deepEqual(await counters(), beforeActCollision);

  const nextVersion = await makeReview();
  const nextDocument = structuredClone(nextVersion.document);
  nextDocument.actId = ready.document.actId;
  nextDocument.phases.forEach((phase, i) => { phase.ruleId = ready.document.phases[i]!.ruleId; phase.version = 2; });
  const versionTwo = await saveCandidateReview(nextVersion.candidateId, { baseRevision: nextVersion.revision,
    state: 'ready', reason: 'Version 2 fixture.', document: nextDocument }, 'test-reviewer');
  const related = await publishReadyReviewRevision({ candidateId: versionTwo.candidateId, revision: versionTwo.revision,
    contentHash: versionTwo.contentHash, actorId: 'test-publisher', relation: { type: 'amends', effectiveFrom: '2026-09-18', evidenceRef: 'Synthetic test' } });
  assert.equal(related.rules.length, 3);
  assert.equal((await counters()).relations, '3');
  const companyId = randomUUID();
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'Synthetic company')", [companyId]);
  await pool.query('INSERT INTO company_profiles(id,company_id,profile_version,data) VALUES($1,$2,1,$3)',
    [randomUUID(), companyId, JSON.stringify({ profileVersion: 1, revenuePreviousYear: 121, hasEpaymentAcceptanceAgreementAsOf2026_01_01: true, isExcludedProduct: false })]);
  assert.deepEqual(await recalculateCompany(companyId), []);
  for (const version of [1, 2]) {
    await assert.rejects(recalculateRuleForAllCompanies(ready.document.phases[0]!.ruleId, version), /REVIEW_BUNDLE_RECALCULATION_NOT_IMPLEMENTED/);
  }

  // Real HTTP tests, confined to this disposable schema and generated credentials.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const token = randomUUID(), uiOrigin = 'http://localhost:5173';
  api = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../apps/api/src/index.ts', import.meta.url))], {
    env: { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(port), ADMIN_TOKEN: token,
      SESSION_SECRET: randomUUID(), NODE_ENV: 'test', REVIEW_UI_ORIGIN: uiOrigin, ALLOW_DEV_AUTH: 'false' },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break; } } catch { /* startup */ }
    if (api.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(healthy, 'API test server must start');
  const httpReady = await makeReview();
  const url = `${base}/admin/candidates/${httpReady.candidateId}/review/${httpReady.revision}/publish`;
  const body = { contentHash: httpReady.contentHash };
  const call = (headers: Record<string, string>, value: unknown = body, target = url) => fetch(target, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  const login = await fetch(`${base}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: uiOrigin }, body: JSON.stringify({ adminToken: token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const session = await login.json() as { csrf: string };
  const auth = { Cookie: cookie, Origin: uiOrigin, 'X-Review-CSRF': session.csrf };
  const beforeHttp = await counters();
  for (const headers of [
    {}, { 'X-Admin-Token': 'invalid' }, { Cookie: 'reg_review=invalid' },
    { Cookie: cookie, Origin: uiOrigin }, { Cookie: cookie, Origin: uiOrigin, 'X-Review-CSRF': 'invalid' },
    { Cookie: cookie, 'X-Review-CSRF': session.csrf }, { ...auth, Origin: 'https://untrusted.example' },
  ] as Array<Record<string, string>>) assert.equal((await call(headers)).status, 403);
  for (const value of [{}, { ...body, actorId: 'forged' }, { ...body, approvedRule: {} }, { ...body, relation: { type: 'amends', effectiveFrom: '2026-02-31' } }]) {
    assert.equal((await call(auth, value)).status, 400);
  }
  assert.equal((await call(auth, body, url.replace('/2/publish', '/0/publish'))).status, 400);
  assert.equal((await call(auth, body, url.replace('/2/publish', '/99/publish'))).status, 409);
  assert.equal((await call(auth, { contentHash: '0'.repeat(64) })).status, 409);
  const httpDraft = await makeReview('draft');
  assert.equal((await call(auth, { contentHash: httpDraft.contentHash },
    `${base}/admin/candidates/${httpDraft.candidateId}/review/1/publish`)).status, 422);
  const legacy = await call(auth, { rule: httpReady.compilation.rules[0]!.rule }, `${base}/admin/candidates/${httpReady.candidateId}/publish`);
  assert.equal(legacy.status, 400);
  assert.match(JSON.stringify(await legacy.json()), /REVIEW_REVISION_REQUIRES_BUNDLE_PUBLICATION/);
  assert.equal((await call({}, { rule: httpReady.compilation.rules[0]!.rule }, `${base}/admin/candidates/${httpReady.candidateId}/publish`)).status, 403);
  assert.deepEqual(await counters(), beforeHttp);
  const response = await call(auth);
  assert.equal(response.status, 201);
  const httpResult = await response.json() as typeof published;
  assert.equal(httpResult.actorId, 'admin-token'); assert.equal(httpResult.outboxStatus, 'pending');
  const afterHttp = await counters();
  assert.equal((await call(auth)).status, 409);
  assert.deepEqual(await counters(), afterHttp);
  const tokenReady = await makeReview();
  assert.equal((await call({ 'X-Admin-Token': token }, { contentHash: tokenReady.contentHash },
    `${base}/admin/candidates/${tokenReady.candidateId}/review/${tokenReady.revision}/publish`)).status, 201);
  const sideEffects = (await pool.query('SELECT (SELECT count(*) FROM impact_assessments) AS impacts,(SELECT count(*) FROM notifications) AS notifications')).rows[0];
  assert.deepEqual(sideEffects, { impacts: '0', notifications: '0' });
  console.log(JSON.stringify({ status: 'ok', suite: 'publication-outbox', checks: [
    'migrations twice', 'draft/stale/missing/hash/snapshot/provenance/compilation refusals',
    'atomic multi-rule publication', 'audit/outbox failure rollback', 'concurrent and sequential duplicate refusal',
    'snapshot/rule links', 'unique outbox key', 'terminal candidate', 'legacy guard',
    'HTTP auth/origin/CSRF/input validation/cookie and token publication', 'no delivery side effects',
  ] }));
} finally {
  if (api && api.exitCode === null) {
    const exited = new Promise<void>((resolve) => api!.once('exit', () => resolve()));
    api.kill(); await Promise.race([exited, delay(3000)]);
    if (api.exitCode === null) { api.kill('SIGKILL'); await exited; }
  }
  await closePool();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
