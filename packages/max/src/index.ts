import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
export * from './review-session.js';

const MaxUserSchema = z.object({
  user_id: z.union([z.number(), z.string()]).optional(),
  id: z.union([z.number(), z.string()]).optional(),
  first_name: z.string().optional(),
  last_name: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  language_code: z.string().nullable().optional(),
  photo_url: z.string().nullable().optional(),
}).refine((user) => user.user_id != null || user.id != null, { message: 'MAX user id is missing' })
  .transform((user) => ({ ...user, user_id: user.user_id ?? user.id! }));

export type MaxUser = z.infer<typeof MaxUserSchema>;

export type ValidatedWebAppData = {
  user: MaxUser;
  chatId: string | null;
  queryId: string | null;
  authDate: number;
  startParam: string | null;
  raw: Record<string, string>;
};

function hmacSha256(key: string | Buffer, value: string | Buffer): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function safeEqualHex(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseUniquePairs(input: string): Array<[string, string]> {
  const rawPairs = input.split('&').filter(Boolean).map((pair) => {
    const separator = pair.indexOf('=');
    if (separator < 0) return [pair, ''] as [string, string];
    return [pair.slice(0, separator), pair.slice(separator + 1)] as [string, string];
  });
  const seen = new Set<string>();
  for (const [key] of rawPairs) {
    if (seen.has(key)) throw new Error(`Duplicate MAX launch parameter: ${key}`);
    seen.add(key);
  }
  return rawPairs;
}

/**
 * Implements MAX WebAppData validation from the official MAX developer docs.
 * The first HMAC uses the literal string "WebAppData" as key and BOT_TOKEN as data.
 */
export function validateWebAppData(input: {
  appData: string;
  botToken: string;
  nowMs?: number;
  maxAgeSeconds?: number;
}): ValidatedWebAppData {
  const pairs = parseUniquePairs(input.appData);
  const hashPair = pairs.find(([key]) => key === 'hash');
  if (!hashPair) throw new Error('MAX WebAppData hash is missing');

  const decoded = pairs.map(([key, value]) => [key, decodeURIComponent(value)] as [string, string]);
  const providedHash = decoded.find(([key]) => key === 'hash')?.[1] ?? '';
  const launchParams = decoded
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = hmacSha256('WebAppData', input.botToken);
  const calculatedHash = hmacSha256(secretKey, launchParams).toString('hex');
  if (!safeEqualHex(calculatedHash, providedHash)) throw new Error('MAX WebAppData signature mismatch');

  const params = Object.fromEntries(decoded.filter(([key]) => key !== 'hash')) as Record<string, string>;
  const authDate = Number(params.auth_date);
  if (!Number.isFinite(authDate)) throw new Error('MAX auth_date is invalid');
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const maxAge = input.maxAgeSeconds ?? 3600;
  if (authDate > nowSeconds + 60) throw new Error('MAX auth_date is in the future');
  if (nowSeconds - authDate > maxAge) throw new Error('MAX WebAppData is expired');

  if (!params.user) throw new Error('MAX user is missing');
  const user = MaxUserSchema.parse(JSON.parse(params.user));
  let chatId: string | null = null;
  if (params.chat) {
    const chat = z.object({ id: z.union([z.number(), z.string()]) }).passthrough().parse(JSON.parse(params.chat));
    chatId = String(chat.id);
  }

  return {
    user,
    chatId,
    queryId: params.query_id ?? null,
    authDate,
    startParam: params.start_param ?? params.startapp ?? null,
    raw: params,
  };
}

export type SessionClaims = {
  sub: string;
  companyId: string;
  issuedAt: number;
  expiresAt: number;
  startParam?: string | null;
  dev?: boolean;
};

function signPart(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signPart(secret, body)}`;
}

export function verifySession(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionClaims {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new Error('Invalid session token');
  const expected = signPart(secret, body);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Invalid session signature');
  const claims = z.object({
    sub: z.string(),
    companyId: z.string(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    startParam: z.string().nullable().optional(),
    dev: z.boolean().optional(),
  }).parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  if (claims.expiresAt < nowSeconds) throw new Error('Session expired');
  return claims;
}

export function makeSession(input: {
  userId: string;
  companyId: string;
  secret: string;
  ttlSeconds: number;
  startParam?: string | null;
  dev?: boolean;
  nowSeconds?: number;
}): { token: string; claims: SessionClaims } {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: input.userId,
    companyId: input.companyId,
    issuedAt,
    expiresAt: issuedAt + input.ttlSeconds,
    startParam: input.startParam ?? null,
    dev: input.dev,
  };
  return { token: signSession(claims, input.secret), claims };
}

export class MaxApiClient {
  constructor(private readonly config: { apiBaseUrl: string; botToken: string }) {}

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.config.botToken,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`MAX API ${response.status}: ${text}`);
    return body;
  }

  async sendMessageToUser(input: { userId: string; text: string; button?: { text: string; url: string }; notify?: boolean }) {
    const attachments = input.button ? [{
      type: 'inline_keyboard',
      payload: { buttons: [[{ type: 'link', text: input.button.text, url: input.button.url }]] },
    }] : undefined;
    return this.request(`/messages?user_id=${encodeURIComponent(input.userId)}`, {
      method: 'POST',
      body: JSON.stringify({ text: input.text, attachments, notify: input.notify ?? true }),
    });
  }

  async sendMessageToChat(input: { chatId: string; text: string; button?: { text: string; url: string } }) {
    const attachments = input.button ? [{
      type: 'inline_keyboard',
      payload: { buttons: [[{ type: 'link', text: input.button.text, url: input.button.url }]] },
    }] : undefined;
    return this.request(`/messages?chat_id=${encodeURIComponent(input.chatId)}`, {
      method: 'POST',
      body: JSON.stringify({ text: input.text, attachments }),
    });
  }

  async subscribe(input: { url: string; secret?: string; updateTypes?: string[] }) {
    return this.request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        url: input.url,
        secret: input.secret,
        update_types: input.updateTypes ?? ['bot_started', 'message_created', 'message_callback'],
      }),
    });
  }
}

export function buildMiniAppDeepLink(botUsername: string, payload: string): string {
  return `https://max.ru/${encodeURIComponent(botUsername)}?startapp=${encodeURIComponent(payload)}`;
}
