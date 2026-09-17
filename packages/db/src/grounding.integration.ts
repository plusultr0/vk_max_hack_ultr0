import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { extractRegulatoryDraft, MockLlmProvider, validateRegulatoryExtraction } from '@reg/llm';
import { makeManualOfficialDocument, scorePilotRelevance } from '@reg/ingestion';
import { closePool, getPool } from './client.js';
import { getRuleCandidate, saveRuleCandidate, stageSourceDocuments } from './ingestion.js';

// An explicit opt-in and a disposable schema prevent tests touching application tables.
if (process.env.ALLOW_INTEGRATION_TESTS !== 'true') throw new Error('Set ALLOW_INTEGRATION_TESTS=true to run tests in an isolated temporary schema');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const schema = `s94_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^s94_test_[a-f0-9]{32}$/);
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = new URL(process.env.DATABASE_URL);
  database.searchParams.set('options', `-c search_path=${schema},public`);
  process.env.DATABASE_URL = database.toString();
  const pool = getPool();
  const migrationDir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(migrationDir)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  for (let pass = 0; pass < 2; pass += 1) for (const file of files) await pool.query(await readFile(new URL(file, migrationDir), 'utf8'));

  const original = 'Исходный тестовый текст с сохранением пробелов. Обязательные нормы здесь не определены. Дата публикации 01.01.2026.';
  const document = makeManualOfficialDocument({ title: 'Тест источника', officialUrl: 'https://example.test/integration', sourceText: original });
  const staged = await stageSourceDocuments({ documents: [document], relevance: scorePilotRelevance });
  const sourceDocumentId = staged.documentIds[0]!;
  const extraction = await extractRegulatoryDraft(new MockLlmProvider(), { sourceTitle: document.title, officialUrl: document.officialUrl, sourceText: original, sourceTextOrigin: 'request' });
  const candidateId = await saveRuleCandidate({ sourceDocumentId, provider: 'mock', model: 'mock', draft: extraction });
  const saved = await getRuleCandidate(candidateId);
  assert.deepEqual(saved.source_snapshot, extraction.sourceSnapshot);
  assert.equal(saved.prompt_version, extraction.schemaVersion);
  assert.ok(saved.evidence.length > 0);
  assert.deepEqual(validateRegulatoryExtraction({ ...saved.draft, sourceSnapshot: saved.source_snapshot }), extraction);

  const changed = makeManualOfficialDocument({ title: document.title, officialUrl: document.officialUrl, sourceText: original + ' Новая редакция страницы.' });
  await stageSourceDocuments({ documents: [changed], relevance: scorePilotRelevance });
  assert.equal((await getRuleCandidate(candidateId)).source_snapshot.sourceText, original);
  await assert.rejects(pool.query('UPDATE source_snapshots SET text_hash=$2 WHERE id=$1', [saved.source_snapshot_id, 'changed']), /SOURCE_SNAPSHOT_IMMUTABLE/);
  await assert.rejects(pool.query('DELETE FROM source_snapshots WHERE id=$1', [saved.source_snapshot_id]), /SOURCE_SNAPSHOT_IMMUTABLE/);
  await assert.rejects(pool.query("UPDATE legal_rule_candidates SET draft='{}'::jsonb WHERE id=$1", [candidateId]), /CANDIDATE_EXTRACTION_IMMUTABLE/);

  const before = await pool.query('SELECT (SELECT count(*) FROM source_snapshots) AS snapshots, count(*) AS candidates FROM legal_rule_candidates');
  const tampered = structuredClone(extraction); tampered.sourceSnapshot.textHash = '0'.repeat(64);
  await assert.rejects(saveRuleCandidate({ sourceDocumentId, provider: 'mock', draft: tampered }), /SOURCE_SNAPSHOT_HASH_MISMATCH/);
  await assert.rejects(saveRuleCandidate({ sourceDocumentId: 'does-not-exist', provider: 'mock', draft: extraction }), /SOURCE_DOCUMENT_NOT_FOUND/);
  await assert.rejects(saveRuleCandidate({ sourceDocumentId, provider: undefined as unknown as string, draft: extraction }), /not-null constraint/);
  const after = await pool.query('SELECT (SELECT count(*) FROM source_snapshots) AS snapshots, count(*) AS candidates FROM legal_rule_candidates');
  assert.deepEqual(after.rows, before.rows);

  // Original legacy rows remain readable, without invented provenance.
  const legacyId = randomUUID();
  await pool.query("INSERT INTO legal_rule_candidates(id,source_document_id,provider,prompt_version,draft) VALUES($1,$2,'mock','legacy','{}')", [legacyId, sourceDocumentId]);
  assert.equal((await getRuleCandidate(legacyId)).source_snapshot, null);
  await pool.query("UPDATE legal_rule_candidates SET review_state='rejected' WHERE id=$1", [candidateId]);
  assert.equal((await getRuleCandidate(candidateId)).review_state, 'rejected');
  console.log(JSON.stringify({ status: 'ok', checks: ['migrations twice', 'snapshot roundtrip', 'source update preserves snapshot', 'database immutability', 'rejected writes leave no rows', 'legacy readable', 'review metadata mutable'] }));
} finally {
  await closePool();
  // schema is generated above, validated, and belongs exclusively to this invocation.
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
