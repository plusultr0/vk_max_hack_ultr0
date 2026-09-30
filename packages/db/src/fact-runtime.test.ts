import { describe,it,expect,vi } from 'vitest';
import { CompanyProfileSchema, builtinFactDefinitions, FactDefinitionSchema, periodWindow, type SelectedRule, type FactObservation } from '@reg/domain';
import { compileReview, prepareAutomaticReview, knownExpressionConflict } from '@reg/review';
import { automaticFixture } from '../../review/test/automatic-fixture.js';
import { evaluateWithFacts, factQuestion } from './fact-evaluation.js';
import { factDefinitionConflicts } from './facts.js';
import { actionHash } from './runtime.js';
import { targetCompanyPage } from './targeting.js';
const now='2026-09-18T12:00:00.000Z',company='test-company';
function scenario() {
  const f=automaticFixture(),review=prepareAutomaticReview(f.extraction,'synthetic-source',f.catalog,now.slice(0,10));
  const compiled=compileReview(review.document,f.extraction,now.slice(0,10)).rules[0]!;
  const selected:SelectedRule={rule:{...compiled.rule,reviewStatus:'reviewed'},scope:compiled.scope,timeState:'active',cancelled:false,effectiveOn:'2026-01-01'};
  const profile=CompanyProfileSchema.parse({profileVersion:1,legalForm:'LLC',confirmedAt:now});
  const observe=(key:string,value:unknown,confirmedAt=now):FactObservation=>({id:key+'-id',key,definitionVersion:1,scopeId:company,value,confirmedAt,source:'user',period:periodWindow({kind:'none'},now.slice(0,10))});
  const base=[observe('company.legalForm','LLC')];
  return {...f,selected,profile,observe,base};
}
describe('S9.9 fact-aware runtime (pure functions)',()=>{
  it('asks for a new dynamic fact while preserving tri-state applicability',()=>{
    const s=scenario(),r=evaluateWithFacts(s.selected,s.profile,s.base,company,now);
    expect(r.evaluation.verdict).toBe('needs_info');expect(r.clarificationState).toBe('needs_info');expect(r.evaluation.actions).toEqual([]);
    expect(r.evaluation.missingFields).toEqual(['facts.warehouse.archiveInUse']);
    const q=factQuestion(r.resolutions[1]!);expect(q.inputType).toBe('boolean');expect(q.expectedObservationId).toBe(null);
  });
  it('resolves true to an action plan without claiming an established violation',()=>{
    const s=scenario(),r=evaluateWithFacts(s.selected,s.profile,[...s.base,s.observe(s.definition.key,true)],company,now);
    expect(r.evaluation.verdict).toBe('applies');expect(r.evaluation.actions).toHaveLength(1);
    expect(r.evaluation.complianceState).toBe('not_assessed');expect(r.clarificationState).toBe(null);
  });
  it('false is a known exclusion and suppresses irrelevant questions',()=>{
    const s=scenario(),r=evaluateWithFacts(s.selected,s.profile,[...s.base,s.observe(s.definition.key,false)],company,now);
    expect(r.evaluation.verdict).toBe('not_applicable');expect(r.evaluation.actions).toEqual([]);expect(r.evaluation.missingFields).toEqual([]);
    const unrelated=evaluateWithFacts(s.selected,{...s.profile,legalForm:'IP'},[s.observe('company.legalForm','IP')],company,now);
    expect(unrelated.evaluation.verdict).toBe('not_applicable');expect(unrelated.evaluation.missingFields).toEqual([]);
  });
  it('a stale previous exclusion must become a confirmation question',()=>{
    const s=scenario(),r=evaluateWithFacts(s.selected,s.profile,[...s.base,s.observe(s.definition.key,false,'2026-08-01T00:00:00Z')],company,now);
    expect(r.evaluation.verdict).toBe('needs_info');expect(r.clarificationState).toBe('needs_confirmation');
    expect(factQuestion(r.resolutions[1]!).currentValue).toBe(false);expect(r.evaluation.actions).toEqual([]);
  });
  it('reuses fresh facts in another rule with no question or model call',()=>{
    const s=scenario(),observations=[...s.base,s.observe(s.definition.key,true)];
    const next={...s.selected,rule:{...s.selected.rule,ruleId:'other-regulation'}};
    expect(evaluateWithFacts(next,s.profile,observations,company,now).evaluation.verdict).toBe('applies');
    expect(evaluateWithFacts(next,s.profile,observations,company,now).evaluation.missingFields).toEqual([]);
  });
  it('does not manufacture completion changes on a fresh confirmation',()=>{
    const s=scenario(),old=evaluateWithFacts(s.selected,s.profile,[...s.base,s.observe(s.definition.key,true,'2026-09-01T12:00:00Z')],company,now);
    const next=evaluateWithFacts(s.selected,s.profile,[...s.base,{...s.observe(s.definition.key,true),id:'confirmed-again'}],company,now);
    expect(old.calculationKey).not.toBe(next.calculationKey);
    expect(actionHash(s.selected.rule,'company',s.profile,old.evaluation.actions[0]!,old.resolutions))
      .toBe(actionHash(s.selected.rule,'company',s.profile,next.evaluation.actions[0]!,next.resolutions));
  });
  it('preserves future and cancelled lifecycle behavior',()=>{
    const s=scenario(),obs=[...s.base,s.observe(s.definition.key,true)];
    expect(evaluateWithFacts({...s.selected,timeState:'upcoming'},s.profile,obs,company,now).evaluation.actions).toEqual([]);
    expect(evaluateWithFacts({...s.selected,timeState:'cancelled'},s.profile,obs,company,now).evaluation.verdict).toBe('not_applicable');
  });
  it('does not use unknown compliance data as evidence of breach',()=>{
    const s=scenario(),d=builtinFactDefinitions().find(d=>d.legacyField==='consentSeparate')!;
    const rule=structuredClone(s.selected.rule);rule.factModel!.definitions.push(d);
    rule.factModel!.requiredFacts.push({field:'consentSeparate',key:d.key,definitionVersion:1,purposes:['compliance'],period:{kind:'none'},maxAgeDays:null});
    rule.compliance={mode:'condition',compliantWhen:{op:'eq',field:'consentSeparate',value:true},actionRequiredWhen:{op:'eq',field:'consentSeparate',value:false},requiredFields:['consentSeparate']};
    const r=evaluateWithFacts({...s.selected,rule},s.profile,[...s.base,s.observe(s.definition.key,true)],company,now);
    expect(r.evaluation.verdict).toBe('applies');expect(r.evaluation.complianceState).toBe('unknown');expect(r.evaluation.actions).toEqual([]);
  });
});
describe('S9.9 registry conflicts and cohort query boundary',()=>{
  it('does not silently overwrite an immutable fact definition',()=>{
    const s=scenario();expect(factDefinitionConflicts([{...s.definition,type:'text'}],[s.definition])).toContain('FACT_DEFINITION_CONFLICT:'+s.definition.key);
  });
  it('rejects semantic aliases even under another stable key',()=>{
    const s=scenario();expect(factDefinitionConflicts([{...s.definition,key:'warehouse.secondAlias'}],[s.definition])).toContain('AMBIGUOUS_FACT_ALIAS:warehouse.secondAlias:'+s.definition.key);
  });
  it('reusing an identical definition is idempotent',()=>{
    const s=scenario();expect(factDefinitionConflicts([s.definition],[s.definition])).toEqual([]);
  });
  it('keeps previously affected companies in targeted fan-out',async()=>{
    const s=scenario();const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows:[{id:'company-x'}]}));
    const result=await targetCompanyPage({query} as any,[s.selected.rule],'cursor-1',500,now);
    expect(result.companyIds).toEqual(['company-x']);
    const [sql,values]=query.mock.calls[0]!;
    expect(sql).toContain('impact_assessments');expect(sql).toContain('company_fact_current');expect(sql).toContain('NOT EXISTS');
    expect(values).toContain('cursor-1');expect(values).toContain(500);expect(sql).not.toContain('cursor-1');
  });
  it('detects only provable simple contradictions without inventing OR narrowing',()=>{
    const leaf=(value:boolean)=>({op:'eq' as const,field:'facts.x.flag',value,scope:'company' as const,sourceSegmentIndexes:[0]});
    expect(knownExpressionConflict([leaf(true),leaf(false)],'and')).toBe(true);
    expect(knownExpressionConflict([leaf(true),leaf(false)],'or')).toBe(false);
    expect(knownExpressionConflict([{...leaf(true),op:'gt',value:10},{...leaf(true),op:'lte',value:10}],'and')).toBe(true);
  });
});


describe('S9.9 operator fallback for definition versions',()=>{
  it('allows a reviewed operator definition without weakening the machine gate',()=>{
    const s=scenario(),d={...s.definition,origin:'operator' as const};
    expect(factDefinitionConflicts([d],s.catalog,'human')).toEqual([]);
    expect(factDefinitionConflicts([d],s.catalog)).toContain('NEW_FACT_ORIGIN_INVALID:'+d.key);
  });
  it('pins previous versions and accepts only the next operator revision',()=>{
    const s=scenario(),existing=[...s.catalog,s.definition],d={...s.definition,version:2,origin:'operator' as const};
    expect(factDefinitionConflicts([d],existing,'human')).toEqual([]);
    expect(factDefinitionConflicts([{...d,version:4}],existing,'human')).toContain('FACT_VERSION_SEQUENCE_INVALID:'+d.key);
    expect(factDefinitionConflicts([d],existing)).toContain('FACT_VERSION_REQUIRES_REVIEW:'+d.key);
  });
});
