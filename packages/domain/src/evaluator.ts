import {
  type CompanyProfile,
  type ComplianceState,
  type EvaluationResult,
  type LegalRule,
  type MaterializedAction,
} from './schemas.js';
import { evaluateCondition } from './condition.js';
import { evaluateEffectiveFrom } from './effective-date.js';

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function evaluateCompliance(rule: LegalRule, profile: CompanyProfile): {
  state: ComplianceState;
  missingFields: string[];
  reasons: string[];
} {
  if (rule.compliance.mode === 'not_assessed') {
    return { state: 'not_assessed', missingFields: [], reasons: [] };
  }

  const compliant = rule.compliance.compliantWhen
    ? evaluateCondition(rule.compliance.compliantWhen, profile)
    : null;
  if (compliant?.value === 'true') {
    return { state: 'compliant', missingFields: [], reasons: compliant.reasons };
  }

  const actionRequired = rule.compliance.actionRequiredWhen
    ? evaluateCondition(rule.compliance.actionRequiredWhen, profile)
    : null;
  if (actionRequired?.value === 'true') {
    return { state: 'action_required', missingFields: [], reasons: actionRequired.reasons };
  }

  const unknownFields = uniq([
    ...(compliant?.value === 'unknown' ? compliant.missingFields : []),
    ...(actionRequired?.value === 'unknown' ? actionRequired.missingFields : []),
  ]);

  return {
    state: 'unknown',
    missingFields: unknownFields,
    reasons: [...(compliant?.reasons ?? []), ...(actionRequired?.reasons ?? [])],
  };
}

function materializeActions(
  rule: LegalRule,
  profile: CompanyProfile,
  result: Pick<EvaluationResult, 'verdict' | 'reviewState' | 'complianceState' | 'effectiveFrom'>,
): MaterializedAction[] {
  if (result.verdict !== 'applies' || result.reviewState === 'needs_review' || result.complianceState === 'compliant') {
    return [];
  }

  return rule.actions.flatMap((action) => {
    if (action.when) {
      const when = evaluateCondition(action.when, profile);
      if (when.value !== 'true') return [];
    }

    let deadline: string | null = null;
    if (action.deadline.type === 'fixed') deadline = action.deadline.value;
    if (action.deadline.type === 'before_effective_from') deadline = result.effectiveFrom;

    return [{
      actionKey: action.actionKey,
      title: action.title,
      description: action.description,
      deadline,
      deadlineKind: action.deadline.type,
    }];
  });
}

export function assessRule(input: {
  profile: CompanyProfile;
  rule: LegalRule;
  now: string;
}): EvaluationResult {
  const profile = input.profile;
  const rule = input.rule;

  const scope = evaluateCondition(rule.applicability.condition, profile);
  if (scope.value === 'false') {
    return {
      verdict: 'not_applicable',
      reviewState: 'auto',
      complianceState: 'not_assessed',
      reasons: scope.reasons,
      missingFields: [],
      reviewReasons: [],
      evidenceRefs: rule.evidenceRefs.map((item) => item.id),
      effectiveFrom: null,
      actions: [],
    };
  }

  if (scope.value === 'unknown') {
    return {
      verdict: 'needs_info',
      reviewState: 'auto',
      complianceState: 'not_assessed',
      reasons: scope.reasons,
      missingFields: scope.missingFields,
      reviewReasons: [],
      evidenceRefs: rule.evidenceRefs.map((item) => item.id),
      effectiveFrom: null,
      actions: [],
    };
  }

  const reviewHits = rule.manualReviewGates.flatMap((gate) => {
    const gateResult = evaluateCondition(gate.condition, profile);
    return gateResult.value === 'true' ? [gate.message] : [];
  });
  const reviewState = reviewHits.length > 0 ? 'needs_review' as const : 'auto' as const;

  const effectiveFrom = evaluateEffectiveFrom(rule, profile);
  const compliance = evaluateCompliance(rule, profile);

  const base: EvaluationResult = {
    verdict: 'applies',
    reviewState,
    complianceState: compliance.state,
    reasons: [...scope.reasons, ...compliance.reasons],
    missingFields: compliance.missingFields,
    reviewReasons: reviewHits,
    evidenceRefs: rule.evidenceRefs.map((item) => item.id),
    effectiveFrom,
    actions: [],
  };

  return {
    ...base,
    actions: materializeActions(rule, profile, base),
  };
}
