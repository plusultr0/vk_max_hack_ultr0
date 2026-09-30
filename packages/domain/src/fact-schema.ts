import { z } from 'zod';

// Definitions are data. No JavaScript, SQL, regular expressions or expression
// evaluator is accepted from a model or from a user's fact value.
const safeKey = z.string().min(3).max(160).regex(/^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)+$/)
  .refine(k => !k.split('.').some(p => ['__proto__','prototype','constructor'].includes(p)), 'Unsafe fact key');
const plain = z.string().trim().min(1).max(2000).refine(v => !/[<>\u0000-\u0008]/.test(v), 'Plain text required');
export const FactPeriodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.enum(['month','quarter','calendar_year']), offset: z.number().int().min(-100).max(5).default(0) }).strict(),
  z.object({ kind: z.literal('previous_calendar_year') }).strict(),
  z.object({ kind: z.literal('current_ytd') }).strict(),
  z.object({ kind: z.literal('range'), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ kind: z.literal('as_of'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
]);
export type FactPeriod = z.infer<typeof FactPeriodSchema>;
export const FactDefinitionSchema = z.object({
  key: safeKey,
  version: z.number().int().positive().max(100000).default(1),
  title: plain,
  description: plain,
  semanticKey: safeKey,
  type: z.enum(['boolean','enum','multi_enum','number','date','text','string_list']),
  scope: z.enum(['company','trade_object']),
  question: plain,
  options: z.array(z.object({ value: z.string().min(1).max(120), label: plain }).strict()).max(100).default([]),
  freshness: z.object({
    kind: z.enum(['stable','periodic','event']),
    maxAgeDays: z.number().int().min(1).max(3650).nullable(),
  }).strict(),
  periodic: z.boolean(),
  unit: z.enum(['none','RUB','count','percent','days']).default('none'),
  min: z.number().finite().nullable().default(null),
  max: z.number().finite().nullable().default(null),
  // Only the built-in catalog may contain a legacy field alias.
  legacyField: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).optional(),
  origin: z.enum(['builtin','model','operator']).default('model'),
}).strict().superRefine((d, ctx) => {
  const add = (message:string) => ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if ((d.type==='enum'||d.type==='multi_enum') !== (d.options.length>0)) add('Enum options required only for enum types');
  if (new Set(d.options.map(o=>o.value)).size!==d.options.length) add('Duplicate option');
  if (d.freshness.kind!=='stable' && !d.freshness.maxAgeDays) add('Mutable fact needs maxAgeDays');
  if (d.origin!=='builtin' && d.legacyField) add('Only builtins may alias profile fields');
  if (d.min!==null && d.max!==null && d.min>d.max) add('Invalid numeric range');
  if (d.type!=='number' && (d.min!==null||d.max!==null)) add('Numeric bounds on a non-number');
});
export type FactDefinition = z.infer<typeof FactDefinitionSchema>;
export const FactRequirementSchema = z.object({
  field: z.string().regex(/^(?:[a-zA-Z][a-zA-Z0-9_]*|facts\.[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)$/)
    .refine(v=>!v.split('.').some(x=>['prototype','constructor','__proto__'].includes(x))),
  key: safeKey,
  definitionVersion: z.number().int().positive().default(1),
  purposes: z.array(z.enum(['targeting','applicability','compliance','action','deadline'])).min(1).max(5),
  period: FactPeriodSchema.default({kind:'none'}),
  maxAgeDays: z.number().int().positive().max(3650).nullable().default(null),
}).strict();
export type FactRequirement = z.infer<typeof FactRequirementSchema>;
export const FactRuleMetadataSchema = z.object({
  schemaVersion: z.literal('facts-v1'),
  definitions: z.array(FactDefinitionSchema).max(100),
  requiredFacts: z.array(FactRequirementSchema).max(150),
  approvalMode: z.enum(['human','machine_validated']),
}).strict();
export type FactRuleMetadata = z.infer<typeof FactRuleMetadataSchema>;
