import type { Condition } from './schemas.js';
import type { FactDefinition, FactRequirement } from './fact-schema.js';
import { periodWindow } from './fact-logic.js';

// This is a conservative SQL compilation of the SAME applicability expression,
// not a second model-generated classifier. Missing/stale facts MUST pass through.
// A NOT, unknown type or unsupported operation widens the cohort; it never drops
// a business on an unproved assumption. All values are bind parameters.
export function compileTargeting(condition:Condition, requirements:FactRequirement[], definitions:FactDefinition[], now:string, startIndex=1) {
  const values:unknown[]=[];const broadReasons:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return '$'+(startIndex+values.length-1);};
  function broad(reason:string){broadReasons.push(reason);return 'TRUE';}
  function visit(node:Condition,depth=0):string {
    if(depth>20)return broad('depth_limit');
    if('conditions'in node) {
      const children=node.conditions.map(c=>visit(c,depth+1));
      return children.length?'('+children.join(node.op==='and'?' AND ':' OR ')+')':broad('empty');
    }
    if('condition'in node)return broad('not_requires_full_evaluation');
    const req=requirements.find(r=>r.field===node.field),def=req&&definitions.find(d=>d.key===req.key&&d.version===req.definitionVersion);
    if(!req||!def||def.scope!=='company')return broad('unsupported_or_scoped:'+node.field);
    if(['known','exists','is_empty'].includes(node.op))return broad('presence_requires_full_evaluation');
    const checkpoint=values.length;
    if(req.period.kind==='current_ytd')return broad('ytd_requires_full_evaluation');
    const period=periodWindow(req.period,now.slice(0,10));
    const selector=`f.company_id=c.id AND f.fact_key=${bind(req.key)} AND f.definition_version=${bind(req.definitionVersion)} AND f.scope_id=c.id AND f.period_key=${bind(period.key)}`;
    const current=bind(now);
    const maxAge=Math.min(req.maxAgeDays??Infinity,def.freshness.maxAgeDays??Infinity);
    const fresh=`f.value<>'null'::jsonb AND f.confirmed_at<=${current}::timestamptz${Number.isFinite(maxAge)?` AND f.confirmed_at>${current}::timestamptz-(${bind(maxAge)} * interval '1 day')`:''}`;
    let match:string;
    if(node.op==='eq'||node.op==='neq')match=`f.value ${node.op==='eq'?'=':'<>'} ${bind(JSON.stringify(node.value))}::jsonb`;
    else if(['gt','gte','lt','lte'].includes(node.op)&&'value'in node&&(def.type==='number'||def.type==='date')) {
      const operator:Record<string,string>={gt:'>',gte:'>=',lt:'<',lte:'<='};
      match=`f.${def.type==='number'?'number_value':'text_value'} ${operator[node.op]} ${bind(node.value)}`;
    }else if(node.op==='in') {
      match='('+node.values.map(v=>`f.value=${bind(JSON.stringify(v))}::jsonb`).join(' OR ')+')';
      if(!node.values.length)match='FALSE';
    }else if(node.op==='contains_any'||node.op==='contains_all') {
      match='('+node.values.map(v=>`f.value @> ${bind(JSON.stringify([v]))}::jsonb`).join(node.op==='contains_any'?' OR ':' AND ')+')';
      if(!node.values.length)match=node.op==='contains_all'?'TRUE':'FALSE';
    }else { values.length=checkpoint;return broad('unsupported_operator:'+node.op); }
    return `(NOT EXISTS(SELECT 1 FROM company_fact_current f WHERE ${selector} AND ${fresh}) OR EXISTS(SELECT 1 FROM company_fact_current f WHERE ${selector} AND ${fresh} AND ${match}))`;
  }
  return {sql:visit(condition),values,broadReasons};
}
