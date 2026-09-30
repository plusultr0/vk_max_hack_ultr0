import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CompanyProfileSchema, LegalRuleSchema, requirementProblems, conditionFields, type FactDefinition, type Condition, type LegalRule } from '@reg/domain';
import { datesInText, isCalendarDate, validateRegulatoryExtraction, type RegulatoryExtraction } from '@reg/llm';
import { fieldScope, reviewRequirements } from './draft.js';
import { parseReviewDocument, type ReviewExpression, type ReviewIssue } from './schema.js';

export const COMPILER_VERSION = 'review-compiler-v1';
export function reviewHash(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, normalize(child)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export type CompiledReviewRule = {
  phaseId: string; originIndex: number | null; scope: 'company' | 'trade_object';
  temporalPolicy: 'start-inclusive-end-exclusive';
  rule: LegalRule;
  evidence: Array<{ id: string; sourceSegmentIndex: number; quote: string }>;
};
export type ReviewCompilation = {
  compilerVersion: string; contentHash: string; sourceTextHash: string;
  issues: ReviewIssue[]; rules: CompiledReviewRule[]; ready: boolean;
};

export function compileReview(value: unknown, rawExtraction: RegulatoryExtraction, checkedAt: string): ReviewCompilation {
  if (!isCalendarDate(checkedAt)) throw new Error('INVALID_CHECKED_AT');
  const extraction = validateRegulatoryExtraction(rawExtraction);
  const doc = parseReviewDocument(value);
  const issues: ReviewIssue[] = [];
  const output: CompiledReviewRule[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const ids = new Set<string>();
  const ruleIds = new Set<string>();
  function identity(items: Array<{ id: string; originIndex: number | null }>, count: number, path: string) {
    for (const item of items) {
      if (ids.has(item.id)) add('DUPLICATE_ID', path, 'Идентификатор повторяется.');
      ids.add(item.id);
      if (item.originIndex !== null && item.originIndex >= count) add('INVALID_ORIGIN', path, 'Исходный элемент не существует.');
    }
    for (let i = 0; i < count; i++) if (items.filter((item) => item.originIndex === i).length !== 1) {
      add('SOURCE_ITEM_COVERAGE', path, `Исходный элемент ${i} должен иметь ровно одно решение.`);
    }
  }
  const decision = (item: { decision: string; reason: string | null }, path: string) => {
    if (item.decision === 'unresolved') add('UNRESOLVED_DECISION', path, 'Нужно явное решение проверяющего.');
    if (!item.reason) add('REVIEW_REASON_REQUIRED', path, 'Укажите основание решения.');
    return item.decision === 'include';
  };
  if (!doc.sourceReview.confirmed || !doc.sourceReview.note) add('SOURCE_REVIEW_REQUIRED', 'sourceReview', 'Подтвердите проверку полноты документа и правового основания.');
  const required = reviewRequirements(extraction);
  for (const req of required) {
    const found = doc.resolutions.filter((r) => r.key === req.key);
    if (found.length !== 1 || !found[0]!.resolved || !found[0]!.note) add('SOURCE_ISSUE_UNRESOLVED', `resolutions.${req.key}`, req.message);
  }
  if (doc.resolutions.some((item) => !required.some((r) => r.key === item.key))) add('UNKNOWN_RESOLUTION', 'resolutions', 'Неизвестный пункт проверки.');
  identity(doc.phases, extraction.phases.length, 'phases');
  doc.phases.forEach((phase, p) => {
    const path = `phases.${p}`;
    const sourcePhase = phase.originIndex === null ? null : extraction.phases[phase.originIndex];
    for (const kind of ['conditions', 'exceptions', 'actions'] as const) identity(phase[kind],
      (kind === 'actions' ? sourcePhase?.actionDrafts.length : sourcePhase?.[kind].length) ?? 0, `${path}.${kind}`);
    if (!decision(phase, path)) return;
    if (ruleIds.has(phase.ruleId)) add('DUPLICATE_RULE_ID', `${path}.ruleId`, 'Одновременные этапы должны иметь разные ruleId.');
    ruleIds.add(phase.ruleId);
    if (!phase.category || !phase.subjectRole || !phase.scope) add('RULE_METADATA_REQUIRED', path, 'Укажите категорию, субъект и область применения.');
    const usedRefs = new Set<number>();
    function cite(indexes: number[], at: string) {
      if (!indexes.length) add('EVIDENCE_REQUIRED', at, 'Требуется ссылка на исходный сегмент.');
      if (new Set(indexes).size !== indexes.length) add('DUPLICATE_REFERENCE', at, 'Ссылка на сегмент повторяется.');
      const ordered = [...new Set(indexes)].sort((a, b) => a - b);
      return ordered.map((index, i) => {
        const segment = extraction.sourceSnapshot.segments[index];
        if (!segment || !segment.text.trim()) { add('INVALID_REFERENCE', at, `Нет непустого сегмента ${index}.`); return ''; }
        usedRefs.add(index);
        return (i > 0 && ordered[i - 1] !== index - 1 ? '\n[uncited]\n' : '') + segment.text;
      }).join('');
    }
    const dateEvidence = (date: string, indexes: number[], at: string) => {
      if (!datesInText(cite(indexes, at)).includes(date)) add('DATE_NOT_IN_EVIDENCE', at, 'Дата отсутствует в указанных сегментах.');
    };
    cite(phase.sourceSegmentIndexes, path);
    if (!phase.validFrom.date) add('VALID_FROM_REQUIRED', `${path}.validFrom`, 'Начало действия должно быть определено.');
    else dateEvidence(phase.validFrom.date, phase.validFrom.sourceSegmentIndexes, `${path}.validFrom`);
    if (phase.validTo.date) {
      dateEvidence(phase.validTo.date, phase.validTo.sourceSegmentIndexes, `${path}.validTo`);
      if (phase.validFrom.date && phase.validTo.date <= phase.validFrom.date) add('INVALID_INTERVAL', path, 'Конец исключённого интервала должен быть позже начала.');
    } else if (phase.validTo.sourceSegmentIndexes.length) add('NULL_DATE_WITH_REFERENCES', `${path}.validTo`, 'Для отсутствующей даты ссылки должны быть пустыми.');
    if (!phase.endReason) add('END_REASON_REQUIRED', `${path}.endReason`, 'Объясните основание окончания или отсутствие установленной даты окончания.');
    const usedFields = new Set<string>();
    function expression(input: ReviewExpression, at: string): Condition | null {
      if ('conditions' in input) {
        const children = input.conditions.map((v, i) => expression(v, `${at}.${i}`));
        return children.every((v) => v !== null) ? { op: input.op, conditions: children as Condition[] } : null;
      }
      if ('condition' in input) { const child = expression(input.condition, `${at}.not`); return child ? { op: 'not', condition: child } : null; }
      cite(input.sourceSegmentIndexes, at);
      const shape = CompanyProfileSchema.shape as Record<string, z.ZodTypeAny>;
      const binding=phase.factRequirements?.find(r=>r.field===input.field);
      const definition=binding&&doc.factDefinitions?.find(d=>d.key===binding.key&&d.version===binding.definitionVersion);
      const sourceField = definition ? factValueSchema(definition) : Object.hasOwn(shape, input.field) ? shape[input.field] : undefined;
      if (!sourceField || ['profileVersion', 'confirmedAt'].includes(input.field)) { add('UNKNOWN_FIELD', at, 'Нет поддерживаемого поля профиля.'); return null; }
      let field: z.ZodTypeAny = sourceField;
      while (field instanceof z.ZodOptional || field instanceof z.ZodNullable) field = field.unwrap();
      if (input.scope !== (definition?.scope ?? fieldScope(input.field)) || (input.scope === 'trade_object' && phase.scope !== 'trade_object')) {
        add('SCOPE_MISMATCH', at, 'Условие торговой точки нельзя применять как освобождение всей компании.'); return null;
      }
      usedFields.add(input.field);
      const isArray = field instanceof z.ZodArray;
      const isDate = definition?.type==='date' || ['registrationDate', 'incomeAsOf'].includes(input.field);
      const validScalar = (v: unknown) => !isArray && field!.safeParse(v).success && v !== null && (!isDate || typeof v === 'string' && isCalendarDate(v));
      const invalid = () => { add('INVALID_OPERATOR_VALUE', at, 'Оператор или значение не соответствует типу поля.'); return null; };
      const op = input.op;
      const value = input.value;
      if (op === 'known' || op === 'is_empty') {
        if (value !== null || op === 'is_empty' && !(isArray || field instanceof z.ZodString) || isDate && op === 'is_empty') return invalid();
        return { op, field: input.field };
      }
      if (op === 'contains_any' || op === 'contains_all') {
        if (!isArray || !Array.isArray(value) || !field.safeParse(value).success) return invalid();
        return { op, field: input.field, values: value };
      }
      if (op === 'in') {
        if (!Array.isArray(value) || !value.every(validScalar)) return invalid();
        if (isDate) for (const date of value) dateEvidence(String(date), input.sourceSegmentIndexes, at);
        return { op, field: input.field, values: value };
      }
      if (!validScalar(value)) return invalid();
      if (isDate) dateEvidence(String(value), input.sourceSegmentIndexes, at);
      if (op === 'eq' || op === 'neq') return { op, field: input.field, value };
      if (!(field instanceof z.ZodNumber || isDate) || !(typeof value === 'number' || typeof value === 'string')) return invalid();
      return { op, field: input.field, value };
    }
    function conditions(items: typeof phase.conditions, kind: string) {
      const compiled: Condition[] = [];
      items.forEach((item, i) => {
        const at = `${path}.${kind}.${i}`;
        if (!decision(item, at)) return;
        cite(item.sourceSegmentIndexes, at);
        if (!item.expression) { add('EXPRESSION_REQUIRED', at, 'Сформулируйте машинное условие.'); return; }
        const result = expression(item.expression, at);
        if (result) compiled.push(result);
      });
      return compiled;
    }
    const included = conditions(phase.conditions, 'conditions');
    const except = conditions(phase.exceptions, 'exceptions');
    if (!included.length) add('APPLICABILITY_REQUIRED', path, 'Нужна хотя бы одна формализованная группа применимости.');
    if (!phase.conditionJoin) add('CONDITION_JOIN_REQUIRED', path, 'Явно выберите AND/OR между группами условий.');
    const base: Condition = { op: phase.conditionJoin ?? 'and', conditions: included };
    const applicability: Condition = except.length ? { op: 'and', conditions: [base, { op: 'not', condition: { op: 'or', conditions: except } }] } : base;
    const complianceFields=new Set<string>();
    const compliantWhen=phase.compliance?.compliantWhen?expression(phase.compliance.compliantWhen,path+'.compliance.compliantWhen'):null;
    const actionRequiredWhen=phase.compliance?.actionRequiredWhen?expression(phase.compliance.actionRequiredWhen,path+'.compliance.actionRequiredWhen'):null;
    for(const f of [...conditionFields(compliantWhen),...conditionFields(actionRequiredWhen)])complianceFields.add(f);
    if(phase.factRequirements) {
      for(const problem of requirementProblems(phase.factRequirements,doc.factDefinitions??[]))add('FACT_BINDING_INVALID',path,problem);
      for(const f of usedFields)if(!phase.factRequirements.some(r=>r.field===f))add('FACT_REQUIREMENT_MISSING',path,f);
      for(const r of phase.factRequirements)if(!usedFields.has(r.field))add('UNUSED_FACT_REQUIREMENT',path,r.field);
    } else if([...usedFields].some(f=>f.startsWith('facts.')))add('FACT_REQUIREMENTS_REQUIRED',path,'Dynamic fields need versioned definitions and bindings.');
    const actions: LegalRule['actions'] = [];
    phase.actions.forEach((action, i) => {
      const at = `${path}.actions.${i}`;
      if (!decision(action, at)) return;
      cite(action.sourceSegmentIndexes, at);
      const d = action.deadline;
      let deadline: LegalRule['actions'][number]['deadline'];
      if (d.kind === 'fixed') { dateEvidence(d.date, d.sourceSegmentIndexes, `${at}.deadline`); deadline = { type: 'fixed', value: d.date }; }
      else if (d.kind === 'phase_start') {
        // This DSL operator currently yields effectiveFrom itself; keep the origin explicit in review.
        deadline = { type: 'before_effective_from' };
      } else if (d.kind === 'none') deadline = { type: 'none' };
      else { add('UNSUPPORTED_DEADLINE', `${at}.deadline`, 'Неизвестный/относительный срок нельзя автоматически подменять датой этапа.'); return; }
      actions.push({ actionKey: action.id, title: action.title, description: action.description, when: null, deadline });
    });
    for (const field of usedFields) if (!Object.hasOwn(phase.questionMap, field)) add('QUESTION_REQUIRED', `${path}.questionMap.${field}`, 'Нужен вопрос для случая отсутствующих данных.');
    for (const field of Object.keys(phase.questionMap)) if (!usedFields.has(field)) add('UNUSED_QUESTION', `${path}.questionMap.${field}`, 'Вопрос не связан с исполняемым условием.');
    if (issues.length) return;
    const evidence = [...usedRefs].sort((a, b) => a - b).map((index) => ({ id: `${phase.id}:segment:${index}`, sourceSegmentIndex: index, quote: extraction.sourceSnapshot.segments[index]!.text }));
    const rawRule = {
      ruleId: phase.ruleId, version: phase.version, actId: doc.actId, category: phase.category,
      title: phase.title, userTitle: phase.userTitle, summary: phase.summary, subjectRole: phase.subjectRole,
      legalStatus: phase.validTo.date && checkedAt >= phase.validTo.date ? 'expired' : phase.validFrom.date! > checkedAt ? 'upcoming' : 'active',
      reviewStatus: 'needs_review', validFrom: phase.validFrom.date, validTo: phase.validTo.date, checkedAt,
      applicability: { condition: applicability, requiredFields: [...usedFields].sort(), questionMap: phase.questionMap },
      manualReviewGates: [], compliance: { mode: compliantWhen||actionRequiredWhen ? 'condition' : 'not_assessed', compliantWhen, actionRequiredWhen, requiredFields: [...complianceFields] },
      effectiveFrom: { type: 'rule_valid_from' }, actions,
      evidenceRefs: evidence.map((e) => ({ id: e.id, url: extraction.sourceSnapshot.officialUrl, label: `Сегмент ${e.sourceSegmentIndex}`, note: e.quote })),
      tags: ['review-preview', `scope:${phase.scope}`],
      ...(phase.factRequirements ? {factModel:{schemaVersion:'facts-v1',definitions:doc.factDefinitions??[],requiredFacts:phase.factRequirements,approvalMode:doc.approvalMode??'human'}} : {}),
    };
    output.push({ phaseId: phase.id, originIndex: phase.originIndex, scope: phase.scope!, temporalPolicy: 'start-inclusive-end-exclusive',
      rule: LegalRuleSchema.parse({ ...rawRule, seedHash: reviewHash(rawRule) }), evidence });
  });
  if (!doc.phases.some((p) => p.decision === 'include')) add('NO_INCLUDED_PHASES', 'phases', 'Для готового пакета нужен хотя бы один включённый этап.');
  return { compilerVersion: COMPILER_VERSION, contentHash: reviewHash(doc), sourceTextHash: extraction.sourceSnapshot.textHash,
    ready: issues.length === 0, issues, rules: issues.length ? [] : output };
}

function factValueSchema(d:FactDefinition):z.ZodTypeAny {
  switch(d.type) {
    case 'boolean':return z.boolean();
    case 'number':{let s=z.number().finite();if(d.min!==null)s=s.min(d.min);if(d.max!==null)s=s.max(d.max);return s;}
    case 'date':return z.string();
    case 'text':return z.string().max(2000);
    case 'string_list':return z.array(z.string().max(200)).max(100);
    case 'enum':return z.enum(d.options.map(o=>o.value) as [string,...string[]]);
    case 'multi_enum':return z.array(z.enum(d.options.map(o=>o.value) as [string,...string[]])).max(100);
  }
}
