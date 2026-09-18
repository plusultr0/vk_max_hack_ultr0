import { z } from 'zod';
import { isCalendarDate } from '@reg/llm';

export const REVIEW_VERSION = 'review-v1' as const;
const text = z.string().trim().min(1).max(10000);
const maybeText = text.nullable();
export const calendarDate = z.string().refine(isCalendarDate, 'Expected a calendar date YYYY-MM-DD');
const refs = z.array(z.number().int().nonnegative()).max(200);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export const ReviewPredicateSchema = z.object({
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains_any', 'contains_all', 'known', 'is_empty']),
  field: text,
  value: z.union([scalar, z.array(scalar).min(1).max(100), z.null()]),
  scope: z.enum(['company', 'trade_object']),
  sourceSegmentIndexes: refs,
}).strict();
export type ReviewExpression = z.infer<typeof ReviewPredicateSchema>
  | { op: 'and' | 'or'; conditions: ReviewExpression[] }
  | { op: 'not'; condition: ReviewExpression };
export const ReviewExpressionSchema: z.ZodType<ReviewExpression> = z.lazy(() => z.union([
  ReviewPredicateSchema,
  z.object({ op: z.enum(['and', 'or']), conditions: z.array(ReviewExpressionSchema).min(1).max(50) }).strict(),
  z.object({ op: z.literal('not'), condition: ReviewExpressionSchema }).strict(),
]));
const groundedDate = z.object({ date: calendarDate.nullable(), sourceSegmentIndexes: refs }).strict();
const itemBase = {
  id: z.string().uuid(),
  originIndex: z.number().int().nonnegative().nullable(),
  decision: z.enum(['unresolved', 'include', 'exclude']),
  reason: maybeText,
  sourceSegmentIndexes: refs,
};
const condition = z.object({ ...itemBase, text, expression: ReviewExpressionSchema.nullable() }).strict();
export const ReviewDeadlineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), date: calendarDate, sourceSegmentIndexes: refs }).strict(),
  z.object({ kind: z.literal('phase_start') }).strict(),
  z.object({ kind: z.literal('none'), reason: text }).strict(),
  z.object({ kind: z.literal('relative'), description: text, sourceSegmentIndexes: refs }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export const ReviewPhaseSchema = z.object({
  ...itemBase,
  ruleId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/),
  version: z.number().int().positive().max(2147483647),
  title: text, userTitle: text, summary: text, subjectRole: maybeText,
  category: z.enum(['kkt', 'tax', 'marking', 'personal_data', 'distance_sales', 'payments']).nullable(),
  scope: z.enum(['company', 'trade_object']).nullable(),
  validFrom: groundedDate,
  // Contract for new reviewed rules: [validFrom, validTo), in calendar dates.
  validTo: groundedDate,
  endReason: maybeText,
  conditionJoin: z.enum(['and', 'or']).nullable(),
  conditions: z.array(condition).max(100),
  exceptions: z.array(condition).max(100),
  actions: z.array(z.object({ ...itemBase, title: text, description: text, deadline: ReviewDeadlineSchema }).strict()).max(100),
  questionMap: z.record(text),
}).strict();
export const ReviewDocumentSchema = z.object({
  schemaVersion: z.literal(REVIEW_VERSION),
  actId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/),
  title: text,
  phases: z.array(ReviewPhaseSchema).max(50),
  sourceReview: z.object({ confirmed: z.boolean(), note: maybeText }).strict(),
  resolutions: z.array(z.object({ key: text, resolved: z.boolean(), note: maybeText }).strict()).max(500),
}).strict();
export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;
export type ReviewPhase = ReviewDocument['phases'][number];
export type ReviewIssue = { code: string; path: string; message: string };

export function parseReviewDocument(value: unknown): ReviewDocument {
  // Reject excessive input depth before invoking a recursive Zod schema.
  function check(node: unknown, depth: number) {
    if (depth > 30) throw new Error('REVIEW_DOCUMENT_TOO_DEEP');
    if (node && typeof node === 'object') for (const child of Object.values(node)) check(child, depth + 1);
  }
  check(value, 0);
  return ReviewDocumentSchema.parse(value);
}
