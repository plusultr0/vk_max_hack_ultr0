import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { makeManualOfficialDocument, scorePilotRelevance } from '@reg/ingestion';
import { completeTestReview, testExtraction } from '../../review/test/fixture.js';
import { closePool, getPool } from './client.js';
import { getRuleCandidate, publishReviewedRuleCandidate, rejectRuleCandidate, saveRuleCandidate, stageSourceDocuments } from './ingestion.js';
import { createCandidateReview, getCandidateReview, listReviewRevisions, previewCandidateReview, saveCandidateReview } from './review.js';

if (process.env.ALLOW_INTEGRATION_TESTS !== 'true') throw new Error('Set ALLOW_INTEGRATION_TESTS=true for isolated schema tests');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const schema = `s95_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^s95_test_[a-f0-9]{32}$/);
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
  const document = makeManualOfficialDocument({ title: extraction.title, officialUrl: extraction.sourceSnapshot.officialUrl, sourceText: extraction.sourceSnapshot.sourceText });
  const staged = await stageSourceDocuments({ documents: [document], relevance: scorePilotRelevance });
  const sourceDocumentId = staged.documentIds[0]!;
  const makeCandidate = () => saveRuleCandidate({ sourceDocumentId, provider: 'synthetic-test', draft: extraction });
  const candidateId = await makeCandidate();
  const original = await getRuleCandidate(candidateId);

  const creation = await Promise.allSettled([createCandidateReview(candidateId, 'test-reviewer'), createCandidateReview(candidateId, 'test-reviewer')]);
  assert.equal(creation.filter((r) => r.status === 'fulfilled').length, 1);
  const rejectedCreate = creation.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejectedCreate.reason.code, 'REVIEW_ALREADY_EXISTS');
  const first = (await getCandidateReview(candidateId))!;
  assert.equal(first.revision, 1);
  assert.equal(first.state, 'draft');
  assert.equal(first.compilation.ready, false);
  const changes = { baseRevision: 1, state: 'draft', reason: 'Исправлено название.', document: { ...first.document, title: 'Название после правки' } };
  const saves = await Promise.allSettled([saveCandidateReview(candidateId, changes, 'reviewer-a'), saveCandidateReview(candidateId, changes, 'reviewer-b')]);
  assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((saves.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'REVIEW_REVISION_CONFLICT');
  const second = (await getCandidateReview(candidateId))!;
  assert.equal(second.revision, 2);
  assert.equal((await getCandidateReview(candidateId, 1))!.document.title, first.document.title);
  await assert.rejects(saveCandidateReview(candidateId, { ...changes, baseRevision: 2, state: 'ready' }, 'test-reviewer'), /REVIEW_NOT_READY/);
  assert.equal((await getCandidateReview(candidateId))!.revision, 2);
  const removed = structuredClone(second.document); removed.phases.pop();
  await assert.rejects(saveCandidateReview(candidateId, { ...changes, baseRevision: 2, document: removed }, 'test-reviewer'), /REVIEW_IDENTITY_CHANGED/);

  // Audit failure must roll back both the new revision and head pointer.
  await pool.query(`CREATE FUNCTION reject_test_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_audit()`);
  await assert.rejects(saveCandidateReview(candidateId, { ...changes, baseRevision: 2 }, 'test-reviewer'), /TEST_AUDIT_FAILURE/);
  assert.equal((await getCandidateReview(candidateId))!.revision, 2);
  assert.equal((await listReviewRevisions(candidateId)).length, 2);
  await pool.query('DROP TRIGGER reject_test_audit ON audit_log');

  const ready = await saveCandidateReview(candidateId, { baseRevision: 2, state: 'ready', reason: 'Проверен синтетический пример.', document: completeTestReview(second.document) }, 'test-reviewer');
  assert.equal(ready.revision, 3);
  assert.equal(ready.compilation.rules.length, 3);
  assert.deepEqual((await getRuleCandidate(candidateId)).draft, original.draft);
  assert.equal((await getRuleCandidate(candidateId)).review_state, 'pending');
  const previewInput = { revision: 3, contentHash: ready.contentHash, asOf: '2026-09-17', profile: { profileVersion: 1, revenuePreviousYear: 121, hasEpaymentAcceptanceAgreementAsOf2026_01_01: true, isExcludedProduct: false } };
  const preview = await previewCandidateReview(candidateId, previewInput);
  assert.equal(preview.items[0]!.evaluation!.verdict, 'applies');
  assert.deepEqual(preview.items.map((p) => p.timeState), ['active', 'upcoming', 'upcoming']);
  await assert.rejects(previewCandidateReview(candidateId, { ...previewInput, revision: 2 }), /REVIEW_REVISION_CONFLICT/);
  await assert.rejects(previewCandidateReview(candidateId, { ...previewInput, contentHash: '0'.repeat(64) }), /REVIEW_REVISION_CONFLICT/);
  await assert.rejects(publishReviewedRuleCandidate({ candidateId, approvedRule: ready.compilation.rules[0]!.rule }), /REVIEW_REVISION_REQUIRES_BUNDLE_PUBLICATION/);
  await assert.rejects(pool.query("UPDATE review_revisions SET document='{}' WHERE candidate_id=$1", [candidateId]), /REVIEW_REVISION_IMMUTABLE/);
  await assert.rejects(pool.query('DELETE FROM review_revisions WHERE candidate_id=$1', [candidateId]), /REVIEW_REVISION_IMMUTABLE/);
  await assert.rejects(pool.query('UPDATE review_drafts SET current_revision=1 WHERE candidate_id=$1', [candidateId]), /REVIEW_HEAD_INVALID_CHANGE/);
  const reopened = await saveCandidateReview(candidateId, { baseRevision: 3, state: 'draft', reason: 'Возврат к проверке.', document: ready.document }, 'test-reviewer');
  assert.equal(reopened.state, 'draft');
  assert.equal((await getCandidateReview(candidateId, 3))!.state, 'ready');
  await rejectRuleCandidate(candidateId, 'Только тестовые данные.');
  await assert.rejects(saveCandidateReview(candidateId, { ...changes, baseRevision: 4 }, 'test-reviewer'), /CANDIDATE_ALREADY_REVIEWED/);
  await assert.rejects(rejectRuleCandidate(candidateId), /CANDIDATE_ALREADY_REVIEWED/);
  await assert.rejects(pool.query("UPDATE legal_rule_candidates SET review_state='pending' WHERE id=$1", [candidateId]), /CANDIDATE_TERMINAL_STATE/);
  const legacyId = randomUUID();
  await pool.query("INSERT INTO legal_rule_candidates(id,source_document_id,provider,prompt_version,draft) VALUES($1,$2,'mock','legacy','{}')", [legacyId, sourceDocumentId]);
  await assert.rejects(createCandidateReview(legacyId, 'test-reviewer'), /LEGACY_CANDIDATE_REEXTRACTION_REQUIRED/);
  assert.equal(await getCandidateReview(legacyId), null);

  // Exercise actual HTTP routes against only this temporary schema.
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const token = randomUUID();
  api = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../apps/api/src/index.ts', import.meta.url))], {
    env: { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(port), ADMIN_TOKEN: token, ALLOW_DEV_AUTH: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let apiError = ''; api.stderr?.on('data', (chunk) => { apiError += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`TEST_API_EXITED: ${apiError}`);
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { /* startup */ }
    if (healthy) break;
    await delay(100);
  }
  assert.ok(healthy, 'Test API must start');
  const apiCandidate = await makeCandidate();
  const uiOrigin = 'http://localhost:5173';
  assert.equal((await fetch(`${base}/admin/session`)).status, 401);
  assert.equal((await fetch(`${base}/admin/session`, {method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({adminToken:token})})).status,403);
  assert.equal((await fetch(`${base}/admin/session`, {method:'POST',headers:{'Content-Type':'application/json',Origin:uiOrigin},body:JSON.stringify({adminToken:'wrong'})})).status,401);
  const sessionResponse = await fetch(`${base}/admin/session`, {method:'POST',headers:{'Content-Type':'application/json',Origin:uiOrigin},body:JSON.stringify({adminToken:token})});
  assert.equal(sessionResponse.status,200);
  const setCookie = sessionResponse.headers.get('set-cookie')!;
  assert.match(setCookie,/HttpOnly/); assert.match(setCookie,/SameSite=Strict/); assert.match(setCookie,/Path=\/admin/);
  const cookie = setCookie.split(';')[0]!;
  const session = await sessionResponse.json() as {csrf:string};
  const cookieHeaders = {Cookie:cookie,Origin:uiOrigin,'Content-Type':'application/json','X-Review-CSRF':session.csrf};
  assert.equal((await fetch(`${base}/admin/session`,{headers:{Cookie:cookie}})).status,200);
  const catalogResponse = await fetch(`${base}/admin/review-fields`,{headers:{Cookie:cookie}});
  assert.equal(catalogResponse.status,200); assert.ok(((await catalogResponse.json()) as {items:unknown[]}).items.length>30);
  const cookieCandidate = await makeCandidate();
  const cookieUrl = `${base}/admin/candidates/${cookieCandidate}/review`;
  assert.equal((await fetch(cookieUrl,{method:'POST',headers:{Cookie:cookie,Origin:uiOrigin,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(cookieUrl,{method:'POST',headers:{...cookieHeaders,Origin:'https://untrusted.example'},body:'{}'})).status,403);
  assert.equal((await fetch(cookieUrl,{method:'POST',headers:cookieHeaders,body:'{}'})).status,201);
  const logout = await fetch(`${base}/admin/session`,{method:'DELETE',headers:cookieHeaders});
  assert.equal(logout.status,200); assert.match(logout.headers.get('set-cookie')!,/Max-Age=0/);
  const url = `${base}/admin/candidates/${apiCandidate}/review`;
  const call = (method: string, suffix = '', body?: unknown, authorized = true) => fetch(url + suffix, { method,
    headers: { 'Content-Type': 'application/json', ...(authorized ? { 'X-Admin-Token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const [method, suffix, body] of [['POST', '', {}], ['GET', '', undefined], ['GET', '/history', undefined], ['PUT', '', {}], ['POST', '/preview', {}]] as const) {
    assert.equal((await call(method, suffix, body, false)).status, 403);
  }
  assert.equal((await call('POST', '', { actorId: 'forged' })).status, 400);
  const createResponse = await call('POST', '', {}); assert.equal(createResponse.status, 201);
  const apiFirst = await createResponse.json() as typeof first;
  assert.equal(apiFirst.actorId, 'admin-token');
  assert.equal((await call('POST', '', {})).status, 409);
  assert.equal((await call('GET', '?revision=0')).status, 400);
  assert.equal((await call('PUT', '', { baseRevision: 1, state: 'ready', reason: 'Неполный тест.', document: apiFirst.document })).status, 422);
  const readyResponse = await call('PUT', '', { baseRevision: 1, state: 'ready', reason: 'Синтетическая проверка.', document: completeTestReview(apiFirst.document) });
  assert.equal(readyResponse.status, 200); const apiReady = await readyResponse.json() as typeof ready;
  assert.equal((await call('PUT', '', { baseRevision: 1, state: 'draft', reason: 'Устаревшая правка.', document: apiFirst.document })).status, 409);
  assert.equal((await call('POST', '/preview', { ...previewInput, revision: 2, contentHash: apiReady.contentHash })).status, 200);
  assert.equal((await call('POST', '/preview', { ...previewInput, revision: 2, contentHash: apiReady.contentHash, asOf: '2026-02-31' })).status, 400);
  assert.equal((await call('POST', '/preview', previewInput)).status, 409);
  const history = await (await call('GET', '/history')).json() as { items: unknown[] }; assert.equal(history.items.length, 2);
  assert.equal((await (await call('GET', '?revision=1')).json() as typeof first).state, 'draft');
  const counters = await pool.query('SELECT (SELECT count(*) FROM legal_rules) AS rules,(SELECT count(*) FROM impact_assessments) AS impacts,(SELECT count(*) FROM notifications) AS notifications');
  assert.deepEqual(counters.rows[0], { rules: '0', impacts: '0', notifications: '0' });
  console.log(JSON.stringify({ status: 'ok', checks: ['migrations twice', 'concurrent create/save conflicts', 'immutable revisions and extraction', 'atomic audit rollback', 'ready validation', 'revision/hash preview binding', 'legacy publish blocked', 'terminal reject guard', 'legacy extraction blocked', 'HTTP auth/errors/history/preview', 'review cookie session/origin/CSRF/logout/catalog', 'no publication or notification side effects'] }));
} finally {
  if (api && api.exitCode === null) {
    const exited = new Promise<void>((resolve) => api!.once('exit', () => resolve()));
    api.kill(); await Promise.race([exited, delay(3000)]);
    if (api.exitCode === null) { api.kill('SIGKILL'); await exited; }
  }
  await closePool();
  // Only the randomly named, validated schema created by this invocation is removed.
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
