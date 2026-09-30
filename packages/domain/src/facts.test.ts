import { describe,it,expect } from 'vitest';
import { FactDefinitionSchema, FactRequirementSchema, FactPeriodSchema, periodWindow, resolveFact, validateFactValue,
  builtinFactDefinitions, compileTargeting, requirementProblems, getFactPath, setFactPath, nextPeriodBoundary, canProjectLegacyFact,
  type FactDefinition, type FactRequirement, type FactObservation, type Condition } from './index.js';
const def=FactDefinitionSchema.parse({key:'business.enabled',semanticKey:'business.enabled',title:'Enabled',description:'Test operation flag',type:'boolean',scope:'company',question:'Is it enabled?',freshness:{kind:'periodic',maxAgeDays:30},periodic:false});
const req=FactRequirementSchema.parse({field:'facts.business.enabled',key:def.key,purposes:['applicability']});
function observation(value:unknown=false,confirmedAt='2026-09-01T12:00:00.000Z',scopeId='company-a'):FactObservation {
  return {id:'obs-1',key:def.key,definitionVersion:1,scopeId,value,confirmedAt,source:'user',period:periodWindow({kind:'none'},'2026-09-01')};
}
const now='2026-09-18T12:00:00.000Z';
describe('S9.9 registry and value validation',()=>{
  it('registers the complete legacy catalog with no duplicate keys',()=>{
    const ds=builtinFactDefinitions();expect(new Set(ds.map(d=>d.key)).size).toBe(ds.length);expect(ds.length).toBeGreaterThan(25);
    expect(ds.find(d=>d.legacyField==='taxRegime')?.freshness.maxAgeDays).toBe(30);
  });
  it('rejects executable metadata and unsafe namespaces',()=>{
    expect(FactDefinitionSchema.safeParse({...def,script:'eval(input)'}).success).toBe(false);
    expect(FactDefinitionSchema.safeParse({...def,key:'business.constructor.flag'}).success).toBe(false);
    expect(FactDefinitionSchema.safeParse({...def,question:'<script>run</script>'}).success).toBe(false);
  });
  it('requires enumerations to have distinct options',()=>{
    expect(FactDefinitionSchema.safeParse({...def,type:'enum',options:[]}).success).toBe(false);
    expect(FactDefinitionSchema.safeParse({...def,type:'enum',options:[{value:'a',label:'A'},{value:'a',label:'Again'}]}).success).toBe(false);
  });
  it('preserves false, zero and an empty list as known values',()=>{
    expect(validateFactValue(def,false)).toBe(true);
    expect(validateFactValue({...def,type:'number'},0)).toBe(true);
    expect(validateFactValue({...def,type:'string_list'},[])).toBe(true);
    expect(resolveFact(def,req,[observation(false)],'company-a',now).status).toBe('fresh');
  });
  it('rejects numeric strings, Infinity and non-calendar dates',()=>{
    expect(validateFactValue({...def,type:'number'},'10')).toBe(false);
    expect(validateFactValue({...def,type:'number'},Infinity)).toBe(false);
    expect(validateFactValue({...def,type:'date'},'2026-02-29')).toBe(false);
    expect(validateFactValue({...def,type:'date'},'2024-02-29')).toBe(true);
  });
  it('does not expose inherited or prototype properties',()=>{
    const target:Record<string,unknown>={};setFactPath(target,'facts.business.enabled',false);
    expect(getFactPath(target,'facts.business.enabled')).toBe(false);
    expect(getFactPath({},'constructor')).toBeUndefined();
    expect(()=>setFactPath(target,'facts.constructor.flag',true)).toThrow('UNSAFE_FACT_PATH');
  });
  it('rejects unbound fields and ambiguous aliases',()=>{
    expect(requirementProblems([{...req,field:'taxRegime'}],[def])).toContain('UNSAFE_BINDING:taxRegime');
    expect(requirementProblems([req,req],[def])).toContain('DUPLICATE_BINDING:facts.business.enabled');
    expect(requirementProblems([req],[])).toContain('UNKNOWN_FACT:business.enabled');
  });
});
describe('S9.9 fact freshness and reuse',()=>{
  it('distinguishes missing from explicitly unknown',()=>{
    expect(resolveFact(def,req,[],'company-a',now).status).toBe('missing');
    expect(resolveFact(def,req,[observation(null)],'company-a',now).status).toBe('missing');
  });
  it('expires exactly at the configured boundary',()=>{
    const o=observation(true,'2026-08-19T12:00:00.000Z');
    expect(resolveFact(def,req,[o],'company-a','2026-09-18T11:59:59.999Z').status).toBe('fresh');
    expect(resolveFact(def,req,[o],'company-a',now).status).toBe('stale');
  });
  it('honors a stricter rule-specific maximum age',()=>{
    expect(resolveFact(def,{...req,maxAgeDays:5},[observation()],'company-a',now).status).toBe('stale');
  });
  it('never substitutes values from another company or outlet',()=>{
    expect(resolveFact(def,req,[observation(true,now,'company-b')],'company-a',now).status).toBe('missing');
    expect(resolveFact({...def,scope:'trade_object'},req,[observation(true,now,'outlet-a')],'outlet-b',now).status).toBe('missing');
  });
  it('rejects future confirmation timestamps',()=>{
    expect(resolveFact(def,req,[observation(true,'2028-01-01T00:00:00.000Z')],'company-a',now).status).toBe('stale');
  });
  it('reuses one observation for separate rule bindings',()=>{
    const a=resolveFact(def,req,[observation()],'company-a',now);
    const b=resolveFact(def,{...req,field:'facts.other.alias'},[observation()],'company-a',now);
    expect(a.observation?.id).toBe(b.observation?.id);expect(b.status).toBe('fresh');
  });
});
describe('S9.9 periods',()=>{
  it('uses half-open explicit calendar ranges',()=>{
    expect(periodWindow({kind:'previous_calendar_year'},'2026-09-18').key).toBe('2025-01-01/2026-01-01');
    expect(periodWindow({kind:'month',offset:-1},'2024-03-10').key).toBe('2024-02-01/2024-03-01');
    expect(periodWindow({kind:'quarter',offset:-1},'2026-01-10').key).toBe('2025-10-01/2026-01-01');
  });
  it('refuses invalid intervals',()=>{
    expect(()=>periodWindow({kind:'range',start:'2026-03-01',end:'2026-02-01'},'2026-09-18')).toThrow('INVALID_PERIOD');
    expect(FactPeriodSchema.safeParse({kind:'month',offset:0,sql:'DROP TABLE'}).success).toBe(false);
  });
  it('does not reuse a previous year amount for another year',()=>{
    const d={...def,type:'number' as const,periodic:true};const r={...req,period:{kind:'previous_calendar_year' as const}};
    const o={...observation(500),period:periodWindow(r.period,'2025-09-18')};
    expect(resolveFact(d,r,[o],'company-a',now).status).toBe('missing');
  });
  it('keeps YTD measured date and avoids a daily duplicate question',()=>{
    const d={...def,type:'number' as const,periodic:true};const r={...req,period:{kind:'current_ytd' as const}};
    const o={...observation(500),period:periodWindow(r.period,'2026-09-01')};
    const resolved=resolveFact(d,r,[o],'company-a',now);
    expect(resolved.status).toBe('fresh');expect(resolved.observation?.period.asOf).toBe('2026-09-01');
  });
  it('does not refresh an old measurement merely by changing confirmedAt',()=>{
    const d={...def,type:'number' as const,periodic:true};const r={...req,period:{kind:'current_ytd' as const}};
    const o={...observation(500,now),period:periodWindow(r.period,'2026-07-01')};
    expect(resolveFact(d,r,[o],'company-a',now).status).toBe('stale');
  });
  it('schedules exact binding rollover instead of polling every company',()=>{
    expect(nextPeriodBoundary({kind:'month',offset:-1},now)).toBe('2026-10-01T00:00:00.000Z');
    expect(nextPeriodBoundary({kind:'previous_calendar_year'},now)).toBe('2027-01-01T00:00:00.000Z');
    expect(nextPeriodBoundary({kind:'none'},now)).toBe(null);
  });
  it('never writes a historical tax answer over current taxRegime',()=>{
    const d=builtinFactDefinitions().find(d=>d.key==='tax.regime')!;
    expect(canProjectLegacyFact(d,{...req,key:d.key,period:{kind:'as_of',date:'2020-01-01'}},now)).toBe(false);
    expect(canProjectLegacyFact(d,{...req,key:d.key,period:{kind:'none'}},now)).toBe(true);
  });
});
describe('S9.9 conservative targeting SQL',()=>{
  function query(condition:Condition,definitions:FactDefinition[]=[def],requirements:FactRequirement[]=[req]) {
    const q=compileTargeting(condition,requirements,definitions,now,4);
    const used=new Set([...q.sql.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])));
    expect([...used].sort((a,b)=>a-b)).toEqual(q.values.map((_,i)=>i+4));return q;
  }
  it('passes companies with missing OR stale values to full evaluation',()=>{
    const q=query({op:'eq',field:req.field,value:true});
    expect(q.sql).toContain('NOT EXISTS');expect(q.sql).toContain('confirmed_at');expect(q.sql).toContain(' OR EXISTS');
  });
  it('binds values, including attempted SQL injection',()=>{
    const q=query({op:'eq',field:req.field,value:"x' OR TRUE --"},[{...def,type:'text'}]);
    expect(q.sql).not.toContain('OR TRUE --');expect(q.values).toContain(JSON.stringify("x' OR TRUE --"));
  });
  it('widens NOT and unsupported scoped predicates without unused binds',()=>{
    expect(query({op:'not',condition:{op:'eq',field:req.field,value:true}}).sql).toBe('TRUE');
    expect(query({op:'gt',field:req.field,value:1}).values).toEqual([]);
    expect(query({op:'eq',field:req.field,value:true},[{...def,scope:'trade_object'}]).sql).toBe('TRUE');
  });
  it('preserves OR groups and does not turn them into an AND filter',()=>{
    const q=query({op:'or',conditions:[{op:'eq',field:req.field,value:true},{op:'eq',field:'unknownField',value:true}]});
    expect(q.sql).toContain(' OR TRUE');
  });
  it('widens a YTD prefilter rather than discarding a dated measurement',()=>{
    expect(query({op:'gt',field:req.field,value:100},[{...def,type:'number',periodic:true}],[{...req,period:{kind:'current_ytd'}}]).sql).toBe('TRUE');
  });
});
