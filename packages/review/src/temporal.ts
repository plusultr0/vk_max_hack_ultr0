import { assessRule, CompanyProfileSchema, setFactPath, validateFactValue, type CompanyProfile } from '@reg/domain';
import { isCalendarDate } from '@reg/llm';
import type { CompiledReviewRule, ReviewCompilation } from './compiler.js';

export function phaseTimeState(phase: CompiledReviewRule, asOf: string) {
  if (!isCalendarDate(asOf)) throw new Error('INVALID_AS_OF');
  if (phase.rule.validTo && asOf >= phase.rule.validTo) return 'ended' as const;
  if (phase.rule.validFrom && asOf < phase.rule.validFrom) return 'upcoming' as const;
  return 'active' as const;
}

// Pure, hypothetical preview. It neither selects database rule versions nor stores assessments.
export function previewReview(compilation: ReviewCompilation, input: { profile: CompanyProfile; asOf: string; tradeObjectId?: string; factValues?: Record<string, unknown> }) {
  if (!compilation.ready) throw new Error('REVIEW_NOT_READY');
  const profile = CompanyProfileSchema.strict().parse(input.profile);
  const values = input.factValues ?? {};
  const bindings = compilation.rules.flatMap(p => p.rule.factModel?.requiredFacts ?? []);
  if (Object.keys(values).length > 150 || Object.keys(values).some(key => !bindings.some(r => r.field === key))) {
    throw new Error('PREVIEW_UNKNOWN_FACT');
  }
  return compilation.rules.map((phase) => {
    // Hypothetical values are explicitly supplied by the operator, not read from
    // a company and not recorded as a confirmation. Validate each pinned type.
    const hypothetical: Record<string, unknown> = { ...profile };
    for (const req of phase.rule.factModel?.requiredFacts ?? []) {
      if (!Object.hasOwn(values, req.field)) continue;
      const def = phase.rule.factModel!.definitions.find(d => d.key === req.key && d.version === req.definitionVersion);
      if (!def || !validateFactValue(def, values[req.field])) throw new Error('PREVIEW_INVALID_FACT_VALUE');
      setFactPath(hypothetical, req.field, values[req.field]);
    }
    const timeState = phaseTimeState(phase, input.asOf);
    const contextRequired = phase.scope === 'trade_object' && !input.tradeObjectId;
    return { phaseId: phase.phaseId, ruleId: phase.rule.ruleId, scope: phase.scope, timeState,
      tradeObjectId: phase.scope === 'trade_object' ? input.tradeObjectId ?? null : null,
      contextRequired, evaluation: timeState === 'ended' || contextRequired ? null : assessRule({ profile: hypothetical as CompanyProfile, rule: phase.rule, now: `${input.asOf}T00:00:00.000Z` }) };
  });
}
