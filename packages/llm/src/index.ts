import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const RegulatoryExtractionSchema = z.object({
  title: z.string(),
  summary: z.string(),
  subjectRole: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  conditions: z.array(z.object({
    fieldHint: z.string(),
    operatorHint: z.enum(['eq','gt','gte','lt','lte','in','exists','date_eq','date_before','date_after','other']),
    valueHint: z.unknown().optional(),
    text: z.string(),
    evidenceIndexes: z.array(z.number().int().nonnegative()).min(1),
  })),
  exceptions: z.array(z.object({
    text: z.string(),
    evidenceIndexes: z.array(z.number().int().nonnegative()).min(1),
  })),
  affectedProcesses: z.array(z.string()),
  actionDrafts: z.array(z.object({
    title: z.string(),
    description: z.string(),
    deadlineHint: z.string().nullable(),
    evidenceIndexes: z.array(z.number().int().nonnegative()).min(1),
  })),
  uncertaintyNotes: z.array(z.string()),
  evidence: z.array(z.object({
    index: z.number().int().nonnegative(),
    quote: z.string(),
  })),
});
export type RegulatoryExtraction = z.infer<typeof RegulatoryExtractionSchema>;

export const REGULATORY_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    subjectRole: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    validFrom: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    validTo: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldHint: { type: 'string' },
          operatorHint: { type: 'string', enum: ['eq','gt','gte','lt','lte','in','exists','date_eq','date_before','date_after','other'] },
          valueHint: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
            ],
          },
          text: { type: 'string' },
          evidenceIndexes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
        },
        required: ['fieldHint', 'operatorHint', 'text', 'evidenceIndexes'],
      },
    },
    exceptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          evidenceIndexes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
        },
        required: ['text', 'evidenceIndexes'],
      },
    },
    affectedProcesses: { type: 'array', items: { type: 'string' } },
    actionDrafts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          deadlineHint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          evidenceIndexes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
        },
        required: ['title', 'description', 'deadlineHint', 'evidenceIndexes'],
      },
    },
    uncertaintyNotes: { type: 'array', items: { type: 'string' } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 0 },
          quote: { type: 'string' },
        },
        required: ['index', 'quote'],
      },
    },
  },
  required: [
    'title', 'summary', 'subjectRole', 'validFrom', 'validTo', 'conditions', 'exceptions',
    'affectedProcesses', 'actionDrafts', 'uncertaintyNotes', 'evidence',
  ],
} as const;

export type LlmSourceInput = {
  sourceTitle: string;
  officialUrl: string;
  sourceText: string;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateJson(input: { system: string; user: string }): Promise<unknown>;
}

const SYSTEM_PROMPT = `Ты извлекаешь структуру нормативного требования только из переданного официального текста.
Нельзя заполнять пробелы из памяти модели. Если факт не содержится в тексте, добавь его в uncertaintyNotes.
Каждое условие, исключение и действие ОБЯЗАНО иметь хотя бы один evidenceIndexes, который указывает на реально существующий элемент evidence.
Каждая quote в evidence должна быть короткой дословной цитатой из sourceText, а не пересказом.
operatorHint используй только как один из машинных операторов: eq, gt, gte, lt, lte, in, exists, date_eq, date_before, date_after, other.
Не делай вывод о применимости требования к конкретной компании: это делает отдельный детерминированный rule engine.
Схема описывает один rule draft. Если источник содержит несколько этапов с разными датами/порогами, выдели самый ранний явно описанный этап, а остальные этапы обязательно перечисли в uncertaintyNotes с их датами/порогами; не смешивай их условия в один этап.
Возвращай только данные по заданной JSON-схеме. Результат является черновиком для проверки человеком и НЕ является юридическим заключением.`;

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function regulatoryExtractionQualityIssues(draft: RegulatoryExtraction, sourceText: string): string[] {
  const issues: string[] = [];
  const evidenceIndexes = new Set<number>();
  const normalizedSource = normalizeEvidenceText(sourceText);

  for (const item of draft.evidence) {
    if (evidenceIndexes.has(item.index)) issues.push(`duplicate evidence index ${item.index}`);
    evidenceIndexes.add(item.index);
    const quote = normalizeEvidenceText(item.quote);
    if (!quote) issues.push(`evidence ${item.index} has an empty quote`);
    else if (!normalizedSource.includes(quote)) issues.push(`evidence ${item.index} quote is not verbatim from sourceText`);
  }

  const checkRefs = (label: string, refs: number[]) => {
    if (refs.length === 0) issues.push(`${label} has no evidenceIndexes`);
    for (const ref of refs) if (!evidenceIndexes.has(ref)) issues.push(`${label} references missing evidence index ${ref}`);
  };

  draft.conditions.forEach((item, index) => checkRefs(`condition[${index}]`, item.evidenceIndexes));
  draft.exceptions.forEach((item, index) => checkRefs(`exception[${index}]`, item.evidenceIndexes));
  draft.actionDrafts.forEach((item, index) => checkRefs(`actionDraft[${index}]`, item.evidenceIndexes));

  return issues;
}

function extractionUserPayload(input: LlmSourceInput) {
  return {
    task: 'Extract a structured regulatory-rule draft from the supplied source only.',
    sourceTitle: input.sourceTitle,
    officialUrl: input.officialUrl,
    sourceText: input.sourceText,
    instructions: [
      'Use only sourceText as evidence.',
      'Do not infer missing dates, thresholds, exceptions, subjects or duties.',
      'If the text is insufficient, keep fields nullable/empty and explain the gap in uncertaintyNotes.',
      'Every condition, exception and actionDraft must contain at least one evidenceIndexes value.',
      'Every evidenceIndexes value must point to an element in evidence returned in the same response.',
      'Every evidence.quote must be a verbatim substring of sourceText.',
      'Use machine-like operatorHint values only: eq, gt, gte, lt, lte, in, exists, date_eq, date_before, date_after, other.',
      'If the source contains multiple dated phases, draft only the earliest explicit phase and list every later phase in uncertaintyNotes with the date and threshold/criterion stated in sourceText.',
    ],
  };
}

export async function extractRegulatoryDraft(provider: LlmProvider, input: LlmSourceInput): Promise<RegulatoryExtraction> {
  const sourceText = input.sourceText.trim();
  if (!sourceText) throw new Error('SOURCE_TEXT_REQUIRED');
  const normalizedInput = { ...input, sourceText };

  const firstRaw = await provider.generateJson({ system: SYSTEM_PROMPT, user: JSON.stringify(extractionUserPayload(normalizedInput)) });
  const first = RegulatoryExtractionSchema.parse(firstRaw);
  const firstIssues = regulatoryExtractionQualityIssues(first, sourceText);
  if (firstIssues.length === 0) return first;

  const repairUser = JSON.stringify({
    task: 'Repair the previous regulatory extraction so it passes the evidence-grounding quality gate.',
    sourceTitle: input.sourceTitle,
    officialUrl: input.officialUrl,
    sourceText,
    previousDraft: first,
    qualityIssues: firstIssues,
    instructions: [
      'Return the complete draft again, not a patch.',
      'Use only sourceText. Do not add facts from memory.',
      'Fix every qualityIssues item.',
      'Every condition, exception and actionDraft must cite one or more evidence indexes.',
      'Every cited index must exist in evidence.',
      'Every evidence.quote must occur verbatim in sourceText.',
      'Preserve a fact from previousDraft only if sourceText supports it.',
      'If multiple dated phases exist, keep the earliest phase in the rule and explicitly list later phases in uncertaintyNotes.',
    ],
  });
  const repairedRaw = await provider.generateJson({ system: SYSTEM_PROMPT, user: repairUser });
  const repaired = RegulatoryExtractionSchema.parse(repairedRaw);
  const repairedIssues = regulatoryExtractionQualityIssues(repaired, sourceText);
  if (repairedIssues.length > 0) {
    throw new Error(`EXTRACTION_QUALITY_GATE_FAILED: ${repairedIssues.join('; ')}`);
  }
  return repaired;
}

function parseJsonContent(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    if (error instanceof Error && /certificate|self[- ]signed|unable to verify/i.test(error.message)) {
      throw new Error(`GigaChat TLS verification failed. Install the Russian Ministry of Digital Development root CA and expose it to Node via NODE_EXTRA_CA_CERTS. Original error: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-regulatory-v1';
  async generateJson(input: { system: string; user: string }): Promise<unknown> {
    const parsed = JSON.parse(input.user) as { sourceTitle: string; sourceText: string };
    const excerpt = parsed.sourceText.replace(/\s+/g, ' ').trim().slice(0, 220);
    return {
      title: parsed.sourceTitle,
      summary: 'Черновая структура из mock-провайдера для проверки конвейера.',
      subjectRole: null,
      validFrom: null,
      validTo: null,
      conditions: [],
      exceptions: [],
      affectedProcesses: [],
      actionDrafts: [],
      uncertaintyNotes: ['Mock provider does not infer legal conditions.'],
      evidence: excerpt ? [{ index: 0, quote: excerpt }] : [],
    };
  }
}

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  constructor(
    private readonly options: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number },
  ) {}
  get model() { return this.options.model ?? 'deepseek-chat'; }

  async generateJson(input: { system: string; user: string }): Promise<unknown> {
    const response = await fetchWithTimeout(`${this.options.baseUrl ?? 'https://api.deepseek.com'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    }, this.options.timeoutMs ?? 45_000);
    const text = await response.text();
    if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 1500)}`);
    const body = JSON.parse(text) as any;
    return parseJsonContent(body.choices?.[0]?.message?.content);
  }
}

export class GigaChatProvider implements LlmProvider {
  readonly name = 'gigachat';
  private cachedToken: { value: string; expiresAtMs: number } | null = null;
  constructor(private readonly options: {
    authKey: string;
    scope?: string;
    oauthUrl?: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
  }) {}
  get model() { return this.options.model ?? 'GigaChat-2-Pro'; }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now() + 60_000) return this.cachedToken.value;
    const response = await fetchWithTimeout(this.options.oauthUrl ?? 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.options.authKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope: this.options.scope ?? 'GIGACHAT_API_PERS' }),
    }, this.options.timeoutMs ?? 45_000);
    const text = await response.text();
    if (!response.ok) throw new Error(`GigaChat OAuth ${response.status}: ${text.slice(0, 1500)}`);
    const body = JSON.parse(text) as { access_token?: string; expires_at?: number };
    if (!body.access_token || !body.expires_at) throw new Error('GigaChat OAuth response does not contain access_token/expires_at');
    this.cachedToken = {
      value: body.access_token,
      expiresAtMs: body.expires_at < 10_000_000_000 ? body.expires_at * 1000 : body.expires_at,
    };
    return body.access_token;
  }

  async generateJson(input: { system: string; user: string }): Promise<unknown> {
    const token = await this.accessToken();
    const base = (this.options.baseUrl ?? 'https://api.giga.chat/v1').replace(/\/$/, '');
    const response = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          schema: REGULATORY_EXTRACTION_JSON_SCHEMA,
          strict: true,
        },
      }),
    }, this.options.timeoutMs ?? 45_000);
    const text = await response.text();
    if (!response.ok) throw new Error(`GigaChat ${response.status}: ${text.slice(0, 1500)}`);
    const body = JSON.parse(text) as any;
    const content = body.choices?.[0]?.message?.content;
    if (content === undefined || content === null) throw new Error('GigaChat response does not contain choices[0].message.content');
    return parseJsonContent(content);
  }
}

export function createProvider(config: {
  provider: 'mock'|'gigachat'|'deepseek';
  gigachatAuthKey?: string;
  gigachatScope?: string;
  gigachatOauthUrl?: string;
  gigachatBaseUrl?: string;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  model?: string;
  timeoutMs?: number;
}): LlmProvider {
  if (config.provider === 'mock') return new MockLlmProvider();
  if (config.provider === 'deepseek') {
    if (!config.deepseekApiKey) throw new Error('DEEPSEEK_API_KEY is required');
    return new DeepSeekProvider({ apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: config.model, timeoutMs: config.timeoutMs });
  }
  if (!config.gigachatAuthKey) throw new Error('GIGACHAT_AUTH_KEY is required');
  return new GigaChatProvider({
    authKey: config.gigachatAuthKey,
    scope: config.gigachatScope,
    oauthUrl: config.gigachatOauthUrl,
    baseUrl: config.gigachatBaseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
}
