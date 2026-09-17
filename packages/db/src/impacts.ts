import { randomUUID } from 'node:crypto';
import { assessRule, CompanyProfileSchema, LegalRuleSchema, type CompanyProfile, type LegalRule } from '@reg/domain';
import { getPool } from './client.js';
import { getLatestConfirmedProfile, createConfirmedProfileVersion } from './profile.js';
import { scheduleDeadlineRemindersForCompany, scheduleRegulatoryUpdateNotification } from './notifications.js';

export type RecalcReason = 'profile_confirmed' | 'context_answer' | 'regulatory_update' | 'manual';

async function getCurrentRules(): Promise<LegalRule[]> {
  const result = await getPool().query(
    `SELECT DISTINCT ON (rule_id) data
     FROM legal_rules
     WHERE review_status='reviewed' AND legal_status IN ('active','upcoming')
     ORDER BY rule_id, version DESC`,
  );
  return result.rows.map((row) => LegalRuleSchema.parse(row.data));
}

async function getRule(ruleId: string, version: number): Promise<LegalRule | null> {
  const result = await getPool().query('SELECT data FROM legal_rules WHERE rule_id=$1 AND version=$2', [ruleId, version]);
  return result.rowCount ? LegalRuleSchema.parse(result.rows[0].data) : null;
}

async function getPreviousAssessment(companyId: string, ruleId: string) {
  const result = await getPool().query(
    `SELECT * FROM impact_assessments WHERE company_id=$1 AND rule_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [companyId, ruleId],
  );
  return result.rows[0] ?? null;
}

function actionId(impactId: string, actionKey: string) {
  return `${impactId}:${actionKey}`;
}

async function persistOneAssessment(input: {
  companyId: string;
  profile: CompanyProfile;
  rule: LegalRule;
  reason: RecalcReason;
}) {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT id FROM impact_assessments
     WHERE company_id=$1 AND profile_version=$2 AND rule_id=$3 AND rule_version=$4`,
    [input.companyId, input.profile.profileVersion, input.rule.ruleId, input.rule.version],
  );
  if (existing.rowCount) return getImpactById(input.companyId, existing.rows[0].id);

  const previous = await getPreviousAssessment(input.companyId, input.rule.ruleId);
  const evaluation = assessRule({ profile: input.profile, rule: input.rule, now: new Date().toISOString() });
  const impactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (previous?.id) {
      await client.query(
        `UPDATE action_items SET review_required=true
         WHERE impact_id=$1 AND execution_status <> 'completed'`,
        [previous.id],
      );
    }
    await client.query(
      `INSERT INTO impact_assessments(
        id,company_id,profile_version,rule_id,rule_version,verdict,review_state,compliance_state,
        reasons,missing_fields,evidence_refs,review_reasons,effective_from,previous_assessment_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [impactId, input.companyId, input.profile.profileVersion, input.rule.ruleId, input.rule.version,
        evaluation.verdict, evaluation.reviewState, evaluation.complianceState,
        JSON.stringify(evaluation.reasons), JSON.stringify(evaluation.missingFields), JSON.stringify(evaluation.evidenceRefs),
        JSON.stringify(evaluation.reviewReasons), evaluation.effectiveFrom, previous?.id ?? null],
    );
    for (const action of evaluation.actions) {
      await client.query(
        `INSERT INTO action_items(id,impact_id,action_key,title,description,deadline,deadline_kind,execution_status,review_required)
         VALUES($1,$2,$3,$4,$5,$6,$7,'open',false)
         ON CONFLICT (impact_id,action_key) DO NOTHING`,
        [actionId(impactId, action.actionKey), impactId, action.actionKey, action.title, action.description, action.deadline, action.deadlineKind],
      );
    }
    await client.query(
      `INSERT INTO audit_log(company_id,actor_type,event_type,entity_type,entity_id,data)
       VALUES($1,'system',$2,'impact_assessment',$3,$4)`,
      [input.companyId, `impact.${input.reason}`, impactId, JSON.stringify({ ruleId: input.rule.ruleId, ruleVersion: input.rule.version, verdict: evaluation.verdict })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const hydrated = await getImpactById(input.companyId, impactId);
  await scheduleDeadlineRemindersForCompany(input.companyId);
  if (input.reason === 'regulatory_update' && hydrated?.verdict === 'applies' && (!previous || previous.rule_version !== input.rule.version || previous.verdict !== 'applies')) {
    await scheduleRegulatoryUpdateNotification({
      companyId: input.companyId,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.version,
      impactId,
      userTitle: input.rule.userTitle,
    });
  }
  return hydrated;
}

export async function recalculateCompany(companyId: string, reason: RecalcReason = 'manual') {
  const profile = await getLatestConfirmedProfile(companyId);
  if (!profile) return [];
  const rules = await getCurrentRules();
  const results = [];
  for (const rule of rules) results.push(await persistOneAssessment({ companyId, profile, rule, reason }));
  return results;
}

export async function recalculateRuleForAllCompanies(ruleId: string, version: number) {
  const rule = await getRule(ruleId, version);
  if (!rule) throw new Error('RULE_NOT_FOUND');
  const result = await getPool().query(
    `SELECT DISTINCT ON (company_id) company_id, data
     FROM company_profiles ORDER BY company_id, profile_version DESC`,
  );
  const outputs = [];
  for (const row of result.rows) {
    outputs.push(await persistOneAssessment({
      companyId: row.company_id,
      profile: CompanyProfileSchema.parse(row.data),
      rule,
      reason: 'regulatory_update',
    }));
  }
  return outputs;
}

export async function listImpacts(companyId: string) {
  const profile = await getLatestConfirmedProfile(companyId);
  if (!profile) return { profileVersion: null, impacts: [] };
  const rows = await getPool().query(
    `SELECT ia.*, lr.data AS rule_data
     FROM impact_assessments ia
     JOIN legal_rules lr ON lr.rule_id=ia.rule_id AND lr.version=ia.rule_version
     WHERE ia.company_id=$1 AND ia.profile_version=$2
     ORDER BY CASE ia.verdict WHEN 'applies' THEN 0 WHEN 'needs_info' THEN 1 ELSE 2 END,
              ia.created_at DESC`,
    [companyId, profile.profileVersion],
  );
  const impacts = [];
  for (const row of rows.rows) impacts.push(await hydrateImpact(row));
  return { profileVersion: profile.profileVersion, impacts };
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
  const rule = LegalRuleSchema.parse(row.rule_data ?? (await getRule(row.rule_id, row.rule_version)));
  const actions = await getPool().query('SELECT * FROM action_items WHERE impact_id=$1 ORDER BY created_at', [row.id]);
  const missingFields = row.missing_fields ?? [];
  const questions = (missingFields as string[]).map((field) => describeQuestion(
    field,
    rule.applicability.questionMap[field] ?? `Уточните значение: ${field}`,
  ));
  return {
    id: row.id,
    companyId: row.company_id,
    profileVersion: row.profile_version,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    verdict: row.verdict,
    reviewState: row.review_state,
    complianceState: row.compliance_state,
    reasons: row.reasons ?? [],
    missingFields,
    reviewReasons: row.review_reasons ?? [],
    effectiveFrom: row.effective_from ? String(row.effective_from).slice(0, 10) : null,
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
      deadline: action.deadline ? String(action.deadline).slice(0, 10) : null,
      deadlineKind: action.deadline_kind,
      executionStatus: action.execution_status,
      reviewRequired: action.review_required,
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
  if (!current || current.profileVersion !== impact.profileVersion) throw new Error('STALE_IMPACT');
  if (!impact.missingFields.includes(input.field)) throw new Error('FIELD_NOT_REQUESTED');
  const next = await createConfirmedProfileVersion({ companyId: input.companyId, patch: { [input.field]: input.value }, actorId: input.actorId });
  await recalculateCompany(input.companyId, 'context_answer');
  return { profile: next, impacts: await listImpacts(input.companyId) };
}

export async function updateActionStatus(input: { companyId: string; actionId: string; status: 'open'|'in_progress'|'completed'|'dismissed'; actorId?: string }) {
  const result = await getPool().query(
    `UPDATE action_items ai SET execution_status=$3,
       completed_at=CASE WHEN $3='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END
     FROM impact_assessments ia
     WHERE ai.id=$1 AND ai.impact_id=ia.id AND ia.company_id=$2
     RETURNING ai.*`,
    [input.actionId, input.companyId, input.status],
  );
  if (!result.rowCount) return null;
  await getPool().query(
    `INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
     VALUES($1,'user',$2,'action.status','action_item',$3,$4)`,
    [input.companyId, input.actorId ?? null, input.actionId, JSON.stringify({ status: input.status })],
  );
  return result.rows[0];
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
