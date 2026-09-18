import { randomUUID } from 'node:crypto';
import { LegalRuleSchema } from '@reg/domain';
import { getPool } from './client.js';
import { getLatestConfirmedProfile, createConfirmedProfileVersion } from './profile.js';
import { recalculateCompanyAtomic, selectedRules, impactIsCurrent, isoDate } from './runtime.js';

export type RecalcReason = 'profile_confirmed' | 'context_answer' | 'regulatory_update' | 'manual';

export async function recalculateCompany(companyId: string, reason: RecalcReason = 'manual') {
  const ids = await recalculateCompanyAtomic(companyId, reason);
  return Promise.all(ids.map(id => getImpactById(companyId,id)));
}

export async function recalculateRuleForAllCompanies(ruleId: string, version: number) {
  const rule = await getPool().query('SELECT 1 FROM legal_rules WHERE rule_id=$1 AND version=$2',[ruleId,version]);
  if (!rule.rowCount) throw new Error('RULE_NOT_FOUND');
  const companies = await getPool().query('SELECT DISTINCT company_id FROM company_profiles');
  const results=[];
  for(const row of companies.rows) results.push(...await recalculateCompany(row.company_id,'regulatory_update'));
  return results;
}

export async function listImpacts(companyId: string, history = false) {
  const profile = await getLatestConfirmedProfile(companyId);
  if (!profile) return { profileVersion: null, impacts: [] };
  const rows = await getPool().query(`SELECT ia.*,lr.data AS rule_data FROM impact_assessments ia
    JOIN legal_rules lr ON lr.rule_id=ia.rule_id AND lr.version=ia.rule_version
    WHERE ia.company_id=$1 ORDER BY ia.created_at DESC,ia.id DESC`,[companyId]);
  const selections=await selectedRules();
  const impacts=[];
  for(const row of rows.rows) {
    const current=row.profile_version===profile.profileVersion && selections.some(s=>s.rule.ruleId===row.rule_id && s.rule.version===row.rule_version && s.timeState===row.time_state);
    if(history || current) impacts.push(await hydrateImpact({...row,is_current:current}));
  }
  return {profileVersion:profile.profileVersion,impacts};
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
  return { field, text: text.startsWith('Уточните значение:') ? (QUESTION_TEXT[field] ?? text) : text, ...meta };
}

async function hydrateImpact(row: Record<string, any>) {
  const rule = LegalRuleSchema.parse(row.rule_data);
  const current = row.is_current ?? await impactIsCurrent(row);
  const actions = await getPool().query('SELECT * FROM action_items WHERE impact_id=$1 ORDER BY created_at', [row.id]);
  const missingFields = row.missing_fields ?? [];
  const questions = (missingFields as string[]).map((field) => describeQuestion(
    field,
    rule.applicability.questionMap[field] ?? `Уточните значение: ${field}`,
  ));
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
    reasons: row.reasons ?? [],
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
    },
    questions,
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
  const impact = await getImpactById(input.companyId, input.impactId);
  if (!impact) throw new Error('IMPACT_NOT_FOUND');
  const current = await getLatestConfirmedProfile(input.companyId);
  if (!impact.isCurrent || !current || current.profileVersion !== impact.profileVersion) throw new Error('STALE_IMPACT');
  if (!impact.missingFields.includes(input.field)) throw new Error('FIELD_NOT_REQUESTED');
  const next = await createConfirmedProfileVersion({ companyId: input.companyId, patch: { [input.field]: input.value }, actorId: input.actorId });
  await recalculateCompany(input.companyId, 'context_answer');
  return { profile: next, impacts: await listImpacts(input.companyId) };
}

export async function updateActionStatus(input: { companyId: string; actionId: string; status: 'open'|'in_progress'|'completed'|'dismissed'; actorId?: string }) {
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[input.companyId]);
    const row=(await db.query(`SELECT i.*,a.execution_status FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id
      WHERE a.id=$1 AND i.company_id=$2`,[input.actionId,input.companyId])).rows[0];
    if(!row){await db.query('COMMIT');return null;}
    if(!await impactIsCurrent(row,db) || row.time_state!=='active') throw new Error('STALE_ACTION');
    const result=await db.query(`UPDATE action_items SET execution_status=$2,
      completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,now()) ELSE NULL END WHERE id=$1 RETURNING *`,[input.actionId,input.status]);
    await db.query(`INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES($1,'user',$2,'action.status','action_item',$3,$4)`,[input.companyId,input.actorId??null,input.actionId,JSON.stringify({status:input.status})]);
    if(['completed','dismissed'].includes(input.status)) await db.query(`UPDATE notifications SET state='cancelled',terminal_at=now()
      WHERE company_id=$1 AND payload->>'actionId'=$2 AND state IN ('pending','retry')`,[input.companyId,input.actionId]);
    else await db.query(`UPDATE notifications SET state='pending',terminal_at=NULL
      WHERE company_id=$1 AND payload->>'actionId'=$2 AND state='cancelled' AND sent_at IS NULL`,
    [input.companyId,input.actionId]);
    await db.query('COMMIT');return result.rows[0];
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

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
