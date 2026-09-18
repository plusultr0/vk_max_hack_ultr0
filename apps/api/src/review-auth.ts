import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@reg/config';
import { constantTimeEqual, makeReviewSession, verifyReviewSession, REVIEW_SESSION_SECONDS } from '@reg/max';
import { z } from 'zod';

export function registerReviewAuth(app: FastifyInstance, config: AppConfig) {
  const cookieName = 'reg_review';
  const originAllowed = (request: FastifyRequest) => {
    const allowed = config.REVIEW_UI_ORIGIN ? [config.REVIEW_UI_ORIGIN]
      : config.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];
    return typeof request.headers.origin === 'string' && allowed.includes(request.headers.origin);
  };
  function readSession(request: FastifyRequest) {
    const cookie = request.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!cookie) return null;
    try { return verifyReviewSession(cookie, config.SESSION_SECRET, config.ADMIN_TOKEN ?? ''); } catch { return null; }
  }
  const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
  const attempts = new Map<string, { count: number; until: number }>();
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/admin/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.post('/admin/session', async (req, reply) => {
    if (!originAllowed(req)) return reply.code(403).send({ error: 'REVIEW_ORIGIN_REQUIRED' });
    const now = Date.now();
    for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
    const attempt = attempts.get(req.ip);
    if (attempt && attempt.count >= 5) return reply.code(429).send({ error: 'REVIEW_LOGIN_RATE_LIMIT', retryAfterSeconds: Math.ceil((attempt.until - now) / 1000) });
    const body = z.object({ adminToken: z.string().min(1).max(2000) }).strict().safeParse(req.body);
    if (!body.success || !constantTimeEqual(body.data.adminToken, config.ADMIN_TOKEN ?? '')) {
      if (attempts.size >= 1000 && !attempts.has(req.ip)) return reply.code(429).send({ error: 'REVIEW_LOGIN_RATE_LIMIT' });
      attempts.set(req.ip, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + 60_000 });
      return reply.code(401).send({ error: 'INVALID_ADMIN_TOKEN' });
    }
    attempts.delete(req.ip);
    const session = makeReviewSession(config.SESSION_SECRET, config.ADMIN_TOKEN!);
    reply.header('Set-Cookie', cookie(session.token, REVIEW_SESSION_SECONDS));
    return { actor: session.claims.actor, expiresAt: session.claims.expiresAt, csrf: session.claims.csrf };
  });
  app.get('/admin/session', async (req, reply) => {
    const claims = readSession(req);
    return claims ?? reply.code(401).send({ error: 'REVIEW_LOGIN_REQUIRED' });
  });
  function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    // Existing scripted integrations retain their explicit server-held admin credential.
    if (constantTimeEqual(req.headers['x-admin-token'], config.ADMIN_TOKEN ?? '')) return true;
    const claims = readSession(req);
    if (!claims) { reply.code(403).send({ error: 'REVIEW_LOGIN_REQUIRED' }); return false; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!originAllowed(req) || !constantTimeEqual(req.headers['x-review-csrf'], claims.csrf))) {
      reply.code(403).send({ error: 'REVIEW_CSRF_REQUIRED' }); return false;
    }
    return true;
  }
  app.delete('/admin/session', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    reply.header('Set-Cookie', cookie('', 0));
    return { loggedOut: true };
  });
  return requireAdmin;
}
