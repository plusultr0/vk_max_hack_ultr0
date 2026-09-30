import { z } from 'zod';
import { FactDefinitionSchema, FactRequirementSchema } from '@reg/domain';
const refs=z.array(z.number().int().nonnegative()).min(1).max(200);
const atom=z.object({op:z.enum(['eq','neq','gt','gte','lt','lte','in','contains_any','contains_all','known','is_empty']),
  field:z.string().min(1).max(200),value:z.union([z.string(),z.number().finite(),z.boolean(),z.array(z.union([z.string(),z.number().finite(),z.boolean()])),z.null()]),
  scope:z.enum(['company','trade_object']),sourceSegmentIndexes:refs}).strict();
export type AutomaticExpression=z.infer<typeof atom>|{op:'and'|'or';conditions:AutomaticExpression[]}|{op:'not';condition:AutomaticExpression};
export const AutomaticExpressionSchema:z.ZodType<AutomaticExpression>=z.lazy(()=>z.union([atom,
  z.object({op:z.enum(['and','or']),conditions:z.array(AutomaticExpressionSchema).min(1).max(50)}).strict(),
  z.object({op:z.literal('not'),condition:AutomaticExpressionSchema}).strict()]));
export const AutomationPlanSchema=z.object({
  documentKind:z.enum(['normative','amendment','guidance','unknown']),
  coverage:z.enum(['complete','incomplete']),
  unresolvedReferences:z.array(z.string().max(2000)).max(100),
  factDefinitions:z.array(FactDefinitionSchema).max(100),
  phases:z.array(z.object({phaseIndex:z.number().int().nonnegative(),
    category:z.enum(['kkt','tax','marking','personal_data','distance_sales','payments','other']),
    scope:z.enum(['company','trade_object']),conditionJoin:z.enum(['and','or']),
    conditionExpressions:z.array(AutomaticExpressionSchema).max(100),
    exceptionExpressions:z.array(AutomaticExpressionSchema).max(100),
    requiredFacts:z.array(FactRequirementSchema).max(150),endReason:z.string().trim().min(1).max(2000),
    compliance:z.object({compliantWhen:AutomaticExpressionSchema.nullable(),actionRequiredWhen:AutomaticExpressionSchema.nullable()}).strict().optional(),
  }).strict()).max(50),
}).strict();
export type AutomationPlan=z.infer<typeof AutomationPlanSchema>;

// Wire JSON schema is bounded; the recursive server validator has its own depth
// and collection limits as a second boundary.
const str={type:'string'},nullable=(s:object)=>({anyOf:[s,{type:'null'}]}),arr=(items:object)=>({type:'array',items,maxItems:150});
const obj=(properties:Record<string,object>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const en=(values:string[])=>({type:'string',enum:values});
const scalar={anyOf:[str,{type:'number'},{type:'boolean'}]};
const jrefs={type:'array',items:{type:'integer',minimum:0},minItems:1,maxItems:200};
const expression=(depth:number):object=>({anyOf:[obj({op:en(['eq','neq','gt','gte','lt','lte','in','contains_any','contains_all','known','is_empty']),
  field:str,value:{anyOf:[...scalar.anyOf,arr(scalar),{type:'null'}]},scope:en(['company','trade_object']),sourceSegmentIndexes:jrefs}),
  ...(depth>0?[obj({op:en(['and','or']),conditions:{type:'array',items:expression(depth-1),minItems:1,maxItems:50}}),obj({op:en(['not']),condition:expression(depth-1)})]:[])]});
const period={anyOf:[obj({kind:en(['none','previous_calendar_year','current_ytd'])}),obj({kind:en(['month','quarter','calendar_year']),offset:{type:'integer',minimum:-100,maximum:5}}),
  obj({kind:en(['range']),start:str,end:str}),obj({kind:en(['as_of']),date:str})]};
export const AUTOMATION_JSON_SCHEMA=obj({
  documentKind:en(['normative','amendment','guidance','unknown']),coverage:en(['complete','incomplete']),unresolvedReferences:arr(str),
  factDefinitions:arr(obj({key:str,version:{type:'integer',enum:[1]},semanticKey:str,title:str,description:str,
    type:en(['boolean','enum','multi_enum','number','date','text','string_list']),scope:en(['company','trade_object']),question:str,
    options:arr(obj({value:str,label:str})),freshness:obj({kind:en(['stable','periodic','event']),maxAgeDays:nullable({type:'integer',minimum:1,maximum:3650})}),
    periodic:{type:'boolean'},unit:en(['none','RUB','count','percent','days']),min:nullable({type:'number'}),max:nullable({type:'number'}),origin:en(['model'])})),
  phases:arr(obj({phaseIndex:{type:'integer',minimum:0},category:en(['kkt','tax','marking','personal_data','distance_sales','payments','other']),scope:en(['company','trade_object']),
    conditionJoin:en(['and','or']),conditionExpressions:arr(expression(3)),exceptionExpressions:arr(expression(3)),
    requiredFacts:arr(obj({field:str,key:str,definitionVersion:{type:'integer',minimum:1},purposes:arr(en(['targeting','applicability','compliance','action','deadline'])),period,maxAgeDays:nullable({type:'integer',minimum:1,maximum:3650})})),
    endReason:str,compliance:obj({compliantWhen:nullable(expression(3)),actionRequiredWhen:nullable(expression(3))}),
  })),
});
export const AUTOMATION_INSTRUCTIONS=`
Customer-facing title, question, description and option labels must be in clear Russian for a small-business owner without legal training, without field keys, JSON, Markdown or unexplained abbreviations. If a legal term is necessary, explain it in ordinary words in the same description.
Ask one observable business fact per question. Do not ask the user to interpret the law. Explain where a person can find the answer in their normal business records, bank, accounting system or settings; never replace legal concepts with inaccurate simplifications.
Keep machine option values and field keys separate from their customer labels. Do not ask for names, passwords, account numbers or uploads.
S9.9: additionally return automation. No user/company records are supplied or requested.
Classify documentKind honestly. A news/guidance page is not a new normative act.
coverage=complete is allowed only for a self-contained requirement: retain ALL conditions, exceptions, phases and unresolved cross-references.
Provide a declarative expression for EVERY extracted condition/exception in original order. Preserve AND/OR/NOT nesting; never turn alternative branches into an intersection.
Use the server businessFactCatalog first. Do not propose aliases of known concepts. To introduce a genuinely new fact use a stable namespaced key and field=facts.<key>, origin=model, version=1.
A FactDefinition is plain data only: no SQL, JavaScript, regex or executable code. No personal data, bank account details or documents are necessary for these questions.
Do not merge revenue, taxable income and turnover, or company and trade-object scope. Fact bindings must state a precise period.
A missing or unknown condition must remain unresolved. Do not invent legal rules to achieve automatic publication.
Mutable facts normally have freshness={kind:periodic,maxAgeDays:30}. Previous-year totals must be bound to previous_calendar_year or an explicit closed period.
All expression leaves cite sourceSegmentIndexes. Every literal numeric threshold or date must occur in its cited source.
A field with no unambiguous legacy mapping can now be bound to a proposed dynamic fact; use its facts.<key> in fieldHint. Unresolved cases still use null/other.
Supply compliance expressions only when grounded in the source; applicability and actual compliance are distinct. Otherwise use null/null and do not claim a violation.
Auto gates, not the model, decide publication. Return incomplete/unknown plus uncertaintyNotes if the text cannot be formalized safely.
`;
