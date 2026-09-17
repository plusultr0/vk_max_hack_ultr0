import { assessRule, CompanyProfileSchema, type CompanyProfile } from '@reg/domain';
import { isCalendarDate } from '@reg/llm';
import type { CompiledReviewRule, ReviewCompilation } from './compiler.js';

export function phaseTimeState(phase: CompiledReviewRule, asOf: string) {
  if (!isCalendarDate(asOf)) throw new Error('INVALID_AS_OF');
  if (phase.rule.validTo && asOf >= phase.rule.validTo) return 'ended' as const;
  if (phase.rule.validFrom && asOf < phase.rule.validFrom) return 'upcoming' as const;
  return 'active' as const;
}

// Pure, hypothetical preview. It neither selects database rule versions nor stores assessments.
export function previewReview(compilation: ReviewCompilation, input: { profile: CompanyProfile; asOf: string; tradeObjectId?: string }) {
  if (!compilation.ready) throw new Error('REVIEW_NOT_READY');
  const profile = CompanyProfileSchema.strict().parse(input.profile);
  return compilation.rules.map((phase) => {
    const timeState = phaseTimeState(phase, input.asOf);
    const contextRequired = phase.scope === 'trade_object' && !input.tradeObjectId;
    return { phaseId: phase.phaseId, ruleId: phase.rule.ruleId, scope: phase.scope, timeState,
      tradeObjectId: phase.scope === 'trade_object' ? input.tradeObjectId ?? null : null,
      contextRequired, evaluation: timeState === 'ended' || contextRequired ? null : assessRule({ profile, rule: phase.rule, now: `${input.asOf}T00:00:00.000Z` }) };
  });
}
