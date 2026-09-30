import { builtinFactDefinitions, requirementProblems, type FactDefinition } from '@reg/domain';
import { validateRegulatoryExtraction, type RegulatoryExtraction, type AutomaticExpression } from '@reg/llm';
import { createReviewDocument, reviewRequirements } from './draft.js';
import { compileReview, reviewHash } from './compiler.js';
import { parseReviewDocument, type ReviewDocument, type ReviewExpression } from './schema.js';

export const AUTO_GATE_VERSION='automatic-v1';
export function trustedOfficialUrl(value:string) {
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&
      ['pravo.gov.ru','government.ru','nalog.gov.ru','cbr.ru','rospotrebnadzor.ru'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h));
  }catch{return false;}
}
function expressionLeaves(expression:AutomaticExpression):Array<Extract<AutomaticExpression,{field:string}>> {
  if('conditions'in expression)return expression.conditions.flatMap(expressionLeaves);
  if('condition'in expression)return expressionLeaves(expression.condition);
  return [expression];
}
function sourceNumbers(text:string):number[] {
  const normalized=text.replace(/[\u00a0\u202f]/g,' ');
  const values:number[]=[];
  // Covers plain/grouped decimals and explicit thousand/million/billion units.
  for(const m of normalized.matchAll(/(?:\d{1,3}(?:[ ]\d{3})+|\d+)(?:[.,]\d+)?(?:[ ]*(?:\u0442\u044b\u0441|\u043c\u043b\u043d|\u043c\u043b\u0440\u0434|thousand|million|billion)\.?){0,1}/gi)) {
    const number=Number(m[0].replace(/\s/g,'').replace(',','.').replace(/[^0-9.].*$/,''));
    const scale=/\u043c\u043b\u0440\u0434|billion/i.test(m[0])?1e9:/\u043c\u043b\u043d|million/i.test(m[0])?1e6:/\u0442\u044b\u0441|thousand/i.test(m[0])?1e3:1;
    if(Number.isFinite(number))values.push(number*scale);
  }
  return values;
}
// A conservative contradiction detector for simple conjunctions. This is NOT
// a proof of legal interpretation; unsupported reasoning remains reviewable.
export function knownExpressionConflict(expressions:AutomaticExpression[],join:'and'|'or'):boolean {
  const constraints=(expression:AutomaticExpression):Array<Extract<AutomaticExpression,{field:string}>>=>
    'conditions'in expression?(expression.op==='and'?expression.conditions.flatMap(constraints):[]):'condition'in expression?[]:[expression];
  if(join==='or')return expressions.length>0&&expressions.every(e=>knownExpressionConflict([e],'and'));
  const groups=new Map<string,ReturnType<typeof constraints>>();
  for(const e of expressions)for(const leaf of constraints(e))groups.set(leaf.field,[...(groups.get(leaf.field)??[]),leaf]);
  for(const leaves of groups.values()) {
    const equal=leaves.filter(l=>l.op==='eq').map(l=>l.value);
    if(new Set(equal.map(reviewHash)).size>1)return true;
    const equality=equal[0];
    if(equal.length&&leaves.some(l=>l.op==='neq'&&reviewHash(l.value)===reviewHash(equality)))return true;
    const sets=leaves.filter(l=>l.op==='in'&&Array.isArray(l.value)).map(l=>l.value as Array<string|number|boolean>);
    if(equal.length&&sets.some(set=>!set.some(v=>reviewHash(v)===reviewHash(equality))))return true;
    if(sets.length&&sets.reduce((a,b)=>a.filter(x=>b.includes(x))).length===0)return true;
    let lower=-Infinity,upper=Infinity,lowerStrict=false,upperStrict=false;
    for(const l of leaves)if(typeof l.value==='number') {
      if(l.op==='gt'||l.op==='gte') {if(l.value>lower){lower=l.value;lowerStrict=l.op==='gt';}else if(l.value===lower&&l.op==='gt')lowerStrict=true;}
      if(l.op==='lt'||l.op==='lte') {if(l.value<upper){upper=l.value;upperStrict=l.op==='lt';}else if(l.value===upper&&l.op==='lt')upperStrict=true;}
    }
    if(lower>upper||lower===upper&&(lowerStrict||upperStrict))return true;
    if(typeof equality==='number'&&(equality<lower||equality>upper||equality===lower&&lowerStrict||equality===upper&&upperStrict))return true;
  }
  return false;
}
export function automaticReviewIssues(extraction:RegulatoryExtraction,document?:ReviewDocument):string[] {
  const issues:string[]=[];
  if(!trustedOfficialUrl(extraction.sourceSnapshot.officialUrl)||!['staged-official-page','official-url-fetch'].includes(extraction.sourceSnapshot.origin))issues.push('UNTRUSTED_SOURCE_ORIGIN');
  const plan=extraction.automation;
  if(!plan)return [...issues,'AUTOMATION_PLAN_REQUIRED'];
  if(plan.documentKind!=='normative')issues.push('DOCUMENT_REQUIRES_LEGAL_CONTEXT');
  if(plan.coverage!=='complete'||plan.unresolvedReferences.length)issues.push('INCOMPLETE_LEGAL_CONTEXT');
  if(reviewRequirements(extraction).length)issues.push('UNRESOLVED_EXTRACTION');
  if(plan.phases.length!==extraction.phases.length||new Set(plan.phases.map(p=>p.phaseIndex)).size!==plan.phases.length)issues.push('PHASE_COVERAGE');
  for(const p of plan.phases) {
    const original=extraction.phases[p.phaseIndex];
    if(!original){issues.push('PHASE_NOT_FOUND');continue;}
    if(!original.validFrom.date||!original.subjectRole)issues.push('INCOMPLETE_PHASE');
    if(knownExpressionConflict(p.conditionExpressions,p.conditionJoin))issues.push('KNOWN_LOGICAL_CONFLICT');
    if(p.conditionExpressions.length!==original.conditions.length||p.exceptionExpressions.length!==original.exceptions.length)issues.push('CONDITION_COVERAGE');
    const expressions=[...p.conditionExpressions,...p.exceptionExpressions,...(p.compliance?.compliantWhen?[p.compliance.compliantWhen]:[]),...(p.compliance?.actionRequiredWhen?[p.compliance.actionRequiredWhen]:[])];
    for(const leaf of expressions.flatMap(expressionLeaves)) {
      const text=leaf.sourceSegmentIndexes.map(i=>extraction.sourceSnapshot.segments[i]?.text??'').join('');
      if(!text.trim())issues.push('MISSING_EXPRESSION_EVIDENCE');
      const numbers=sourceNumbers(text);
      const values=Array.isArray(leaf.value)?leaf.value:[leaf.value];
      for(const v of values)if(typeof v==='number'&&!numbers.includes(v))issues.push('NUMBER_NOT_IN_EVIDENCE');
    }
    original.conditions.forEach((c,index)=>{
      const e=p.conditionExpressions[index];
      if(e&&'field'in e&&c.operatorHint!=='other') {
        const aliases:Record<string,string>={date_eq:'eq',date_before:'lt',date_after:'gt'};
        if(c.fieldHint!==e.field||(aliases[c.operatorHint]??c.operatorHint)!==e.op||reviewHash(c.valueHint)!==reviewHash(e.value))issues.push('DRAFT_PLAN_DISAGREEMENT');
      }
    });
    if(document) {
      const phase=document.phases.find(d=>d.originIndex===p.phaseIndex);
      if(!phase||phase.decision!=='include'||phase.conditionJoin!==p.conditionJoin||phase.scope!==p.scope||
        reviewHash(phase.factRequirements)!==reviewHash(p.requiredFacts)||
        reviewHash(phase.conditions.map(c=>c.expression))!==reviewHash(p.conditionExpressions)||
        reviewHash(phase.exceptions.map(c=>c.expression))!==reviewHash(p.exceptionExpressions)||
        reviewHash(phase.validFrom)!==reviewHash(original.validFrom)||reviewHash(phase.validTo)!==reviewHash(original.validTo)||
        phase.endReason!==p.endReason||phase.subjectRole!==original.subjectRole||phase.category!==p.category||
        reviewHash(phase.compliance??null)!==reviewHash(p.compliance??null)||
        phase.actions.length!==original.actionDrafts.length||phase.actions.some((a,i)=>a.decision!=='include'||a.originIndex!==i||
          a.title!==original.actionDrafts[i]?.title||a.description!==original.actionDrafts[i]?.description||
          reviewHash(a.deadline)!==reviewHash(original.actionDrafts[i]?.deadline??null)||
          reviewHash(a.sourceSegmentIndexes)!==reviewHash(original.actionDrafts[i]?.sourceSegmentIndexes??null))||
        [...phase.conditions,...phase.exceptions].some(c=>c.decision!=='include'))issues.push('AUTOMATIC_REVISION_MODIFIED');
    }
  }
  if(document) {
    if(document.phases.length!==extraction.phases.length||document.title!==extraction.title)issues.push('AUTOMATIC_REVISION_MODIFIED');
    const snapshotCatalog=[...(extraction.factCatalog??builtinFactDefinitions()),...plan.factDefinitions];
    const used=new Set(plan.phases.flatMap(p=>p.requiredFacts.map(r=>r.key+':'+r.definitionVersion)));
    const expected=[...new Map(snapshotCatalog.filter(d=>used.has(d.key+':'+d.version)).map(d=>[d.key+':'+d.version,d])).values()];
    if(reviewHash(document.factDefinitions??[])!==reviewHash(expected))issues.push('AUTOMATIC_FACT_DEFINITIONS_MODIFIED');
  }
  return [...new Set(issues)];
}
export function prepareAutomaticReview(raw:RegulatoryExtraction,sourceId:string,available:FactDefinition[],checkedAt:string,baseDocument?:ReviewDocument) {
  const extraction=validateRegulatoryExtraction(raw);
  const issues=automaticReviewIssues(extraction);
  const doc=baseDocument?parseReviewDocument(baseDocument):createReviewDocument(extraction);
  if(!extraction.automation)return {document:doc,issues,ready:false};
  const plan=extraction.automation;
  const catalog=[...available,...plan.factDefinitions];
  const usedKeys=new Set(plan.phases.flatMap(p=>p.requiredFacts.map(r=>r.key+':'+r.definitionVersion)));
  const definitions=[...new Map(catalog.filter(d=>usedKeys.has(d.key+':'+d.version)).map(d=>[d.key+':'+d.version,d])).values()];
  for(const d of plan.factDefinitions)if(!usedKeys.has(d.key+':'+d.version))issues.push('UNUSED_PROPOSED_FACT');
  doc.factDefinitions=structuredClone(definitions);doc.approvalMode='machine_validated';
  doc.actId='auto-act-'+reviewHash({url:extraction.sourceSnapshot.officialUrl,hash:extraction.sourceSnapshot.textHash}).slice(0,40);
  doc.sourceReview={confirmed:true,note:'Machine-validated source and compilation. Not a human legal review.'};
  doc.phases.forEach(phase=>{
    const p=plan.phases.find(p=>p.phaseIndex===phase.originIndex);if(!p)return;
    issues.push(...requirementProblems(p.requiredFacts,definitions));
    phase.ruleId='auto-rule-'+reviewHash(sourceId).slice(0,32)+'.p'+phase.originIndex;
    phase.decision='include';phase.reason='Automatic gate '+AUTO_GATE_VERSION;
    phase.category=p.category;phase.scope=p.scope;phase.endReason=p.endReason;phase.conditionJoin=p.conditionJoin;
    phase.factRequirements=structuredClone(p.requiredFacts);phase.compliance=p.compliance?structuredClone(p.compliance):undefined;
    phase.conditions.forEach((c,i)=>{c.decision='include';c.reason='Source-grounded automatic mapping';c.expression=p.conditionExpressions[i] as ReviewExpression??null;});
    phase.exceptions.forEach((c,i)=>{c.decision='include';c.reason='Source-grounded automatic exception';c.expression=p.exceptionExpressions[i] as ReviewExpression??null;});
    phase.actions.forEach(a=>{a.decision='include';a.reason='Source-grounded action; execution is not a legal compliance guarantee.';});
    for(const r of p.requiredFacts)phase.questionMap[r.field]=definitions.find(d=>d.key===r.key&&d.version===r.definitionVersion)?.question??r.field;
  });
  issues.push(...automaticReviewIssues(extraction,doc));
  const compilation=compileReview(doc,extraction,checkedAt);
  issues.push(...compilation.issues.map(i=>i.code));
  return {document:doc,issues:[...new Set(issues)],ready:issues.length===0&&compilation.ready};
}
