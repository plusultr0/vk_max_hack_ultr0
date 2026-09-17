import { getConfig } from '@reg/config';
import { closePool, getRuleCandidate, saveRuleCandidate, stageSourceDocuments } from '@reg/db';
import { fetchOfficialHtmlSource, scorePilotRelevance } from '@reg/ingestion';
import { createProvider, extractRegulatoryDraft, regulatoryReviewWarnings } from '@reg/llm';
import { writeFile } from 'node:fs/promises';

const config = getConfig();
const attempts: unknown[] = [];
try {
  const source = await fetchOfficialHtmlSource({
    source: 'cbr.ru.digital-ruble', url: config.CBR_DIGITAL_RUBLE_URL, issuer: 'Банк России', mode: 'page',
    title: 'Банк России — прием оплаты в цифровых рублях', timeoutMs: config.INGESTION_TIMEOUT_MS,
    retries: config.INGESTION_RETRIES, userAgent: config.INGESTION_USER_AGENT,
  });
  const document = source.documents[0]!;
  const staged = await stageSourceDocuments({ documents: [document], relevance: scorePilotRelevance });
  const provider = createProvider({ provider: config.LLM_PROVIDER, gigachatAuthKey: config.GIGACHAT_AUTH_KEY, gigachatScope: config.GIGACHAT_SCOPE,
    gigachatOauthUrl: config.GIGACHAT_OAUTH_URL, gigachatBaseUrl: config.GIGACHAT_BASE_URL, deepseekApiKey: config.DEEPSEEK_API_KEY,
    deepseekBaseUrl: config.DEEPSEEK_BASE_URL, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });
  const tracedProvider = { name: provider.name, model: provider.model, async generateJson(request: { system: string; user: string; jsonSchema?: Record<string, unknown> }) {
    const raw = await provider.generateJson(request); attempts.push(raw); return raw;
  } };
  const draft = await extractRegulatoryDraft(tracedProvider, { sourceTitle: document.title, officialUrl: document.officialUrl,
    sourceText: String(document.raw.text), sourceTextOrigin: 'official-url-fetch', sourceRetrievedAt: new Date().toISOString() });
  const candidateId = await saveRuleCandidate({ sourceDocumentId: staged.documentIds[0]!, provider: provider.name, model: provider.model, draft });
  const saved = await getRuleCandidate(candidateId);
  const phaseDates = draft.phases.map((phase) => phase.validFrom.date);
  const expectedDates = ['2026-09-01', '2027-09-01', '2028-09-01'];
  const expectedPhasesPresent = expectedDates.every((date) => phaseDates.includes(date));
  console.log(JSON.stringify({ status: expectedPhasesPresent ? 'ok' : 'review-required', candidateId, sourceDocumentId: staged.documentIds[0],
    provider: provider.name, model: provider.model, phaseDates, expectedPhasesPresent,
    sourceSnapshotId: saved.source_snapshot_id, sourceHash: draft.sourceSnapshot.textHash, segments: draft.sourceSnapshot.segments.length,
    evidenceCount: draft.evidence.length, reviewWarnings: regulatoryReviewWarnings(draft), phases: draft.phases, dateNotes: draft.dateNotes, uncertaintyNotes: draft.uncertaintyNotes }, null, 2));
  if (!expectedPhasesPresent) process.exitCode = 1;
} catch (error) {
  let message = error instanceof Error ? error.message : 'Source check failed';
  for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value) message = message.split(value).join('[REDACTED]');
  console.error(JSON.stringify({ status: 'failed', message }));
  if (process.env.SOURCE_CHECK_TRACE_FILE) await writeFile(process.env.SOURCE_CHECK_TRACE_FILE, JSON.stringify({ message, attempts }, null, 2));
  process.exitCode = 1;
} finally { await closePool(); }
