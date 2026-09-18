import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { registerReviewAuth } from './review-auth.js';
import { getConfig } from '@reg/config';
import {
  addImpactFeedback,
  answerImpactQuestion,
  confirmProfileDraft,
  ensureDevIdentity,
  finishIngestionRun,
  getDemoCatalog,
  getDemoProfile,
  getImpactById,
  getLegalRule,
  getPool,
  getProfileHistory,
  getProfileState,
  listAudit,
  listImpacts,
  listIngestionRuns,
  listNotifications,
  listRuleCandidates,
  listSourceDocuments,
  publishReviewedRuleCandidate,
  publishReadyReviewRevision,
  PublishReviewSchema,
  publicationDeliveryStatus,
  retryPublicationDelivery,
  enqueueExtraction,
  getExtractionJob,
  recalculateCompany,
  rejectRuleCandidate,
  saveProfileDraft,
  stageSourceDocuments,
  startIngestionRun,
  updateActionStatus,
  upsertMaxIdentity,
  getSourceDocument,
  getRuleCandidate,
  createCandidateReview,
  getCandidateReview,
  listReviewRevisions,
  saveCandidateReview,
  previewCandidateReview,
  ReviewError,
} from '@reg/db';
import { assessRule, CompanyProfileSchema, LegalRuleSchema } from '@reg/domain';
import { calendarDate, reviewFieldCatalog } from '@reg/review';
import {
  fetchOfficialHtmlSource,
  fetchPravoOpenData,
  makeManualOfficialDocument,
  scorePilotRelevance,
} from '@reg/ingestion';
import { createProvider, extractRegulatoryDraft } from '@reg/llm';
import { makeSession, validateWebAppData, verifySession, type SessionClaims } from '@reg/max';

const config = getConfig();
const app = Fastify({ logger: true, bodyLimit: 2_000_000 });
await app.register(cors, { origin: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'] });

type Authed = { claims: SessionClaims };

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function requireAuth(request: any, reply: any): Authed | null {
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    reply.code(401).send({ error: 'AUTH_REQUIRED' });
    return null;
  }
  try {
    return { claims: verifySession(token, config.SESSION_SECRET) };
  } catch (error) {
    reply.code(401).send({ error: 'INVALID_SESSION', message: error instanceof Error ? error.message : 'invalid session' });
    return null;
  }
}

const requireAdmin = registerReviewAuth(app, config);
app.get('/admin/review-fields', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { items: reviewFieldCatalog() };
});

function apiIngestionSources() {
  const common = {
    timeoutMs: config.INGESTION_TIMEOUT_MS,
    userAgent: config.INGESTION_USER_AGENT,
    retries: config.INGESTION_RETRIES,
  };
  return [
    {
      id: 'publication.pravo.gov.ru',
      url: config.PRAVO_OPEN_DATA_URL,
      enabled: config.INGESTION_ENABLE_PRAVO,
      tier: 'primary-publication',
      fetch: () => fetchPravoOpenData({ openDataUrl: config.PRAVO_OPEN_DATA_URL, ...common }),
    },
    {
      id: 'government.ru',
      url: config.GOVERNMENT_DOCS_URL,
      enabled: config.INGESTION_ENABLE_GOVERNMENT,
      tier: 'official-government',
      fetch: () => fetchOfficialHtmlSource({
        source: 'government.ru', url: config.GOVERNMENT_DOCS_URL, issuer: 'Правительство Российской Федерации',
        mode: 'links', includeHref: /\/docs\/(?:all\/)?\d+\/?(?:[?#].*)?$/i, maxDocuments: 250, ...common,
      }),
    },
    {
      id: 'nalog.gov.ru',
      url: config.FNS_CHANGES_URL,
      enabled: config.INGESTION_ENABLE_FNS,
      tier: 'official-regulator',
      fetch: () => fetchOfficialHtmlSource({
        source: 'nalog.gov.ru', url: config.FNS_CHANGES_URL, issuer: 'ФНС России', mode: 'page',
        title: 'ФНС России — изменения налогового законодательства 2026', ...common,
      }),
    },
    {
      id: 'cbr.ru',
      url: config.CBR_LEGAL_ACTS_URL,
      enabled: config.INGESTION_ENABLE_CBR,
      tier: 'official-regulator',
      fetch: () => fetchOfficialHtmlSource({
        source: 'cbr.ru', url: config.CBR_LEGAL_ACTS_URL, issuer: 'Банк России', mode: 'links',
        includeHref: /(?:\/na\/|\/PSystem\/|\/fintech\/|\/analytics\/|\/Crosscut\/LawActs\/)/i, maxDocuments: 250, ...common,
      }),
    },
    {
      id: 'cbr.ru.digital-ruble',
      url: config.CBR_DIGITAL_RUBLE_URL,
      enabled: config.INGESTION_ENABLE_CBR,
      tier: 'official-regulator',
      fetch: () => fetchOfficialHtmlSource({
        source: 'cbr.ru.digital-ruble', url: config.CBR_DIGITAL_RUBLE_URL, issuer: 'Банк России', mode: 'page',
        title: 'Банк России — прием оплаты в цифровых рублях', ...common,
      }),
    },
    {
      id: 'zpp.rospotrebnadzor.ru',
      url: config.ROSPOTREBNADZOR_NEWS_URL,
      enabled: config.INGESTION_ENABLE_ROSPOTREBNADZOR,
      tier: 'official-regulator',
      fetch: () => fetchOfficialHtmlSource({
        source: 'zpp.rospotrebnadzor.ru', url: config.ROSPOTREBNADZOR_NEWS_URL, issuer: 'Роспотребнадзор', mode: 'links',
        includeHref: /\/news\/federal\/\d+\/?(?:[?#].*)?$/i, maxDocuments: 200, ...common,
      }),
    },
  ];
}

app.get('/health', async (_request, reply) => {
  try {
    await getPool().query('SELECT 1');
    return { status: 'ok', database: 'ok', service: 'api', stage: 's9-delivery-lifecycle' };
  } catch (error) {
    reply.code(503);
    return { status: 'degraded', database: 'error', service: 'api', error: error instanceof Error ? error.message : 'unknown error' };
  }
});

app.post('/auth/max', async (request, reply) => {
  if (!config.MAX_BOT_TOKEN) return reply.code(503).send({ error: 'MAX_BOT_TOKEN_NOT_CONFIGURED' });
  const body = request.body as { initData?: string; appData?: string } | null;
  const appData = body?.initData ?? body?.appData;
  if (!appData) return reply.code(400).send({ error: 'INIT_DATA_REQUIRED' });
  try {
    const validated = validateWebAppData({
      appData,
      botToken: config.MAX_BOT_TOKEN,
      maxAgeSeconds: config.MAX_INIT_DATA_MAX_AGE_SECONDS,
    });
    const identity = await upsertMaxIdentity({ user: validated.user, chatId: validated.chatId });
    const session = makeSession({
      userId: identity.maxUserId,
      companyId: identity.companyId,
      secret: config.SESSION_SECRET,
      ttlSeconds: config.SESSION_TTL_SECONDS,
      startParam: validated.startParam,
    });
    return {
      token: session.token,
      expiresAt: session.claims.expiresAt,
      user: validated.user,
      companyId: identity.companyId,
      startParam: validated.startParam,
    };
  } catch (error) {
    return reply.code(401).send({ error: 'MAX_AUTH_FAILED', message: error instanceof Error ? error.message : 'invalid MAX data' });
  }
});

app.post('/auth/dev', async (request, reply) => {
  if (!config.ALLOW_DEV_AUTH || config.NODE_ENV === 'production') return reply.code(404).send({ error: 'NOT_FOUND' });
  const body = request.body as { userId?: string } | null;
  const userId = body?.userId?.trim() || 'dev-user';
  const identity = await ensureDevIdentity(userId.startsWith('dev-') ? userId : `dev-${userId}`);
  const session = makeSession({
    userId: identity.maxUserId,
    companyId: identity.companyId,
    secret: config.SESSION_SECRET,
    ttlSeconds: config.SESSION_TTL_SECONDS,
    dev: true,
  });
  return { token: session.token, userId: identity.maxUserId, companyId: identity.companyId, dev: true };
});

app.get('/auth/me', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return { userId: auth.claims.sub, companyId: auth.claims.companyId, startParam: auth.claims.startParam ?? null, dev: Boolean(auth.claims.dev) };
});

app.get('/company/profile', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return getProfileState(auth.claims.companyId);
});

app.put('/company/profile', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  const body = request.body as { patch?: Record<string, unknown>; answeredFields?: string[] } | null;
  if (!body?.patch || typeof body.patch !== 'object') return reply.code(400).send({ error: 'PATCH_REQUIRED' });
  try { return await saveProfileDraft({ companyId: auth.claims.companyId, patch: body.patch, answeredFields: body.answeredFields }); }
  catch (error) { return reply.code(400).send({ error: 'INVALID_PROFILE_DRAFT', message: error instanceof Error ? error.message : 'invalid profile' }); }
});

app.post('/company/profile/confirm', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  try {
    const profile = await confirmProfileDraft(auth.claims.companyId);
    await recalculateCompany(auth.claims.companyId, 'profile_confirmed');
    return { profile, impacts: await listImpacts(auth.claims.companyId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'confirm failed';
    return reply.code(message.startsWith('PROFILE_INCOMPLETE') ? 409 : 400).send({ error: 'PROFILE_CONFIRM_FAILED', message });
  }
});

app.get('/company/profile/history', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return { items: await getProfileHistory(auth.claims.companyId) };
});

app.get('/impacts', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return listImpacts(auth.claims.companyId);
});

app.get('/impacts/history', async(request,reply)=>{
  const auth=requireAuth(request,reply);if(!auth)return;
  return listImpacts(auth.claims.companyId,true);
});

app.get('/impacts/:id', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  const id = (request.params as { id: string }).id;
  const impact = await getImpactById(auth.claims.companyId, id);
  return impact ?? reply.code(404).send({ error: 'IMPACT_NOT_FOUND' });
});

app.post('/impacts/:id/answer', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  const id = (request.params as { id: string }).id;
  const body = request.body as { field?: string; value?: unknown } | null;
  if (!body?.field) return reply.code(400).send({ error: 'FIELD_REQUIRED' });
  try { return await answerImpactQuestion({ companyId: auth.claims.companyId, impactId: id, field: body.field, value: body.value, actorId: auth.claims.sub }); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'answer failed';
    return reply.code(message === 'STALE_IMPACT' ? 409 : 400).send({ error: message });
  }
});

app.post('/impacts/:id/feedback', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  const id = (request.params as { id: string }).id;
  const body = request.body as { value?: string; comment?: string } | null;
  if (!body?.value) return reply.code(400).send({ error: 'VALUE_REQUIRED' });
  const result = await addImpactFeedback({ companyId: auth.claims.companyId, impactId: id, value: body.value, comment: body.comment, actorId: auth.claims.sub });
  return result ?? reply.code(404).send({ error: 'IMPACT_NOT_FOUND' });
});

app.patch('/actions/:id', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  const id = (request.params as { id: string }).id;
  const body = request.body as { status?: 'open'|'in_progress'|'completed'|'dismissed' } | null;
  if (!body?.status || !['open','in_progress','completed','dismissed'].includes(body.status)) return reply.code(400).send({ error: 'INVALID_STATUS' });
  try {
    const result = await updateActionStatus({ companyId: auth.claims.companyId, actionId: id, status: body.status, actorId: auth.claims.sub });
    return result ?? reply.code(404).send({ error: 'ACTION_NOT_FOUND' });
  } catch(error) {
    if(error instanceof Error && error.message==='STALE_ACTION')return reply.code(409).send({error:'STALE_ACTION'});
    throw error;
  }
});

app.get('/notifications', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return { items: await listNotifications(auth.claims.companyId) };
});

app.get('/audit', async (request, reply) => {
  const auth = requireAuth(request, reply); if (!auth) return;
  return { items: await listAudit(auth.claims.companyId) };
});

if (config.NODE_ENV !== 'production') {
  app.get('/dev/demo', async (request, reply) => {
    const query = request.query as { profile?: string; rule?: string };
    const catalog = await getDemoCatalog();
    const profileId = query.profile ?? catalog.profiles[0]?.fixtureId;
    const ruleId = query.rule ?? catalog.rules[0]?.ruleId;
    if (!profileId || !ruleId) return reply.code(503).send({ error: 'Demo seed is empty.' });
    const [profile, rule] = await Promise.all([getDemoProfile(profileId), getLegalRule(ruleId)]);
    if (!profile || !rule) return reply.code(404).send({ error: 'Fixture not found', catalog });
    if (rule.tags.includes('review-published')) return reply.code(409).send({ error: 'REVIEW_BUNDLE_RECALCULATION_NOT_IMPLEMENTED' });
    const assessment = assessRule({ profile, rule, now: new Date().toISOString() });
    return { catalog, profile, rule, assessment };
  });
}


app.get('/admin/llm/status', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const configured = config.LLM_PROVIDER === 'mock'
    ? true
    : config.LLM_PROVIDER === 'gigachat'
      ? Boolean(config.GIGACHAT_AUTH_KEY)
      : Boolean(config.DEEPSEEK_API_KEY);
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL ?? (config.LLM_PROVIDER === 'gigachat' ? 'GigaChat-2-Pro' : config.LLM_PROVIDER === 'deepseek' ? 'deepseek-chat' : 'mock-regulatory-v1'),
    configured,
    timeoutMs: config.LLM_TIMEOUT_MS,
    secretsExposed: false,
  };
});

app.post('/admin/llm/smoke', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const provider = createProvider({
      provider: config.LLM_PROVIDER,
      gigachatAuthKey: config.GIGACHAT_AUTH_KEY,
      gigachatScope: config.GIGACHAT_SCOPE,
      gigachatOauthUrl: config.GIGACHAT_OAUTH_URL,
      gigachatBaseUrl: config.GIGACHAT_BASE_URL,
      deepseekApiKey: config.DEEPSEEK_API_KEY,
      deepseekBaseUrl: config.DEEPSEEK_BASE_URL,
      model: config.LLM_MODEL,
      timeoutMs: config.LLM_TIMEOUT_MS,
    });
    const draft = await extractRegulatoryDraft(provider, {
      sourceTitle: 'LLM smoke test',
      officialUrl: 'https://example.test/source',
      sourceTextOrigin: 'synthetic',
      sourceText: 'Организации, которые осуществляют дистанционную продажу товаров, обязаны разместить на сайте сведения о продавце. Требование применяется с 1 января 2027 года.',
    });
    return { status: 'ok', provider: provider.name, model: provider.model, draft };
  } catch (error) {
    return reply.code(502).send({ status: 'error', error: 'LLM_SMOKE_FAILED', message: error instanceof Error ? error.message : 'unknown error' });
  }
});

app.get('/admin/ingestion-sources', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return {
    items: apiIngestionSources().map(({ id, url, enabled, tier }) => ({ id, url, enabled, tier })),
    behavior: 'Sources are independent: one blocked source does not stop the others.',
  };
});

app.post('/admin/ingest', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const sources = apiIngestionSources().filter((source) => source.enabled);
  const results = await Promise.all(sources.map(async (source) => {
    const runId = await startIngestionRun(source.id, source.url);
    try {
      const fetched = await source.fetch();
      const staged = await stageSourceDocuments({ documents: fetched.documents, relevance: scorePilotRelevance });
      await finishIngestionRun({
        runId, status: 'success', fetchedCount: fetched.rawCount, createdCount: staged.created,
        changedCount: staged.changed, candidateCount: staged.candidates,
        metadata: { datasetUrl: fetched.datasetUrl, tier: source.tier },
      });
      return { source: source.id, tier: source.tier, status: 'success' as const, runId, fetched: fetched.rawCount, ...staged };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ingestion failed';
      await finishIngestionRun({ runId, status: 'failed', error: message, metadata: { tier: source.tier } });
      return { source: source.id, tier: source.tier, status: 'failed' as const, runId, error: message };
    }
  }));
  const success = results.filter((item) => item.status === 'success');
  if (success.length === 0) return reply.code(502).send({ error: 'ALL_INGESTION_SOURCES_FAILED', sources: results });
  return {
    status: success.length === results.length ? 'success' : 'partial',
    totals: success.reduce((acc, item) => ({
      fetched: acc.fetched + item.fetched,
      created: acc.created + item.created,
      changed: acc.changed + item.changed,
      candidates: acc.candidates + item.candidates,
    }), { fetched: 0, created: 0, changed: 0, candidates: 0 }),
    sources: results,
  };
});

app.post('/admin/source-documents/manual', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const body = request.body as {
    title?: string; officialUrl?: string; issuer?: string; number?: string; publicationDate?: string; sourceText?: string;
  } | null;
  if (!body?.title?.trim() || !body?.officialUrl?.trim() || !body?.sourceText?.trim()) {
    return reply.code(400).send({ error: 'TITLE_URL_AND_SOURCE_TEXT_REQUIRED' });
  }
  try {
    const document = makeManualOfficialDocument({
      title: body.title,
      officialUrl: body.officialUrl,
      issuer: body.issuer,
      number: body.number,
      publicationDate: body.publicationDate,
      sourceText: body.sourceText,
    });
    const staged = await stageSourceDocuments({ documents: [document], relevance: scorePilotRelevance });
    return { documentId: staged.documentIds[0], staged };
  } catch (error) {
    return reply.code(400).send({ error: 'MANUAL_SOURCE_REJECTED', message: error instanceof Error ? error.message : 'invalid source' });
  }
});

app.get('/admin/source-documents', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const query = request.query as { state?: string; limit?: string };
  return { items: await listSourceDocuments({ state: query.state, limit: query.limit ? Number(query.limit) : undefined }) };
});

app.post('/admin/source-documents/:id/extract', async (request,reply)=>{
  if(!requireAdmin(request,reply))return;
  try {return reply.code(202).send(await enqueueExtraction((request.params as {id:string}).id,request.body??{}));}
  catch(error){return reviewFailure(error,reply);}
});
app.get('/admin/extraction-jobs/:id',async(request,reply)=>{
  if(!requireAdmin(request,reply))return;
  return await getExtractionJob((request.params as {id:string}).id) ?? reply.code(404).send({error:'EXTRACTION_JOB_NOT_FOUND'});
});
app.get('/admin/candidates/:id/publication',async(request,reply)=>{
  if(!requireAdmin(request,reply))return;
  return await publicationDeliveryStatus((request.params as {id:string}).id) ?? reply.code(404).send({error:'PUBLICATION_NOT_FOUND'});
});
app.post('/admin/candidates/:id/publication/retry',async(request,reply)=>{
  if(!requireAdmin(request,reply))return;
  return retryPublicationDelivery((request.params as {id:string}).id,'admin-token');
});

app.get('/admin/candidates', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const query = request.query as { state?: string };
  return { items: await listRuleCandidates(query.state ?? 'pending') };
});

app.get('/admin/candidates/:id', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const candidate = await getRuleCandidate((request.params as { id: string }).id);
  return candidate ?? reply.code(404).send({ error: 'CANDIDATE_NOT_FOUND' });
});

app.post('/admin/candidates/:id/reject', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const id = (request.params as { id: string }).id;
  const body = request.body as { note?: string } | null;
  try {
    const result = await rejectRuleCandidate(id, body?.note);
    return result ?? reply.code(404).send({ error: 'CANDIDATE_NOT_FOUND' });
  } catch (error) {
    if (error instanceof Error && error.message === 'CANDIDATE_ALREADY_REVIEWED') return reply.code(409).send({ error: error.message });
    throw error;
  }
});

function reviewFailure(error: unknown, reply: any) {
  if (error instanceof ReviewError) return reply.code(error.statusCode).send({ error: error.code, details: error.details });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_REVIEW_INPUT', issues: error.issues });
  if (error instanceof Error && error.message === 'REVIEW_DOCUMENT_TOO_DEEP') return reply.code(400).send({ error: error.message });
  throw error;
}

app.post('/admin/candidates/:id/review', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    // Current credential authenticates one shared principal; no client-supplied author identity.
    z.object({}).strict().parse(request.body ?? {});
    const result = await createCandidateReview((request.params as { id: string }).id, 'admin-token');
    return reply.code(201).send(result);
  } catch (error) { return reviewFailure(error, reply); }
});

app.get('/admin/candidates/:id/review', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = z.object({ revision: z.coerce.number().int().positive().max(2147483647).optional() }).strict().parse(request.query);
    const result = await getCandidateReview((request.params as { id: string }).id, query.revision);
    return result ?? reply.code(404).send({ error: 'REVIEW_NOT_FOUND' });
  } catch (error) { return reviewFailure(error, reply); }
});

app.get('/admin/candidates/:id/review/history', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const id = (request.params as { id: string }).id;
  if (!await getCandidateReview(id)) return reply.code(404).send({ error: 'REVIEW_NOT_FOUND' });
  return { items: await listReviewRevisions(id) };
});

app.put('/admin/candidates/:id/review', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try { return await saveCandidateReview((request.params as { id: string }).id, request.body, 'admin-token'); }
  catch (error) { return reviewFailure(error, reply); }
});

app.post('/admin/candidates/:id/review/preview', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const body = z.object({ revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      asOf: calendarDate, profile: CompanyProfileSchema.strict(), tradeObjectId: z.string().trim().min(1).max(200).optional() }).strict().parse(request.body);
    return await previewCandidateReview((request.params as { id: string }).id, body);
  } catch (error) { return reviewFailure(error, reply); }
});

app.post('/admin/candidates/:id/review/:revision/publish', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const params = z.object({ id: z.string().min(1).max(200), revision: z.coerce.number().int().positive().max(2147483647) }).parse(request.params);
    const body = PublishReviewSchema.parse(request.body);
    const result = await publishReadyReviewRevision({ candidateId: params.id, revision: params.revision, actorId: 'admin-token', ...body });
    return reply.code(201).send(result);
  } catch (error) { return reviewFailure(error, reply); }
});

app.post('/admin/candidates/:id/publish', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const id = (request.params as { id: string }).id;
  const body = request.body as { rule?: unknown; note?: string; relation?: { type: 'amends'|'supersedes'|'extends'|'cancels'; evidenceRef?: string; effectiveFrom?: string } } | null;
  if (!body?.rule) return reply.code(400).send({ error: 'APPROVED_RULE_REQUIRED' });
  try {
    const parsed = LegalRuleSchema.omit({ seedHash: true }).passthrough().parse(body.rule) as any;
    return await publishReviewedRuleCandidate({ candidateId: id, approvedRule: parsed, reviewerNote: body.note, relation: body.relation });
  } catch (error) {
    return reply.code(400).send({ error: 'PUBLISH_FAILED', message: error instanceof Error ? error.message : 'publish failed' });
  }
});

app.get('/admin/ingestion-runs', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { items: await listIngestionRuns() };
});

await app.listen({ port: config.API_PORT, host: config.API_HOST });
