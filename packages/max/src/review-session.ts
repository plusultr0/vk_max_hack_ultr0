import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const Claims = z.object({ actor: z.literal('admin-token'), expiresAt: z.number().int(), csrf: z.string().regex(/^[a-f0-9]{48}$/) }).strict();
export const REVIEW_SESSION_SECONDS = 45 * 60;
export function constantTimeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
const signature = (payload: string, secret: string, adminToken: string) => createHmac('sha256', secret).update(`review-v1:${adminToken}:${payload}`).digest('base64url');
export function makeReviewSession(secret: string, adminToken: string, now = Date.now()) {
  if (!adminToken) throw new Error('ADMIN_TOKEN_REQUIRED');
  const claims = Claims.parse({ actor: 'admin-token', expiresAt: Math.floor(now / 1000) + REVIEW_SESSION_SECONDS, csrf: randomBytes(24).toString('hex') });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${payload}.${signature(payload, secret, adminToken)}`, claims };
}
export function verifyReviewSession(token: string, secret: string, adminToken: string, now = Date.now()) {
  if (!adminToken || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 1024) throw new Error('INVALID_REVIEW_SESSION');
  const [payload, signed] = token.split('.');
  if (!constantTimeEqual(signed, signature(payload!, secret, adminToken))) throw new Error('INVALID_REVIEW_SESSION');
  const claims = Claims.parse(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')));
  if (claims.expiresAt <= Math.floor(now / 1000) || claims.expiresAt > Math.floor(now / 1000) + REVIEW_SESSION_SECONDS) throw new Error('REVIEW_SESSION_EXPIRED');
  return claims;
}
