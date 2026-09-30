import {
  FIELD_COPY, VALUE_LABELS, formatValue, plainText, assessSelectedRule, builtinFactDefinitions, ruleFactRequirements, resolveFact, setFactPath, getFactPath,
  evaluateCondition, nextPeriodBoundary, type FactObservation, type FactResolution, type SelectedRule, type CompanyProfile,
} from '@reg/domain';
import { seedHash } from './canonical.js';

export function evaluateWithFacts(selected:SelectedRule,profile:CompanyProfile,observations:FactObservation[],companyId:string,now:string) {
  const rule=selected.rule;
  const definitions=rule.factModel?.definitions??builtinFactDefinitions();
  const requirements=ruleFactRequirements(rule);
  const input:Record<string,unknown>={...profile};
  const resolutions:FactResolution[]=[];const invalid:string[]=[];
  for(const req of requirements) {
    const d=definitions.find(d=>d.key===req.key&&d.version===req.definitionVersion);
    if(!d){invalid.push(req.key);setFactPath(input,req.field,undefined);continue;}
    const scopeId=d.scope==='company'?companyId:profile.tradeObjectId??'';
    const resolved=resolveFact(d,req,observations,scopeId,now);
    resolutions.push(resolved);
    setFactPath(input,req.field,resolved.status==='fresh'?resolved.observation!.value:undefined);
  }
  const evaluation=assessSelectedRule(selected,input as CompanyProfile,now.slice(0,10));
  if(invalid.length) {
    evaluation.reviewState='needs_review';evaluation.actions=[];
    evaluation.reviewReasons.push('Unsupported business fact definition: '+invalid.join(','));
  }
  if(evaluation.verdict==='applies'&&['active','upcoming'].includes(selected.timeState)) {
    const extra:string[]=[];
    for(const gate of rule.manualReviewGates) {
      const checked=evaluateCondition(gate.condition,input);
      if(checked.value==='unknown')extra.push(...checked.missingFields);
    }
    if(selected.timeState==='active') {
      for(const action of rule.actions)if(action.when) {
        const checked=evaluateCondition(action.when,input);
        if(checked.value==='unknown')extra.push(...checked.missingFields);
      }
      if(rule.effectiveFrom.type==='first_day_next_month'&&getFactPath(input,rule.effectiveFrom.sourceField)==null)extra.push(rule.effectiveFrom.sourceField);
    }
    evaluation.missingFields=[...new Set([...evaluation.missingFields,...extra])];
  }
  // Ask which point is meant before asking point-scoped values. Company-scoped
  // rules can also contain a trade-object exception; otherwise that path deadlocks.
  if(!profile.tradeObjectId&&resolutions.some(r=>r.definition.scope==='trade_object'&&evaluation.missingFields.includes(r.requirement.field))) {
    const pointFields=new Set(resolutions.filter(r=>r.definition.scope==='trade_object').map(r=>r.requirement.field));
    evaluation.missingFields=[...evaluation.missingFields.filter(f=>!pointFields.has(f)),'tradeObjectId'];
  }
  const usedQuestions=resolutions.filter(r=>evaluation.missingFields.includes(r.requirement.field));
  const clarificationState=usedQuestions.some(r=>r.status==='missing')?'needs_info':usedQuestions.some(r=>r.status==='stale')?'needs_confirmation':evaluation.missingFields.length?'needs_info':null;
  // Missing compliance facts should never silently become an assertion of breach.
  if(evaluation.missingFields.length) evaluation.actions=[];
  const deadlines=[...resolutions.filter(r=>r.status==='fresh'&&r.freshUntil).map(r=>r.freshUntil!),...requirements.map(r=>nextPeriodBoundary(r.period,now)).filter((v):v is string=>v!==null)];
  const availableUntil=deadlines.sort()[0]??null;
  const context={ resolutions:resolutions.map(r=>({field:r.requirement.field,key:r.requirement.key,version:r.requirement.definitionVersion,
      status:r.status,observationId:r.observation?.id??null,period:r.requirement.period.kind==='current_ytd'?(r.observation?.period??{key:'ytd:'+now.slice(0,4)}):r.window,freshUntil:r.freshUntil})),
    clarificationState,scopeId:selected.scope==='trade_object'?profile.tradeObjectId:null };
  const calculationKey=seedHash({rule:rule.seedHash,timeState:selected.timeState,effectiveOn:selected.effectiveOn,context,
    unbound:rule.applicability.requiredFields.filter(f=>!requirements.some(r=>r.field===f)).map(field=>({field,value:getFactPath(input,field)??null}))});
  return {evaluation,resolutions,context,calculationKey,clarificationState,nextFactCheckAt:availableUntil};
}
function customerFactHint(description:string) {
  const text=plainText(description,'Ответьте за свой бизнес. Если не уверены, выберите «Не знаю».');
  return /^self-report\b/i.test(text)
    ? 'Ответьте по фактической работе вашего бизнеса. Если не уверены, выберите «Не знаю».'
    : text;
}

export function factQuestion(resolution:FactResolution) {
  const d=resolution.definition,r=resolution.requirement;
  const inputType={boolean:'boolean',enum:'select',multi_enum:'multi_select',number:'number',date:'date',text:'text',string_list:'string_list'}[d.type];
  const copy=d.legacyField?FIELD_COPY[d.legacyField]:undefined;
  const options=d.options.map(o=>({value:o.value,label:VALUE_LABELS[o.value]??plainText(o.label,'Другой вариант')}));
  const currentValue=resolution.observation?.value??null;
  const label=formatValue(currentValue,options,d.unit);
  const title=copy?.title??plainText(d.title,'Дополнительные данные');
  return {field:r.field,factKey:r.key,definitionVersion:r.definitionVersion,
    text:copy?.question??plainText(d.question,'Уточните данные для этой проверки'),
    hint:copy?.hint??customerFactHint(d.description),
    placeholder:copy?.placeholder, min:d.min,max:d.max,
    inputType,options,status:resolution.status,currentValue,displayValue:label,period:resolution.window,unit:d.unit,
    confirmedAt:resolution.observation?.confirmedAt??null,expectedObservationId:resolution.observation?.id??null,
    confirmationText:`${title}: ${label}. Это всё ещё верно?`};
}
