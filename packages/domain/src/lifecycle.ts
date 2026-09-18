import { assessRule } from './evaluator.js';
import type { CompanyProfile, EvaluationResult, LegalRule } from './schemas.js';

export type RuntimeRule = { rule: LegalRule; scope: 'company' | 'trade_object'; effectiveOn: string; cancelled: boolean };
export type SelectedRule = RuntimeRule & { timeState: 'active' | 'upcoming' | 'ended' | 'cancelled' };

export function mergeProfileContext(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...current, ...patch };
  if (Object.hasOwn(patch, 'tradeObjectId') && patch.tradeObjectId !== current.tradeObjectId) {
    for (const field of ['tradeObjectRevenuePreviousYear', 'paymentLocationHasInternet']) {
      if (!Object.hasOwn(patch, field)) next[field] = null;
    }
  }
  return next;
}

// Pick the revision first, then check its lifetime. An expired/cancelled latest
// revision is a tombstone: never fall back to an older active revision.
export function selectRuleVersions(rows: RuntimeRule[], asOf: string): SelectedRule[] {
  const groups = new Map<string, RuntimeRule[]>();
  for (const row of rows) {
    if (row.rule.reviewStatus !== 'reviewed') continue;
    groups.set(row.rule.ruleId, [...(groups.get(row.rule.ruleId) ?? []), row]);
  }
  const selected: SelectedRule[] = [];
  for (const group of groups.values()) {
    const current = group.filter(r => r.effectiveOn <= asOf).sort((a,b) => b.rule.version-a.rule.version)[0];
    if (current) selected.push({ ...current, timeState: current.cancelled || current.rule.legalStatus === 'repealed' ? 'cancelled'
      : current.rule.legalStatus === 'expired' || (current.rule.validTo && asOf >= current.rule.validTo) ? 'ended' : 'active' });
    // Future editions are visible, but cannot produce duties before activation.
    for (const future of group.filter(r => r.effectiveOn > asOf && r.rule.version > (current?.rule.version ?? 0))) {
      selected.push({ ...future, timeState: 'upcoming' });
    }
  }
  return selected;
}

export function assessSelectedRule(selected: SelectedRule, profile: CompanyProfile, asOf: string): EvaluationResult {
  const base: EvaluationResult = { verdict: 'not_applicable', reviewState: 'auto', complianceState: 'not_assessed',
    reasons: [], missingFields: [], reviewReasons: [], evidenceRefs: selected.rule.evidenceRefs.map(r => r.id),
    effectiveFrom: selected.effectiveOn, actions: [] };
  if (selected.timeState === 'ended' || selected.timeState === 'cancelled') return { ...base, reasons: ['Действие редакции завершено или отменено.'] };
  if (selected.scope === 'trade_object' && !profile.tradeObjectId) return { ...base, verdict: 'needs_info',
    reasons: ['Для расчёта требуется конкретная торговая точка.'], missingFields: ['tradeObjectId'] };
  const result = assessRule({ rule: selected.rule, profile, now: `${asOf}T00:00:00.000Z` });
  if (!result.effectiveFrom && selected.effectiveOn !== '0001-01-01') result.effectiveFrom = selected.effectiveOn;
  return selected.timeState === 'upcoming' ? { ...result, complianceState: 'not_assessed', actions: [],
    reasons: [...result.reasons, `Предстоящая редакция с ${selected.effectiveOn}. Действия пока не созданы.`] } : result;
}
