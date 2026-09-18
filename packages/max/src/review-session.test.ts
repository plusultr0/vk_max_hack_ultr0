import { expect, it } from 'vitest';
import { constantTimeEqual, makeReviewSession, verifyReviewSession, REVIEW_SESSION_SECONDS } from './review-session.js';

it('binds the review session to admin credential and expiry', () => {
  const now = Date.now(); const session = makeReviewSession('test-session-secret', 'test-admin', now);
  expect(verifyReviewSession(session.token, 'test-session-secret', 'test-admin', now)).toEqual(session.claims);
  expect(() => verifyReviewSession(session.token, 'test-session-secret', 'rotated-admin', now)).toThrow();
  expect(() => verifyReviewSession(session.token, 'wrong-session-key', 'test-admin', now)).toThrow();
  expect(() => verifyReviewSession(session.token, 'test-session-secret', 'test-admin', now + REVIEW_SESSION_SECONDS * 1000)).toThrow();
  expect(() => verifyReviewSession(session.token + 'a', 'test-session-secret', 'test-admin', now)).toThrow();
});
it('never accepts an empty configured secret or a malformed cookie', () => {
  expect(constantTimeEqual('', '')).toBe(false);
  expect(constantTimeEqual(['test'], 'test')).toBe(false);
  expect(() => makeReviewSession('secret', '')).toThrow();
  expect(() => verifyReviewSession('not-a-cookie', 'secret', 'admin')).toThrow();
});
