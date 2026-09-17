import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateRegulatoryExtraction } from '@reg/llm';
import { assertReviewIdentity, compileReview, createReviewDocument, parseReviewDocument, previewReview, reviewHash, type ReviewDocument, type ReviewExpression } from './index.js';
import { readyTestDocument, testExtraction } from '../test/fixture.js';

const asOf = '2026-09-17';
const extraction = testExtraction();
const compile = (doc: ReviewDocument) => compileReview(doc, extraction, asOf);
const profile = { profileVersion: 1, revenuePreviousYear: 121, hasEpaymentAcceptanceAgreementAsOf2026_01_01: true, isExcludedProduct: false };

describe('review provenance and readiness', () => {
  it('keeps the extraction unchanged and requires explicit review', () => {
    const original = structuredClone(extraction);
    const doc = createReviewDocument(extraction);
    doc.phases[0]!.title = 'Изменено человеком';
    expect(extraction).toEqual(original);
    expect(compile(doc)).toMatchObject({ ready: false, rules: [] });
  });
  it('compiles three simultaneous identities with server-owned exact evidence', () => {
    const result = compile(readyTestDocument());
    expect(result.issues).toEqual([]);
    expect(result.rules).toHaveLength(3);
    expect(new Set(result.rules.map((v) => v.rule.ruleId)).size).toBe(3);
    expect(result.rules.map((v) => v.rule.version)).toEqual([1, 1, 1]);
    expect(result.rules.every((v) => v.rule.reviewStatus === 'needs_review')).toBe(true);
    for (const r of result.rules) for (const e of r.evidence) expect(e.quote).toBe(extraction.sourceSnapshot.segments[e.sourceSegmentIndex]!.text);
  });
  it.each(['conditions', 'exceptions', 'actions'] as const)('blocks silently removed %s', (kind) => {
    const doc = readyTestDocument(); doc.phases[0]![kind].splice(0, 1);
    expect(compile(doc).issues.some((i) => i.code === 'SOURCE_ITEM_COVERAGE')).toBe(true);
  });
  it('blocks a missing phase and preserves identities across reordering', () => {
    const before = readyTestDocument(); const reordered = structuredClone(before); reordered.phases.reverse();
    expect(() => assertReviewIdentity(before, reordered)).not.toThrow();
    expect(compile(reordered).ready).toBe(true);
    reordered.phases.pop();
    expect(() => assertReviewIdentity(before, reordered)).toThrow('REVIEW_IDENTITY_CHANGED');
    expect(compile(reordered).ready).toBe(false);
  });
  it('requires reasons for exclusion and does not permit empty publish packages', () => {
    const doc = readyTestDocument(); doc.phases[0]!.decision = 'exclude'; doc.phases[0]!.reason = null;
    expect(compile(doc).ready).toBe(false);
    doc.phases[0]!.reason = 'Дубликат этапа по результатам проверки';
    expect(compile(doc).rules).toHaveLength(2);
    doc.phases.forEach((p) => { p.decision = 'exclude'; });
    expect(compile(doc).issues.some((i) => i.code === 'NO_INCLUDED_PHASES')).toBe(true);
  });
  it('cannot bypass source warnings, duplicate identities, or absent evidence', () => {
    const doc = readyTestDocument(); doc.resolutions = [];
    expect(compile(doc).issues.some((i) => i.code === 'SOURCE_ISSUE_UNRESOLVED')).toBe(true);
    const duplicate = readyTestDocument(); duplicate.phases[1]!.id = duplicate.phases[0]!.id;
    expect(compile(duplicate).issues.some((i) => i.code === 'DUPLICATE_ID')).toBe(true);
    const noEvidence = readyTestDocument(); noEvidence.phases[0]!.actions[0]!.sourceSegmentIndexes = [999];
    expect(compile(noEvidence).issues.some((i) => i.code === 'INVALID_REFERENCE')).toBe(true);
  });
  it('has canonical hashes across JSONB key order and changed content', () => {
    const doc = readyTestDocument(); const shuffled = Object.fromEntries(Object.entries(doc).reverse());
    expect(reviewHash(shuffled)).toBe(reviewHash(doc));
    shuffled.title = 'Другая редакция'; expect(reviewHash(shuffled)).not.toBe(reviewHash(doc));
  });
  it('rejects excessive nesting before recursive schema parsing', () => {
    let node: unknown = {}; for (let i = 0; i < 35; i++) node = { child: node };
    expect(() => parseReviewDocument(node)).toThrow('REVIEW_DOCUMENT_TOO_DEEP');
  });
});

describe('typed conditions and scope', () => {
  it.each([
    ['numeric string', { op: 'gt', field: 'revenuePreviousYear', value: '120' }],
    ['boolean order', { op: 'gt', field: 'usesKkt', value: true }],
    ['invalid enum', { op: 'eq', field: 'taxRegime', value: 'invented' }],
    ['array equality', { op: 'eq', field: 'salesChannels', value: ['own_site'] }],
    ['unknown field', { op: 'eq', field: 'invented', value: true }],
    ['prototype field', { op: 'eq', field: 'toString', value: true }],
    ['invalid date', { op: 'eq', field: 'registrationDate', value: '2026-02-31' }],
  ])('blocks %s', (_name, raw) => {
    const doc = readyTestDocument(); doc.phases[0]!.conditions[0]!.expression = { ...(raw as object), scope: 'company', sourceSegmentIndexes: [0] } as ReviewExpression;
    expect(compile(doc).ready).toBe(false);
  });
  it.each([[119, 'not_applicable'], [120, 'not_applicable'], [121, 'applies']] as const)('threshold %d produces %s', (revenue, verdict) => {
    const preview = previewReview(compile(readyTestDocument()), { profile: { ...profile, revenuePreviousYear: revenue }, asOf });
    expect(preview[0]!.evaluation!.verdict).toBe(verdict);
  });
  it('distinguishes unknown, false, and an applicable exception', () => {
    const c = compile(readyTestDocument());
    const run = (patch: object) => previewReview(c, { profile: { ...profile, ...patch }, asOf })[0]!.evaluation!;
    expect(run({ hasEpaymentAcceptanceAgreementAsOf2026_01_01: null }).verdict).toBe('needs_info');
    expect(run({ hasEpaymentAcceptanceAgreementAsOf2026_01_01: false }).verdict).toBe('not_applicable');
    expect(run({ isExcludedProduct: true }).verdict).toBe('not_applicable');
    expect(run({ isExcludedProduct: null }).missingFields).toContain('isExcludedProduct');
  });
  it('supports nested AND/OR/NOT without flattening the meaning', () => {
    const doc = readyTestDocument();
    doc.phases[0]!.conditions[0]!.expression = { op: 'and', conditions: [doc.phases[0]!.conditions[0]!.expression!,
      { op: 'not', condition: { op: 'or', conditions: [
        { op: 'eq', field: 'legalForm', value: 'other', scope: 'company', sourceSegmentIndexes: [0] },
        { op: 'eq', field: 'taxRegime', value: 'other', scope: 'company', sourceSegmentIndexes: [0] },
      ] } }] };
    Object.assign(doc.phases[0]!.questionMap, { legalForm: 'Форма?', taxRegime: 'Режим?' });
    const c = compile(doc); expect(c.issues).toEqual([]);
    const run = (legalForm: 'IP' | 'other') => previewReview(c, { profile: { ...profile, legalForm, taxRegime: 'USN' }, asOf })[0]!.evaluation!.verdict;
    expect(run('IP')).toBe('applies'); expect(run('other')).toBe('not_applicable');
  });
  it('requires outlet scope and explicit outlet preview context', () => {
    const doc = readyTestDocument();
    const p = doc.phases[0]!;
    p.exceptions[0]!.expression = { op: 'lt', field: 'tradeObjectRevenuePreviousYear', value: 5, scope: 'trade_object', sourceSegmentIndexes: [0] };
    delete p.questionMap.isExcludedProduct; p.questionMap.tradeObjectRevenuePreviousYear = 'Выручка этой точки?';
    expect(compile(doc).issues.some((i) => i.code === 'SCOPE_MISMATCH')).toBe(true);
    p.scope = 'trade_object'; const c = compile(doc); expect(c.ready).toBe(true);
    expect(previewReview(c, { profile, asOf })[0]).toMatchObject({ contextRequired: true, evaluation: null });
    const preview = previewReview(c, { profile: { ...profile, tradeObjectRevenuePreviousYear: 4 }, asOf, tradeObjectId: 'test-outlet' });
    expect(preview[0]!.evaluation!.verdict).toBe('not_applicable');
  });
});

describe('review time and deadlines', () => {
  it('separates upcoming, active and ended dates without inventing phase ends', () => {
    const doc = readyTestDocument();
    doc.phases[0]!.validTo = { date: '2029-09-01', sourceSegmentIndexes: [0] };
    doc.phases[0]!.endReason = 'Исключённая граница тестового интервала.';
    const c = compile(doc);
    const at = (asOf: string) => previewReview(c, { profile, asOf })[0]!;
    expect(at('2026-08-31').timeState).toBe('upcoming');
    expect(at('2026-09-01').timeState).toBe('active');
    expect(at('2028-09-01').timeState).toBe('active');
    expect(at('2029-08-31').timeState).toBe('active');
    expect(at('2029-09-01')).toMatchObject({ timeState: 'ended', evaluation: null });
  });
  it('does not replace relative or unknown deadlines with the phase date', () => {
    const doc = readyTestDocument();
    doc.phases[0]!.actions[0]!.deadline = { kind: 'relative', description: 'после события', sourceSegmentIndexes: [0] };
    expect(compile(doc).issues.some((i) => i.code === 'UNSUPPORTED_DEADLINE')).toBe(true);
    doc.phases[0]!.actions[0]!.deadline = { kind: 'unknown' }; expect(compile(doc).ready).toBe(false);
    doc.phases[0]!.actions[0]!.deadline = { kind: 'none', reason: 'В тесте срок не установлен.' }; expect(compile(doc).ready).toBe(true);
  });
  it('requires grounded dates and rejects reversed intervals', () => {
    const doc = readyTestDocument(); doc.phases[0]!.actions[0]!.deadline = { kind: 'fixed', date: '2030-01-01', sourceSegmentIndexes: [0] };
    expect(compile(doc).issues.some((i) => i.code === 'DATE_NOT_IN_EVIDENCE')).toBe(true);
    doc.phases[0]!.validTo = { date: '2026-09-01', sourceSegmentIndexes: [0] };
    expect(compile(doc).issues.some((i) => i.code === 'INVALID_INTERVAL')).toBe(true);
  });
});

describe('recorded CBR extraction regression (not approved law)', () => {
  it('retains three stages and blocks its unresolved semantic warnings', () => {
    const raw = JSON.parse(readFileSync(new URL('../test/cbr-extraction.json', import.meta.url), 'utf8'));
    const recorded = validateRegulatoryExtraction(raw);
    const doc = createReviewDocument(recorded);
    expect(doc.phases.map((p) => p.validFrom.date)).toEqual(['2026-09-01', '2027-09-01', '2028-09-01']);
    expect(doc.resolutions.filter((r) => r.key.includes('PHASE_END_MATCHES_ANOTHER_START'))).toHaveLength(2);
    expect(compileReview(doc, recorded, asOf)).toMatchObject({ ready: false, rules: [] });
  });
});
