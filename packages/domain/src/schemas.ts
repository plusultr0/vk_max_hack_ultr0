import { z } from 'zod';
import { FactRuleMetadataSchema } from './fact-schema.js';
import { INDUSTRY_VALUES, REQUIRED_PROFILE_FIELDS } from './profile-ui.js';

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DateTimeStringSchema = z.string().datetime();

export const VerdictSchema = z.enum(['applies', 'not_applicable', 'needs_info']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ReviewStateSchema = z.enum(['auto', 'reviewed', 'needs_review']);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ComplianceStateSchema = z.enum([
  'unknown',
  'compliant',
  'action_required',
  'not_assessed',
]);
export type ComplianceState = z.infer<typeof ComplianceStateSchema>;

export const ExecutionStatusSchema = z.enum([
  'open',
  'in_progress',
  'completed',
  'dismissed',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const CompanyProfileSchema = z.object({
  profileVersion: z.number().int().positive(),
  tradeObjectId: z.string().trim().min(1).max(200).nullable().optional(),
  legalForm: z.enum(['IP', 'LLC', 'other']).nullable().optional(),
  industry: z.enum(INDUSTRY_VALUES).nullable().optional(),
  registrationDate: DateStringSchema.nullable().optional(),
  region: z.string().nullable().optional(),
  taxRegime: z.enum(['USN', 'OSNO', 'other']).nullable().optional(),
  hasCombinedTaxRegimes: z.boolean().nullable().optional(),
  sellsToConsumers: z.boolean().nullable().optional(),
  salesChannels: z.array(z.enum([
    'own_site',
    'marketplace',
    'social',
    'messenger',
    'offline',
    'other',
  ])).nullable().optional(),
  distanceSales: z.boolean().nullable().optional(),
  onlinePayment: z.boolean().nullable().optional(),
  usesKkt: z.boolean().nullable().optional(),
  internetSettlement: z.boolean().nullable().optional(),
  receiptIssuer: z.enum(['company', 'marketplace_or_agent', 'other']).nullable().optional(),
  productGroups: z.array(z.string()).nullable().optional(),
  productCodes: z.array(z.string()).nullable().optional(),
  isExcludedProduct: z.boolean().nullable().optional(),
  isTurnoverParticipant: z.boolean().nullable().optional(),
  hasResidualStock: z.boolean().nullable().optional(),
  residualStockInRfOn2025_12_01: z.boolean().nullable().optional(),
  residualStockProducedOrImportedBefore2025_12_01: z.boolean().nullable().optional(),
  collectsPersonalData: z.boolean().nullable().optional(),
  processingContexts: z.array(z.enum(['order', 'callback', 'newsletter', 'account', 'other'])).nullable().optional(),
  personalDataLegalBasis: z.array(z.enum(['consent', 'contract', 'law', 'legitimate_interest', 'mixed'])).nullable().optional(),
  usesConsent: z.boolean().nullable().optional(),
  consentSeparate: z.boolean().nullable().optional(),
  hasLoyaltyProgram: z.boolean().nullable().optional(),
  sellsViaOwnSite: z.boolean().nullable().optional(),
  sellsViaAggregator: z.boolean().nullable().optional(),
  sellerIdentityInfoChecked: z.boolean().nullable().optional(),
  sellerIdentityMissingFields: z.array(z.string()).nullable().optional(),
  income2025Usn: z.number().nonnegative().nullable().optional(),
  incomeYtd2026: z.number().nonnegative().nullable().optional(),
  incomeAsOf: DateStringSchema.nullable().optional(),
  revenuePreviousYear: z.number().nonnegative().nullable().optional(),
  hasEpaymentAcceptanceAgreementAsOf2026_01_01: z.boolean().nullable().optional(),
  acquiringBankCategoryAsOf2026_01_01: z.enum([
    'systemically_important',
    'significant_payment_market',
    'universal_license_other',
    'other',
  ]).nullable().optional(),
  tradeObjectRevenuePreviousYear: z.number().nonnegative().nullable().optional(),
  paymentLocationHasInternet: z.boolean().nullable().optional(),
  confirmedAt: DateTimeStringSchema.nullable().optional(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const DemoProfileFixtureSchema = CompanyProfileSchema.extend({
  fixtureId: z.string(),
});
export type DemoProfileFixture = z.infer<typeof DemoProfileFixtureSchema>;

export const BASIC_ONBOARDING_FIELDS = REQUIRED_PROFILE_FIELDS;

export const CompanyProfileDraftSchema = z.object({
  data: CompanyProfileSchema.omit({ profileVersion: true, confirmedAt: true }).partial(),
  answeredFields: z.array(z.string()).default([]),
  baseProfileVersion: z.number().int().nonnegative().default(0),
  updatedAt: DateTimeStringSchema.optional(),
});
export type CompanyProfileDraft = z.infer<typeof CompanyProfileDraftSchema>;


export type Condition =
  | { op: 'eq'; field: string; value: unknown }
  | { op: 'neq'; field: string; value: unknown }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: number | string }
  | { op: 'in'; field: string; values: unknown[] }
  | { op: 'contains_any' | 'contains_all'; field: string; values: unknown[] }
  | { op: 'exists' | 'known' | 'is_empty'; field: string }
  | { op: 'and' | 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

const ConditionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown())]);
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ op: z.literal('eq'), field: z.string(), value: ConditionValueSchema }),
  z.object({ op: z.literal('neq'), field: z.string(), value: ConditionValueSchema }),
  z.object({ op: z.literal('gt'), field: z.string(), value: z.union([z.number(), z.string()]) }),
  z.object({ op: z.literal('gte'), field: z.string(), value: z.union([z.number(), z.string()]) }),
  z.object({ op: z.literal('lt'), field: z.string(), value: z.union([z.number(), z.string()]) }),
  z.object({ op: z.literal('lte'), field: z.string(), value: z.union([z.number(), z.string()]) }),
  z.object({ op: z.literal('in'), field: z.string(), values: z.array(z.any()) }),
  z.object({ op: z.literal('contains_any'), field: z.string(), values: z.array(z.any()) }),
  z.object({ op: z.literal('contains_all'), field: z.string(), values: z.array(z.any()) }),
  z.object({ op: z.literal('exists'), field: z.string() }),
  z.object({ op: z.literal('known'), field: z.string() }),
  z.object({ op: z.literal('is_empty'), field: z.string() }),
  z.object({ op: z.literal('and'), conditions: z.array(ConditionSchema).min(1) }),
  z.object({ op: z.literal('or'), conditions: z.array(ConditionSchema).min(1) }),
  z.object({ op: z.literal('not'), condition: ConditionSchema }),
]));

export const LegalActSchema = z.object({
  actId: z.string(),
  title: z.string(),
  number: z.string().nullable(),
  issuer: z.string(),
  publicationDate: DateStringSchema.nullable(),
  officialUrl: z.string().url(),
  retrievedAt: DateTimeStringSchema,
  verificationStatus: z.enum(['reviewed', 'needs_review']),
  rawTextHash: z.string().nullable().optional(),
});
export type LegalAct = z.infer<typeof LegalActSchema>;

const DeadlineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), value: DateStringSchema }),
  z.object({ type: z.literal('before_effective_from') }),
  z.object({ type: z.literal('none') }),
]);

const EffectiveFromSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), value: DateStringSchema }),
  z.object({ type: z.literal('first_day_next_month'), sourceField: z.string() }),
  z.object({ type: z.literal('rule_valid_from') }),
  z.object({ type: z.literal('none') }),
]);

export const LegalRuleSchema = z.object({
  ruleId: z.string(),
  version: z.number().int().positive(),
  actId: z.string(),
  category: z.enum(['kkt', 'tax', 'marking', 'personal_data', 'distance_sales', 'payments', 'other']),
  title: z.string(),
  userTitle: z.string(),
  summary: z.string(),
  subjectRole: z.string(),
  legalStatus: z.enum(['upcoming', 'active', 'expired', 'repealed']),
  reviewStatus: z.enum(['reviewed', 'needs_review']),
  validFrom: DateStringSchema.nullable(),
  validTo: DateStringSchema.nullable(),
  checkedAt: DateStringSchema,
  applicability: z.object({
    condition: ConditionSchema,
    requiredFields: z.array(z.string()),
    questionMap: z.record(z.string()),
  }),
  manualReviewGates: z.array(z.object({
    condition: ConditionSchema,
    code: z.string(),
    message: z.string(),
  })).default([]),
  compliance: z.object({
    mode: z.enum(['not_assessed', 'condition']),
    compliantWhen: ConditionSchema.nullable(),
    actionRequiredWhen: ConditionSchema.nullable(),
    requiredFields: z.array(z.string()),
  }),
  effectiveFrom: EffectiveFromSchema,
  actions: z.array(z.object({
    actionKey: z.string(),
    title: z.string(),
    description: z.string(),
    when: ConditionSchema.nullable(),
    deadline: DeadlineSchema,
  })),
  evidenceRefs: z.array(z.object({
    id: z.string(),
    url: z.string().url(),
    label: z.string(),
    note: z.string().nullable().optional(),
  })).min(1),
  tags: z.array(z.string()).default([]),
  factModel: FactRuleMetadataSchema.optional(),
  seedHash: z.string(),
});
export type LegalRule = z.infer<typeof LegalRuleSchema>;

export type Tri = 'true' | 'false' | 'unknown';
export type ConditionResult = {
  value: Tri;
  missingFields: string[];
  reasons: string[];
};

export type MaterializedAction = {
  actionKey: string;
  title: string;
  description: string;
  deadline: string | null;
  deadlineKind: 'fixed' | 'before_effective_from' | 'none';
};

export type EvaluationResult = {
  verdict: Verdict;
  reviewState: 'auto' | 'needs_review';
  complianceState: ComplianceState;
  reasons: string[];
  missingFields: string[];
  reviewReasons: string[];
  evidenceRefs: string[];
  effectiveFrom: string | null;
  actions: MaterializedAction[];
};

export const ImpactAssessmentSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  profileVersion: z.number().int().positive(),
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  verdict: VerdictSchema,
  reviewState: ReviewStateSchema,
  complianceState: ComplianceStateSchema,
  reasons: z.array(z.string()),
  missingFields: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  reviewReasons: z.array(z.string()).default([]),
  effectiveFrom: DateStringSchema.nullable().optional(),
  previousAssessmentId: z.string().nullable().optional(),
  createdAt: DateTimeStringSchema,
});
