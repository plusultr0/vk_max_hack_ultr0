import { randomUUID } from 'node:crypto';
import { builtinFactDefinitions } from '@reg/domain';
import { regulatoryReviewWarnings, validateRegulatoryExtraction, type RegulatoryExtraction } from '@reg/llm';
import { REVIEW_VERSION, ReviewPredicateSchema, type ReviewDocument, type ReviewExpression } from './schema.js';

export function reviewRequirements(extraction: RegulatoryExtraction) {
  const items: Array<{ key: string; message: string }> = [];
  extraction.uncertaintyNotes.forEach((message, i) => items.push({ key: `uncertainty.${i}`, message }));
  extraction.dateNotes.forEach((item, i) => items.push({ key: `dateNotes.${i}`, message: `${item.date}: ${item.reason}` }));
  extraction.phases.forEach((phase, p) => phase.uncertaintyNotes.forEach((message, i) => items.push({ key: `phases.${p}.uncertainty.${i}`, message })));
  regulatoryReviewWarnings(extraction).forEach((warning) => items.push({ key: `phases.${warning.phaseIndex}.${warning.code}`, message: warning.message }));
  return items;
}

export function fieldScope(field: string): 'company' | 'trade_object' {
  return ['tradeObjectRevenuePreviousYear', 'paymentLocationHasInternet'].includes(field) ? 'trade_object' : 'company';
}

function suggestedExpression(item: RegulatoryExtraction['phases'][number]['conditions'][number]): ReviewExpression | null {
  // exists in extraction does not establish a boolean fact. Leave it for a reviewer.
  const aliases: Record<string, string> = { date_eq: 'eq', date_before: 'lt', date_after: 'gt' };
  if (!item.fieldHint || ['other', 'exists'].includes(item.operatorHint)) return null;
  const parsed = ReviewPredicateSchema.safeParse({ op: aliases[item.operatorHint] ?? item.operatorHint,
    field: item.fieldHint, value: item.valueHint, scope: fieldScope(item.fieldHint), sourceSegmentIndexes: item.sourceSegmentIndexes });
  return parsed.success ? parsed.data : null;
}

export function createReviewDocument(value: RegulatoryExtraction): ReviewDocument {
  const extraction = validateRegulatoryExtraction(value);
  const base = (originIndex: number, sourceSegmentIndexes: number[]) => ({ id: randomUUID(), originIndex,
    decision: 'unresolved' as const, reason: null, sourceSegmentIndexes: [...sourceSegmentIndexes] });
  const document:ReviewDocument = {
    schemaVersion: REVIEW_VERSION, actId: `review-act-${randomUUID()}`, title: extraction.title,
    sourceReview: { confirmed: false, note: null },
    resolutions: reviewRequirements(extraction).map(({ key }) => ({ key, resolved: false, note: null })),
    phases: extraction.phases.map((phase, originIndex) => {
      const identity = base(originIndex, phase.sourceSegmentIndexes);
      return { ...identity, ruleId: `review-rule-${identity.id}`, version: 1, title: phase.title, userTitle: phase.title,
        summary: extraction.summary, subjectRole: phase.subjectRole, category: null, scope: null,
        validFrom: structuredClone(phase.validFrom), validTo: structuredClone(phase.validTo), endReason: null,
        conditionJoin: null, questionMap: {},
        conditions: phase.conditions.map((item, i) => ({ ...base(i, item.sourceSegmentIndexes), text: item.text, expression: suggestedExpression(item) })),
        exceptions: phase.exceptions.map((item, i) => ({ ...base(i, item.sourceSegmentIndexes), text: item.text, expression: null })),
        actions: phase.actionDrafts.map((item, i) => ({ ...base(i, item.sourceSegmentIndexes), title: item.title, description: item.description, deadline: structuredClone(item.deadline) })),
      };
    }),
  };
  if(extraction.automation) {
    const plan=extraction.automation,catalog=[...(extraction.factCatalog??builtinFactDefinitions()),...plan.factDefinitions];
    const used=new Set(plan.phases.flatMap(p=>p.requiredFacts.map(r=>r.key+':'+r.definitionVersion)));
    document.factDefinitions=structuredClone([...new Map(catalog.filter(d=>used.has(d.key+':'+d.version)).map(d=>[d.key+':'+d.version,d])).values()]);
    document.approvalMode='human';
    for(const phase of document.phases) {
      const suggested=plan.phases.find(p=>p.phaseIndex===phase.originIndex);if(!suggested)continue;
      phase.factRequirements=structuredClone(suggested.requiredFacts);phase.compliance=suggested.compliance?structuredClone(suggested.compliance):undefined;
      phase.scope=suggested.scope;phase.category=suggested.category;phase.conditionJoin=suggested.conditionJoin;phase.endReason=suggested.endReason;
      phase.conditions.forEach((c,i)=>{c.expression=suggested.conditionExpressions[i]??null;});
      phase.exceptions.forEach((c,i)=>{c.expression=suggested.exceptionExpressions[i]??null;});
      for(const r of suggested.requiredFacts)phase.questionMap[r.field]=catalog.find(d=>d.key===r.key&&d.version===r.definitionVersion)?.question??r.field;
      // Suggestions are not approval: include/exclude decisions remain unresolved.
    }
  }
  return document;
}

// Existing identities cannot disappear, be reassigned, or acquire different origins.
// Omission is expressed explicitly by decision=exclude with a reason.
export function assertReviewIdentity(previous: ReviewDocument, next: ReviewDocument) {
  function preserve(before: Array<{ id: string; originIndex: number | null }>, after: typeof before) {
    for (const item of before) {
      const match = after.find((v) => v.id === item.id);
      if (!match || match.originIndex !== item.originIndex) throw new Error('REVIEW_IDENTITY_CHANGED');
    }
    for (const item of after) if (!before.some((v) => v.id === item.id) && item.originIndex !== null) throw new Error('REVIEW_ORIGIN_REASSIGNED');
  }
  preserve(previous.phases, next.phases);
  for (const phase of previous.phases) {
    const after = next.phases.find((p) => p.id === phase.id)!;
    for (const kind of ['conditions', 'exceptions', 'actions'] as const) preserve(phase[kind], after[kind]);
  }
}
