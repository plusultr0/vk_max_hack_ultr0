import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DemoProfileFixtureSchema,
  LegalRuleSchema,
  assessRule,
  evaluateCondition,
  firstDayNextMonth,
  type CompanyProfile,
  type LegalRule,
} from './index.js';

const seedBase = new URL('../../../seed/v1/', import.meta.url);
const rules = (JSON.parse(readFileSync(new URL('legal-rules.json', seedBase), 'utf8')) as unknown[])
  .map((item) => LegalRuleSchema.parse(item));
const profiles = (JSON.parse(readFileSync(new URL('profile-fixtures.json', seedBase), 'utf8')) as unknown[])
  .map((item) => DemoProfileFixtureSchema.parse(item));

function rule(id: string): LegalRule {
  const item = rules.find((candidate) => candidate.ruleId === id);
  if (!item) throw new Error(`Missing rule ${id}`);
  return item;
}

function profile(id: string): CompanyProfile {
  const item = profiles.find((candidate) => candidate.fixtureId === id);
  if (!item) throw new Error(`Missing profile ${id}`);
  return item;
}

function assess(profileData: CompanyProfile, ruleId: string) {
  return assessRule({ profile: profileData, rule: rule(ruleId), now: '2026-09-16T12:00:00Z' });
}

describe('tri-state conditions', () => {
  it('short-circuits AND on false and does not request later unknown fields', () => {
    const result = evaluateCondition({
      op: 'and',
      conditions: [
        { op: 'gt', field: 'revenuePreviousYear', value: 120_000_000 },
        { op: 'in', field: 'acquiringBankCategoryAsOf2026_01_01', values: ['systemically_important'] },
      ],
    }, { revenuePreviousYear: 100_000_000, acquiringBankCategoryAsOf2026_01_01: null });

    expect(result.value).toBe('false');
    expect(result.missingFields).toEqual([]);
  });

  it('returns unknown for an actually required missing field', () => {
    const result = evaluateCondition(
      { op: 'eq', field: 'receiptIssuer', value: 'company' },
      { receiptIssuer: null },
    );
    expect(result.value).toBe('unknown');
    expect(result.missingFields).toEqual(['receiptIssuer']);
  });

  it('treats empty array as known and empty', () => {
    expect(evaluateCondition({ op: 'is_empty', field: 'items' }, { items: [] }).value).toBe('true');
  });


  it('known returns unknown instead of silently treating missing as false', () => {
    const result = evaluateCondition({ op: 'known', field: 'usesKkt' }, { usesKkt: null });
    expect(result.value).toBe('unknown');
    expect(result.missingFields).toEqual(['usesKkt']);
  });
});

describe('effective dates', () => {
  it('computes first day of the next month without timezone semantics', () => {
    expect(firstDayNextMonth('2026-08-23')).toBe('2026-09-01');
    expect(firstDayNextMonth('2026-12-31')).toBe('2027-01-01');
  });
});

describe('seed rules', () => {
  it('KKT applies to the prepared internet-settlement fixture', () => {
    const result = assess(profile('toys_small_shop'), 'kkt_online_receipts_v1');
    expect(result.verdict).toBe('applies');
    expect(result.reviewState).toBe('auto');
    expect(result.effectiveFrom).toBe('2025-09-01');
  });

  it('KKT uses manual review when internet settlement exists but user says KKT is not used', () => {
    const base = profile('toys_small_shop');
    const result = assess({ ...base, usesKkt: false }, 'kkt_online_receipts_v1');
    expect(result.verdict).toBe('applies');
    expect(result.reviewState).toBe('needs_review');
    expect(result.actions).toEqual([]);
  });

  it('USN start applies above 20m and not at exact threshold', () => {
    expect(assess(profile('usn_above_previous_threshold'), 'usn_vat_start_2026_v1').verdict).toBe('applies');
    const exact = { ...profile('usn_above_previous_threshold'), income2025Usn: 20_000_000 };
    expect(assess(exact, 'usn_vat_start_2026_v1').verdict).toBe('not_applicable');
  });

  it('new 2026 USN company is not applicable to the start-of-year card without asking 2025 income', () => {
    const result = assess(profile('new_usn_2026'), 'usn_vat_start_2026_v1');
    expect(result.verdict).toBe('not_applicable');
    expect(result.missingFields).toEqual([]);
  });

  it('USN current-year threshold computes next-month effective date', () => {
    const result = assess(profile('usn_crosses_in_august'), 'usn_vat_threshold_during_2026_v1');
    expect(result.verdict).toBe('applies');
    expect(result.effectiveFrom).toBe('2026-09-01');
  });

  it('marking rule applies to supported toy code and is upcoming', () => {
    const r = rule('child_goods_marking_v1');
    const result = assess(profile('toys_small_shop'), r.ruleId);
    expect(result.verdict).toBe('applies');
    expect(r.legalStatus).toBe('upcoming');
    expect(result.effectiveFrom).toBe('2027-03-01');
  });

  it('PD rule separates applicability from compliance', () => {
    const result = assess(profile('toys_small_shop'), 'pd_consent_separate_v1');
    expect(result.verdict).toBe('applies');
    expect(result.complianceState).toBe('action_required');
    expect(result.actions.map((item) => item.actionKey)).toContain('separate_consent');
  });

  it('distance seller identity creates action when checked fields are missing', () => {
    const result = assess(profile('toys_small_shop'), 'distance_seller_identity_v1');
    expect(result.verdict).toBe('applies');
    expect(result.complianceState).toBe('action_required');
    expect(result.actions).toHaveLength(1);
  });

  it('digital ruble asks for bank category when revenue and agreement qualify', () => {
    const result = assess(profile('digital_ruble_unknown_bank'), 'digital_ruble_acceptance_v1');
    expect(result.verdict).toBe('needs_info');
    expect(result.missingFields).toEqual(['acquiringBankCategoryAsOf2026_01_01']);
  });

  it('digital ruble short-circuits low revenue before unknown bank', () => {
    const base = profile('digital_ruble_unknown_bank');
    const result = assess({ ...base, revenuePreviousYear: 100_000_000 }, 'digital_ruble_acceptance_v1');
    expect(result.verdict).toBe('not_applicable');
    expect(result.missingFields).toEqual([]);
  });
});
