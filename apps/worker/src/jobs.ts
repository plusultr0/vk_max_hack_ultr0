import { getConfig, type AppConfig } from '@reg/config';
import {
  claimDueNotification,
  finishIngestionRun,
  markNotificationFailed,
  markNotificationSent,
  recoverStaleNotifications,
  notificationStillRelevant,
  stageSourceDocuments,
  startIngestionRun,
} from '@reg/db';
import {
  fetchOfficialHtmlSource,
  fetchPravoOpenData,
  scorePilotRelevance,
  type OfficialHtmlSource,
  type SourceDocument,
} from '@reg/ingestion';
import { callbackButton, openMiniAppButton, MaxApiClient, type MaxButtonRows } from '@reg/max';

type FetchedSource = { datasetUrl: string; documents: SourceDocument[]; rawCount: number };
type SourceDefinition = {
  id: string;
  url: string;
  enabled: boolean;
  tier: 'primary-publication' | 'official-government' | 'official-regulator';
  fetch: () => Promise<FetchedSource>;
};

function htmlSource(config: AppConfig, definition: OfficialHtmlSource): () => Promise<FetchedSource> {
  return () => fetchOfficialHtmlSource({
    ...definition,
    timeoutMs: config.INGESTION_TIMEOUT_MS,
    userAgent: config.INGESTION_USER_AGENT,
    retries: config.INGESTION_RETRIES,
  });
}

export function configuredIngestionSources(config: AppConfig = getConfig()): SourceDefinition[] {
  return [
    {
      id: 'publication.pravo.gov.ru',
      url: config.PRAVO_OPEN_DATA_URL,
      enabled: config.INGESTION_ENABLE_PRAVO,
      tier: 'primary-publication',
      fetch: () => fetchPravoOpenData({
        openDataUrl: config.PRAVO_OPEN_DATA_URL,
        timeoutMs: config.INGESTION_TIMEOUT_MS,
        userAgent: config.INGESTION_USER_AGENT,
        retries: config.INGESTION_RETRIES,
      }),
    },
    {
      id: 'government.ru',
      url: config.GOVERNMENT_DOCS_URL,
      enabled: config.INGESTION_ENABLE_GOVERNMENT,
      tier: 'official-government',
      fetch: htmlSource(config, {
        source: 'government.ru',
        url: config.GOVERNMENT_DOCS_URL,
        issuer: 'Правительство Российской Федерации',
        mode: 'links',
        includeHref: /\/docs\/(?:all\/)?\d+\/?(?:[?#].*)?$/i,
        maxDocuments: 250,
      }),
    },
    {
      id: 'nalog.gov.ru',
      url: config.FNS_CHANGES_URL,
      enabled: config.INGESTION_ENABLE_FNS,
      tier: 'official-regulator',
      fetch: htmlSource(config, {
        source: 'nalog.gov.ru',
        url: config.FNS_CHANGES_URL,
        issuer: 'ФНС России',
        mode: 'page',
        title: 'ФНС России — изменения налогового законодательства 2026',
      }),
    },
    {
      id: 'cbr.ru',
      url: config.CBR_LEGAL_ACTS_URL,
      enabled: config.INGESTION_ENABLE_CBR,
      tier: 'official-regulator',
      fetch: htmlSource(config, {
        source: 'cbr.ru',
        url: config.CBR_LEGAL_ACTS_URL,
        issuer: 'Банк России',
        mode: 'links',
        includeHref: /(?:\/na\/|\/PSystem\/|\/fintech\/|\/analytics\/|\/Crosscut\/LawActs\/)/i,
        maxDocuments: 250,
      }),
    },
    {
      id: 'cbr.ru.digital-ruble',
      url: config.CBR_DIGITAL_RUBLE_URL,
      enabled: config.INGESTION_ENABLE_CBR,
      tier: 'official-regulator',
      fetch: htmlSource(config, {
        source: 'cbr.ru.digital-ruble',
        url: config.CBR_DIGITAL_RUBLE_URL,
        issuer: 'Банк России',
        mode: 'page',
        title: 'Банк России — прием оплаты в цифровых рублях',
      }),
    },
    {
      id: 'zpp.rospotrebnadzor.ru',
      url: config.ROSPOTREBNADZOR_NEWS_URL,
      enabled: config.INGESTION_ENABLE_ROSPOTREBNADZOR,
      tier: 'official-regulator',
      fetch: htmlSource(config, {
        source: 'zpp.rospotrebnadzor.ru',
        url: config.ROSPOTREBNADZOR_NEWS_URL,
        issuer: 'Роспотребнадзор',
        mode: 'links',
        includeHref: /\/news\/federal\/\d+\/?(?:[?#].*)?$/i,
        maxDocuments: 200,
      }),
    },
  ];
}

async function runSource(definition: SourceDefinition) {
  const runId = await startIngestionRun(definition.id, definition.url);
  try {
    const fetched = await definition.fetch();
    const staged = await stageSourceDocuments({ documents: fetched.documents, relevance: scorePilotRelevance });
    await finishIngestionRun({
      runId,
      status: 'success',
      fetchedCount: fetched.rawCount,
      createdCount: staged.created,
      changedCount: staged.changed,
      candidateCount: staged.candidates,
      metadata: { datasetUrl: fetched.datasetUrl, tier: definition.tier },
    });
    return { source: definition.id, tier: definition.tier, status: 'success' as const, runId, fetched: fetched.rawCount, ...staged };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown ingestion error';
    await finishIngestionRun({ runId, status: 'failed', error: message, metadata: { tier: definition.tier } });
    return { source: definition.id, tier: definition.tier, status: 'failed' as const, runId, error: message };
  }
}

export async function runRegulatoryIngestion() {
  const sources = configuredIngestionSources().filter((source) => source.enabled);
  if (sources.length === 0) throw new Error('No ingestion sources are enabled');

  const results = await Promise.all(sources.map((source) => runSource(source)));

  const successes = results.filter((result) => result.status === 'success');
  const failures = results.filter((result) => result.status === 'failed');
  if (successes.length === 0) {
    throw new Error(`All ingestion sources failed: ${failures.map((item) => `${item.source}: ${item.error}`).join('; ')}`);
  }

  const totals = successes.reduce((acc, item) => ({
    fetched: acc.fetched + item.fetched,
    created: acc.created + item.created,
    changed: acc.changed + item.changed,
    candidates: acc.candidates + item.candidates,
  }), { fetched: 0, created: 0, changed: 0, candidates: 0 });

  return {
    status: failures.length ? 'partial' as const : 'success' as const,
    totals,
    sources: results,
  };
}

export async function runPravoIngestion() {
  const source = configuredIngestionSources().find((item) => item.id === 'publication.pravo.gov.ru');
  if (!source) throw new Error('publication.pravo.gov.ru source is not configured');
  const result = await runSource(source);
  if (result.status === 'failed') throw new Error(result.error);
  return result;
}

function notificationMessage(notification: any, botUsername: string): {text:string;buttons:MaxButtonRows} {
  const payload = notification.payload ?? {};
  if(notification.type==='bot_welcome') return {
    text:'Я помогу быстро понять, какие требования из проверенной базы относятся к вашему бизнесу, что нужно сделать и что изменилось.\n\nНачните с Mini App или используйте быстрые команды в чате.',
    buttons:[
      [openMiniAppButton(botUsername,'Начать проверку',payload.startParam??'home')],
      [callbackButton('Статус','nav:status'),callbackButton('Изменения','nav:changes')],
      [callbackButton('Действия','nav:actions'),callbackButton('Помощь','nav:help')],
    ],
  };
  if (notification.type === 'deadline_reminder') {
    const openPayload=payload.impactId ? `assessment_${payload.impactId}` : 'check';
    const rows:MaxButtonRows=[[openMiniAppButton(botUsername,'Открыть действие',openPayload)]];
    if(payload.actionId)rows.push([callbackButton('Отметить выполненным',`action:ask:${payload.actionId}`)]);
    return {
      text: `Напоминание: ${payload.title ?? 'регуляторное действие'}${payload.deadline ? `\nСрок: ${payload.deadline}` : ''}.`,
      buttons:rows,
    };
  }
  const needsInfo=payload.needsInfo===true||payload.verdict==='needs_info';
  return {
    text: needsInfo
      ? `Появилось новое требование, которое может относиться к вашему бизнесу: ${payload.title ?? payload.ruleId ?? 'откройте карточку'}.\n\nЧтобы определить применимость, нужно уточнить данные о бизнесе.`
      : `Для вашего бизнеса найдено новое релевантное изменение: ${payload.title ?? payload.ruleId ?? 'откройте карточку'}.`,
    buttons:[
      [openMiniAppButton(botUsername,needsInfo?'Ответить и проверить':'Открыть карточку',payload.impactId ? `assessment_${payload.impactId}` : 'feed')],
      [callbackButton('Мой статус','nav:status'),callbackButton('Изменения','nav:changes')],
    ],
  };
}

export async function dispatchNotifications(maxBatch = 50) {
  const config = getConfig();
  if (!config.MAX_BOT_TOKEN || !config.MAX_BOT_USERNAME) return { skipped: true, reason: 'MAX not configured' };
  const client = new MaxApiClient({ apiBaseUrl: config.MAX_API_BASE_URL, botToken: config.MAX_BOT_TOKEN });
  await recoverStaleNotifications();
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < maxBatch; i += 1) {
    const notification = await claimDueNotification();
    if (!notification) break;
    try {
      if (!await notificationStillRelevant(notification)) continue;
      const message = notificationMessage(notification,config.MAX_BOT_USERNAME);
      await client.sendMessageToUser({
        userId: notification.max_user_id,
        text: message.text,
        buttons: message.buttons,
      });
      await markNotificationSent(notification.id, notification.claim_token);
      sent += 1;
    } catch (error) {
      await markNotificationFailed(notification.id, 'MAX_DELIVERY_FAILED', notification.claim_token);
      failed += 1;
    }
  }
  return { sent, failed };
}
