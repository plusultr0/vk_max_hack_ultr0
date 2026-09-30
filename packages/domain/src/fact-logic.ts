import type { FactDefinition, FactPeriod, FactRequirement } from './fact-schema.js';
import type { Condition } from './schemas.js';

export type PeriodWindow = { start:string|null; end:string|null; asOf:string|null; key:string };
export type FactObservation = {
  id:string; key:string; definitionVersion:number; scopeId:string; value:unknown;
  confirmedAt:string; source:string; period:PeriodWindow;
};
export type FactResolution = { requirement:FactRequirement; definition:FactDefinition; status:'fresh'|'stale'|'missing';
  observation:FactObservation|null; window:PeriodWindow; freshUntil:string|null; reason:string|null };

export function calendarDate(value:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) &&
    new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
function day(d:Date) { return d.toISOString().slice(0,10); }
export function periodWindow(period:FactPeriod, asOf:string):PeriodWindow {
  if(!calendarDate(asOf)) throw new Error('INVALID_AS_OF_DATE');
  const year=Number(asOf.slice(0,4)),month=Number(asOf.slice(5,7))-1;
  const at=(y:number,m:number,d=1)=>day(new Date(Date.UTC(y,m,d)));
  let start:string|null=null,end:string|null=null,point:string|null=null;
  switch(period.kind) {
    case 'none':break;
    case 'previous_calendar_year':start=at(year-1,0);end=at(year,0);break;
    case 'calendar_year':start=at(year+period.offset,0);end=at(year+period.offset+1,0);break;
    case 'quarter': {const m=Math.floor(month/3)*3+period.offset*3;start=at(year,m);end=at(year,m+3);break;}
    case 'month':start=at(year,month+period.offset);end=at(year,month+period.offset+1);break;
    case 'current_ytd':start=at(year,0);end=at(year,month,Number(asOf.slice(8,10))+1);point=asOf;break;
    case 'range':
      if(!calendarDate(period.start)||!calendarDate(period.end)||period.start>=period.end) throw new Error('INVALID_PERIOD');
      start=period.start;end=period.end;break;
    case 'as_of':if(!calendarDate(period.date)) throw new Error('INVALID_PERIOD');point=period.date;break;
  }
  return {start,end,asOf:point,key:period.kind==='none'?'none':point&&!start?`at:${point}`:`${start}/${end}`};
}

export function validateFactValue(def:FactDefinition, value:unknown):boolean {
  if(value===null) return true; // explicit "I don't know" stays unknown
  switch(def.type) {
    case 'boolean':return typeof value==='boolean';
    case 'enum':return typeof value==='string'&&def.options.some(o=>o.value===value);
    case 'multi_enum':return Array.isArray(value)&&value.length<=100&&new Set(value).size===value.length&&value.every(v=>typeof v==='string'&&def.options.some(o=>o.value===v));
    case 'number':return typeof value==='number'&&Number.isFinite(value)&&(def.min===null||value>=def.min)&&(def.max===null||value<=def.max);
    case 'date':return typeof value==='string'&&calendarDate(value);
    case 'text':return typeof value==='string'&&value.length<=2000&&!/[<>\u0000-\u0008]/.test(value);
    case 'string_list':return Array.isArray(value)&&value.length<=100&&value.every(v=>typeof v==='string'&&v.length<=200&&!/[<>\u0000-\u0008]/.test(v));
  }
}

export function resolveFact(def:FactDefinition, req:FactRequirement, observations:FactObservation[], scopeId:string, now:string):FactResolution {
  const window=periodWindow(req.period,now.slice(0,10));
  const ytd=req.period.kind==='current_ytd';
  const candidates=observations.filter(o=>o.key===req.key&&o.definitionVersion===req.definitionVersion&&o.scopeId===scopeId&&
    (ytd ? o.period.start===window.start&&!!o.period.asOf&&calendarDate(o.period.asOf)&&o.period.asOf<=now.slice(0,10)&&
      o.period.end===periodWindow({kind:'current_ytd'},o.period.asOf).end : o.period.key===window.key))
    .sort((a,b)=>(ytd?(b.period.asOf??'').localeCompare(a.period.asOf??''):0)||b.confirmedAt.localeCompare(a.confirmedAt));
  const observation=candidates[0]??null;
  const base={requirement:req,definition:def,observation,window,freshUntil:null};
  if(!observation||observation.value===null||!validateFactValue(def,observation.value))return {...base,status:'missing',reason:'missing'};
  // A YTD observation remains an explicitly dated measurement, never a yearly
  // total. It may be reused within the binding's age policy, but a newly clicked
  // confirmation cannot make an old measurement date current by itself.
  const days=Math.min(req.maxAgeDays??Infinity,def.freshness.maxAgeDays??Infinity,ytd?30:Infinity);
  const confirmed=Date.parse(observation.confirmedAt),at=Date.parse(now);
  if(!Number.isFinite(confirmed)||!Number.isFinite(at)||confirmed>at+60_000)return {...base,status:'stale',reason:'invalid_confirmation_date'};
  const measurement=ytd?Date.parse(observation.period.asOf+'T23:59:59.999Z'):Infinity;
  const until=Number.isFinite(days)?Math.min(confirmed+days*86400_000,measurement+days*86400_000):Infinity;
  const freshUntil=Number.isFinite(until)?new Date(until).toISOString():null;
  if(freshUntil&&at>=Date.parse(freshUntil))return {...base,freshUntil,status:'stale',reason:'confirmation_expired'};
  return {...base,freshUntil,status:'fresh',reason:null};
}

// Wake up only when a relative binding changes its meaning, not all companies
// every day. YTD reuses a dated value until freshness expiry/year rollover.
export function nextPeriodBoundary(period:FactPeriod,now:string):string|null {
  const date=now.slice(0,10),year=Number(date.slice(0,4)),month=Number(date.slice(5,7))-1;
  if(!calendarDate(date))throw new Error('INVALID_AS_OF_DATE');
  if(period.kind==='month')return new Date(Date.UTC(year,month+1,1)).toISOString();
  if(period.kind==='quarter')return new Date(Date.UTC(year,Math.floor(month/3)*3+3,1)).toISOString();
  if(['calendar_year','previous_calendar_year','current_ytd'].includes(period.kind))return new Date(Date.UTC(year+1,0,1)).toISOString();
  return null;
}

// Historical answers must never overwrite a CURRENT legacy profile alias.
export function canProjectLegacyFact(def:FactDefinition,req:FactRequirement,now:string):boolean {
  const f=def.legacyField;if(!f)return false;
  if(!def.periodic)return req.period.kind==='none';
  if(f==='income2025Usn')return periodWindow(req.period,now.slice(0,10)).key==='2025-01-01/2026-01-01';
  if(f==='incomeYtd2026')return req.period.kind==='current_ytd'&&now.startsWith('2026-');
  return req.period.kind==='previous_calendar_year';
}

// Own properties only, including dynamic paths: prototype traversal is never legal.
export function getFactPath(input:unknown,path:string):unknown {
  let node=input;
  for(const key of path.split('.')) {
    if(['__proto__','prototype','constructor'].includes(key)||!node||typeof node!=='object'||!Object.hasOwn(node,key)) return undefined;
    node=(node as Record<string,unknown>)[key];
  }
  return node;
}
export function setFactPath(input:Record<string,unknown>,path:string,value:unknown) {
  const keys=path.split('.');let obj=input;
  if(keys.some(k=>!k||['__proto__','prototype','constructor'].includes(k)))throw new Error('UNSAFE_FACT_PATH');
  for(const key of keys.slice(0,-1)) {
    if(!Object.hasOwn(obj,key)||!obj[key]||typeof obj[key]!=='object') obj[key]=Object.create(null);
    obj=obj[key] as Record<string,unknown>;
  }
  obj[keys[keys.length-1]!]=value;
}
export function conditionFields(c:Condition|null|undefined):string[] {
  if(!c)return [];
  if('conditions'in c)return [...new Set(c.conditions.flatMap(conditionFields))];
  if('condition'in c)return conditionFields(c.condition);
  return [c.field];
}
export function requirementProblems(requirements:FactRequirement[],definitions:FactDefinition[]):string[] {
  const issues:string[]=[];const fields=new Set<string>();
  for(const r of requirements) {
    const d=definitions.find(d=>d.key===r.key&&d.version===r.definitionVersion);
    if(!d){issues.push('UNKNOWN_FACT:'+r.key);continue;}
    if(fields.has(r.field))issues.push('DUPLICATE_BINDING:'+r.field);fields.add(r.field);
    if(r.field!==d.legacyField&&!r.field.startsWith('facts.'))issues.push('UNSAFE_BINDING:'+r.field);
    if(d.periodic&&r.period.kind==='none')issues.push('PERIOD_REQUIRED:'+r.key);
    if(!d.periodic&&r.period.kind!=='none'&&r.period.kind!=='as_of')issues.push('UNEXPECTED_PERIOD:'+r.key);
    try{periodWindow(r.period,'2026-01-15');}catch{issues.push('INVALID_PERIOD:'+r.key);}
  }
  return issues;
}
