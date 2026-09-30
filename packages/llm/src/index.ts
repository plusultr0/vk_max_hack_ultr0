import { randomUUID } from 'node:crypto';
import { REGULATORY_EXTRACTION_JSON_SCHEMA, type LlmProvider } from './extraction.js';
export * from './extraction.js';
export * from './source.js';

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
  async generateJson(input: { system: string; user: string; jsonSchema?: Record<string, unknown> }): Promise<unknown> {
    const parsed = JSON.parse(input.user) as { sourceTitle: string; detectedDates: string[]; sourceSegments: Array<{ sourceSegmentIndex: number; text: string }> };

    return {
      title: parsed.sourceTitle,
      summary: 'Черновая структура из mock-провайдера для проверки конвейера.',
      phases: [],
      dateNotes: parsed.detectedDates.map((date) => ({ date, reason: 'Mock: дата обнаружена в тексте, нормативная роль не определена.', sourceSegmentIndexes: parsed.sourceSegments.map((s) => s.sourceSegmentIndex) })),
      uncertaintyNotes: ['Mock provider does not infer legal conditions.'],
    };
  }
}

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  constructor(
    private readonly options: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number },
  ) {}
  get model() { return this.options.model ?? 'deepseek-chat'; }

  async generateJson(input: { system: string; user: string; jsonSchema?: Record<string, unknown> }): Promise<unknown> {
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

  async generateJson(input: { system: string; user: string; jsonSchema?: Record<string, unknown> }): Promise<unknown> {
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
          schema: input.jsonSchema ?? REGULATORY_EXTRACTION_JSON_SCHEMA,
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

export * from './automation-schema.js';
