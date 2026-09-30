import { randomUUID } from 'node:crypto';
import { LegalRuleSchema, FIELD_COPY, VALUE_LABELS, formatValue, plainText, describeRequirement } from '@reg/domain';
import { loadFactObservations } from './facts.js';
import { targetCompanyPage } from './targeting.js';
import { evaluateWithFacts, factQuestion } from './fact-evaluation.js';
import { answerImpactFacts } from './fact-answers.js';
import { getPool } from './client.js';
import { getLatestConfirmedProfile, createConfirmedProfileVersion } from './profile.js';
import { recalculateCompanyAtomic, selectedRules, impactIsCurrent, isoDate } from './runtime.js';

export type RecalcReason = 'profile_confirmed' | 'context_answer' | 'regulatory_update' | 'manual';

export async function recalculateCompany(companyId: string, reason: RecalcReason = 'manual') {
  const ids = await recalculateCompanyAtomic(companyId, reason);
  return Promise.all(ids.map(id => getImpactById(companyId,id)));
}

export async function recalculateRuleForAllCompanies(ruleId: string, version: number) {
  const row=(await getPool().query('SELECT data FROM legal_rules WHERE rule_id=$1 AND version=$2',[ruleId,version])).rows[0];
  if(!row)throw new Error('RULE_NOT_FOUND');
  const rule=LegalRuleSchema.parse(row.data);let cursor:string|null=null;const results=[];
  for(;;) {
    const page=await targetCompanyPage(getPool(),[rule],cursor,500);
    for(const companyId of page.companyIds)results.push(...await recalculateCompanyAtomic(companyId,'regulatory_update',undefined,[ruleId]));
    if(page.companyIds.length<500)break;cursor=page.companyIds.at(-1)!;
  }
  return results;
}

export async function listImpacts(companyId: string, history = false) {
  const profile = await getLatestConfirmedProfile(companyId);
  if (!profile) return { profileVersion: null, impacts: [] };
  const rows = await getPool().query(`SELECT ia.*,lr.data AS rule_data FROM impact_assessments ia
    JOIN legal_rules lr ON lr.rule_id=ia.rule_id AND lr.version=ia.rule_version
    WHERE ia.company_id=$1 ORDER BY ia.created_at DESC,ia.id DESC`,[companyId]);
  const selections=await selectedRules();
  const observations=await loadFactObservations(companyId);
  const now=new Date().toISOString();
  const calculations=new Map(selections.map(s=>[s.rule.ruleId+':'+s.rule.version+':'+s.timeState,evaluateWithFacts(s,profile,observations,companyId,now)]));
  const keys=new Map([...calculations].map(([key,value])=>[key,value.calculationKey]));
  const impacts=[];
  for(const row of rows.rows) {
    const expected=keys.get(row.rule_id+':'+row.rule_version+':'+row.time_state);
    const current=row.profile_version===profile.profileVersion && !!expected && row.calculation_key!=='legacy' && row.calculation_key===expected;
    if(history || current) impacts.push(await hydrateImpact({...row,is_current:current},calculations.get(row.rule_id+':'+row.rule_version+':'+row.time_state)));
  }
  const currentKeys=new Set(rows.rows.filter(row=>row.profile_version===profile.profileVersion&&row.calculation_key!=='legacy'&&row.calculation_key===keys.get(row.rule_id+':'+row.rule_version+':'+row.time_state))
    .map(row=>row.rule_id+':'+row.rule_version+':'+row.time_state));
  const outdated=selections.some(s=>!currentKeys.has(s.rule.ruleId+':'+s.rule.version+':'+s.timeState)&&rows.rows.some(r=>r.rule_id===s.rule.ruleId));
  const jobs=(await getPool().query("SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='failed')::int AS failed FROM company_recalculation_jobs WHERE company_id=$1 AND status<>'processed'",[companyId])).rows[0];
  return {profileVersion:profile.profileVersion,impacts,refreshPending:outdated||jobs.pending>0,refreshFailures:jobs.failed};
}

type QuestionInputType = 'boolean' | 'select' | 'multi_select' | 'number' | 'date' | 'text' | 'string_list';

type QuestionOption = { value: string; label: string };

const QUESTION_META: Record<string, { inputType: QuestionInputType; options?: QuestionOption[]; placeholder?: string }> = {
  legalForm: {
    inputType: 'select',
    options: [
      { value: 'IP', label: 'ИП' },
      { value: 'LLC', label: 'ООО' },
      { value: 'other', label: 'Другое' },
    ],
  },
  taxRegime: {
    inputType: 'select',
    options: [
      { value: 'USN', label: 'УСН' },
      { value: 'OSNO', label: 'ОСНО' },
      { value: 'other', label: 'Другой режим' },
    ],
  },
  receiptIssuer: {
    inputType: 'select',
    options: [
      { value: 'company', label: 'Наша компания' },
      { value: 'marketplace_or_agent', label: 'Маркетплейс или агент' },
      { value: 'other', label: 'Другой участник' },
    ],
  },
  acquiringBankCategoryAsOf2026_01_01: {
    inputType: 'select',
    options: [
      { value: 'systemically_important', label: 'Системно значимый банк' },
      { value: 'significant_payment_market', label: 'Значимый на рынке платёжных услуг' },
      { value: 'universal_license_other', label: 'Другой банк с универсальной лицензией' },
      { value: 'other', label: 'Другая категория' },
    ],
  },
  personalDataLegalBasis: {
    inputType: 'multi_select',
    options: [
      { value: 'consent', label: 'Согласие' },
      { value: 'contract', label: 'Исполнение договора' },
      { value: 'law', label: 'Требование закона' },
      { value: 'legitimate_interest', label: 'Иной допустимый интерес/основание' },
      { value: 'mixed', label: 'Несколько оснований' },
    ],
  },
  productCodes: {
    inputType: 'string_list',
    placeholder: 'Например: 9503 00, 32.40',
  },
  sellerIdentityMissingFields: {
    inputType: 'string_list',
    placeholder: 'Например: ogrn, address',
  },
  registrationDate: { inputType: 'date' },
  incomeAsOf: { inputType: 'date' },
  income2025Usn: { inputType: 'number' },
  incomeYtd2026: { inputType: 'number' },
  revenuePreviousYear: { inputType: 'number' },
  tradeObjectRevenuePreviousYear: { inputType: 'number' },
  hasCombinedTaxRegimes: { inputType: 'boolean' },
  sellsToConsumers: { inputType: 'boolean' },
  distanceSales: { inputType: 'boolean' },
  onlinePayment: { inputType: 'boolean' },
  usesKkt: { inputType: 'boolean' },
  internetSettlement: { inputType: 'boolean' },
  isExcludedProduct: { inputType: 'boolean' },
  isTurnoverParticipant: { inputType: 'boolean' },
  hasResidualStock: { inputType: 'boolean' },
  residualStockInRfOn2025_12_01: { inputType: 'boolean' },
  residualStockProducedOrImportedBefore2025_12_01: { inputType: 'boolean' },
  collectsPersonalData: { inputType: 'boolean' },
  usesConsent: { inputType: 'boolean' },
  consentSeparate: { inputType: 'boolean' },
  sellsViaOwnSite: { inputType: 'boolean' },
  sellsViaAggregator: { inputType: 'boolean' },
  sellerIdentityInfoChecked: { inputType: 'boolean' },
  hasEpaymentAcceptanceAgreementAsOf2026_01_01: { inputType: 'boolean' },
  paymentLocationHasInternet: { inputType: 'boolean' },
};

const QUESTION_TEXT: Record<string, string> = {
  tradeObjectId: 'Укажите обозначение конкретной торговой точки. Данные выручки и доступности интернета должны относиться к ней.',
  hasCombinedTaxRegimes: 'Совмещает ли компания УСН с другим налоговым режимом?',
  consentSeparate: 'Оформлено ли согласие на обработку персональных данных отдельно от других подтверждаемых документов?',
  sellerIdentityInfoChecked: 'Вы уже проверяли наличие обязательных сведений о продавце на сайте или в приложении?',
  sellerIdentityMissingFields: 'Каких обязательных сведений о продавце не хватает? Если всё размещено, оставьте список пустым.',
  productCodes: 'Укажите коды ТН ВЭД ЕАЭС или ОКПД2 для проверяемых товаров.',
  personalDataLegalBasis: 'Какие правовые основания обработки персональных данных используются в этом процессе?',
  registrationDate: 'Когда зарегистрированы ИП или организация?',
  incomeAsOf: 'На какую дату рассчитан доход с начала года?',
  income2025Usn: 'Какой доход по правилам УСН был за 2025 год?',
  incomeYtd2026: 'Какой доход по правилам УСН накоплен с начала 2026 года?',
  revenuePreviousYear: 'Какова выручка от реализации за предыдущий календарный год?',
  tradeObjectRevenuePreviousYear: 'Какова выручка конкретного торгового объекта за предыдущий календарный год?',
};

function describeQuestion(field: string, text: string) {
  const meta = QUESTION_META[field] ?? { inputType: 'text' as const };
  const copy=FIELD_COPY[field];
  return { field, text:copy?.question??plainText(text,'Уточните данные для этой проверки'),
    hint:copy?.hint, ...meta, placeholder:copy?.placeholder??meta.placeholder };
}

async function hydrateImpact(row: Record<string, any>,calculated?:ReturnType<typeof evaluateWithFacts>) {
  const rule = LegalRuleSchema.parse(row.rule_data);
  const current = row.is_current ?? await impactIsCurrent(row);
  const actions = await getPool().query('SELECT * FROM action_items WHERE impact_id=$1 ORDER BY created_at', [row.id]);
  const missingFields = row.missing_fields ?? [];
  let explanation: { facts: Array<{label:string;value:string;status:string}>; requirement:string } = {
    facts:[], requirement:'Условия приведены в официальном источнике.'
  };
  let questions: any[] = (missingFields as string[]).map((field) => describeQuestion(
    field,
    rule.applicability.questionMap[field] ?? `Уточните значение: ${field}`,
  ));
  let editableQuestions:any[]=[];
  if (current) {
    const selected=calculated?undefined:(await selectedRules()).find(s=>s.rule.ruleId===row.rule_id&&s.rule.version===row.rule_version&&s.timeState===row.time_state);
    const profile=calculated?null:await getLatestConfirmedProfile(row.company_id);
    if(calculated||selected&&profile) {
      const evaluated=calculated??evaluateWithFacts(selected!,profile!,await loadFactObservations(row.company_id),row.company_id,new Date().toISOString());
      const fields=evaluated.resolutions.map(r=>({
        field:r.requirement.field,title:(r.definition.legacyField?FIELD_COPY[r.definition.legacyField]?.title:undefined)??plainText(r.definition.title,'Дополнительные данные'),
        options:r.definition.options.map(o=>({...o,label:VALUE_LABELS[o.value]??o.label})),unit:r.definition.unit
      }));
      editableQuestions=evaluated.resolutions.filter(r=>r.status==='fresh'&&
        (r.definition.scope==='company'||!!profile?.tradeObjectId||!!calculated)).map(factQuestion);
      explanation={
        facts:evaluated.resolutions.map((r,index)=>({
          label:fields[index]!.title,status:r.status,
          value:r.status==='fresh'?formatValue(r.observation?.value,fields[index]!.options,r.definition.unit):
            r.status==='stale'?'Нужно подтвердить актуальность':'Нужно уточнить',
        })),
        requirement:describeRequirement(rule.applicability.condition,fields)
      };
      questions=(missingFields as string[]).map(field=>{
        const r=evaluated.resolutions.find(r=>r.requirement.field===field);
        return r?factQuestion(r):describeQuestion(field,rule.applicability.questionMap[field]??field);
      });
    }
  }
  return {
    id: row.id,
    companyId: row.company_id,
    isCurrent: current,
    timeState: row.time_state,
    profileVersion: row.profile_version,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    verdict: row.verdict,
    reviewState: row.review_state,
    complianceState: row.compliance_state,
    clarificationState: row.clarification_state ?? null,
    calculationKey: row.calculation_key,
    factContext: row.fact_context,
    reasons: row.reasons ?? [],
    explanation,
    missingFields,
    reviewReasons: row.review_reasons ?? [],
    effectiveFrom: row.effective_from ? isoDate(row.effective_from) : null,
    previousAssessmentId: row.previous_assessment_id,
    createdAt: row.created_at,
    rule: {
      userTitle: rule.userTitle,
      summary: rule.summary,
      category: rule.category,
      legalStatus: rule.legalStatus,
      validFrom: rule.validFrom,
      checkedAt: rule.checkedAt,
      evidenceRefs: rule.evidenceRefs,
      approvalMode: rule.factModel?.approvalMode ?? 'human',
    },
    questions,
    editableQuestions,
    actions: actions.rows.map((action) => ({
      id: action.id,
      actionKey: action.action_key,
      title: action.title,
      description: action.description,
      deadline: action.deadline ? isoDate(action.deadline) : null,
      deadlineKind: action.deadline_kind,
      executionStatus: action.execution_status,
      reviewRequired: action.review_required || !current,
      reviewReason: action.review_reason,
      carriedFromActionId: action.carried_from_action_id,
      completedAt: action.completed_at,
    })),
  };
}

export async function getImpactById(companyId: string, impactId: string) {
  const result = await getPool().query(
    `SELECT ia.*, lr.data AS rule_data FROM impact_assessments ia
     JOIN legal_rules lr ON lr.rule_id=ia.rule_id AND lr.version=ia.rule_version
     WHERE ia.id=$1 AND ia.company_id=$2`,
    [impactId, companyId],
  );
  return result.rowCount ? hydrateImpact(result.rows[0]) : null;
}

export async function answerImpactQuestion(input: {
  companyId: string;
  impactId: string;
  field: string;
  value: unknown;
  actorId?: string;
}) {
  const result=await answerImpactFacts(input.companyId,input.impactId,{requestId:randomUUID(),answers:[{field:input.field,value:input.value}]},input.actorId??'user');
  return {...result,profile:await getLatestConfirmedProfile(input.companyId),impacts:await listImpacts(input.companyId)};
}

export { updateActionStatus } from './actions.js';

export async function addImpactFeedback(input: { companyId: string; impactId: string; value: string; comment?: string; actorId?: string }) {
  const impact = await getImpactById(input.companyId, input.impactId);
  if (!impact) return null;
  const result = await getPool().query(
    `INSERT INTO impact_feedback(impact_id,company_id,value,comment) VALUES($1,$2,$3,$4) RETURNING *`,
    [input.impactId, input.companyId, input.value, input.comment ?? null],
  );
  await getPool().query(
    `INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
     VALUES($1,'user',$2,'impact.feedback','impact_assessment',$3,$4)`,
    [input.companyId, input.actorId ?? null, input.impactId, JSON.stringify({ value: input.value, comment: input.comment ?? null })],
  );
  return result.rows[0];
}

export async function listAudit(companyId: string, limit = 100) {
  const result = await getPool().query(
    'SELECT * FROM audit_log WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2',
    [companyId, limit],
  );
  return result.rows;
}

/** IDs are immutable and monotonic; new events cannot shift subsequent pages. */
export async function listAuditPage(companyId:string,options:{beforeId?:string;limit?:number}={}) {
  const limit=Math.min(100,Math.max(1,options.limit??50));
  const rows=(await getPool().query(`SELECT * FROM audit_log WHERE company_id=$1
    AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT $3`,
    [companyId,options.beforeId??null,limit+1])).rows;
  const items=rows.slice(0,limit);
  return {items,nextCursor:rows.length>limit?String(items.at(-1)!.id):null};
}
