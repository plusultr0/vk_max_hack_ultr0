import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callbackButton, makeSession, openMiniAppButton, validateWebAppData, verifySession } from './index.js';

function hmac(key: string | Buffer, data: string | Buffer) {
  return createHmac('sha256', key).update(data).digest();
}

describe('MAX auth helpers', () => {
  it('builds native callback and mini-app buttons', () => {
    expect(openMiniAppButton('t106_hakaton_max_bot','Открыть','feed')).toEqual({
      type:'open_app',text:'Открыть',web_app:'t106_hakaton_max_bot',payload:'feed',
    });
    expect(callbackButton('Статус','nav:status')).toEqual({type:'callback',text:'Статус',payload:'nav:status'});
  });

  it('roundtrips signed sessions', () => {
    const signed = makeSession({ userId: '42', companyId: 'c1', secret: '1234567890123456', ttlSeconds: 60, nowSeconds: 100 });
    expect(verifySession(signed.token, '1234567890123456', 110).companyId).toBe('c1');
  });

  it('validates WebAppData', () => {
    const token = 'bot-token';
    const raw = [
      ['auth_date', '1000'],
      ['query_id', 'q1'],
      ['user', JSON.stringify({ user_id: 42, first_name: 'Max' })],
    ] as const;
    const launch = raw.map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = hmac('WebAppData', token);
    const hash = hmac(secret, launch).toString('hex');
    const appData = [...raw.map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${hash}`].join('&');
    const result = validateWebAppData({ appData, botToken: token, nowMs: 1_000_000, maxAgeSeconds: 30 });
    expect(String(result.user.user_id)).toBe('42');
  });
});
