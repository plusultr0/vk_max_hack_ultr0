import type { CompanyProfile, LegalRule } from './schemas.js';

function readField(profile: CompanyProfile, field: string): unknown {
  return (profile as Record<string, unknown>)[field];
}

export function firstDayNextMonth(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

export function evaluateEffectiveFrom(rule: LegalRule, profile: CompanyProfile): string | null {
  switch (rule.effectiveFrom.type) {
    case 'fixed':
      return rule.effectiveFrom.value;
    case 'rule_valid_from':
      return rule.validFrom;
    case 'none':
      return null;
    case 'first_day_next_month': {
      const source = readField(profile, rule.effectiveFrom.sourceField);
      if (typeof source !== 'string') return null;
      return firstDayNextMonth(source);
    }
  }
  return null;
}
