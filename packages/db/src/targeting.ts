import { builtinFactDefinitions, compileTargeting, ruleFactRequirements, type LegalRule } from '@reg/domain';
import type { FactDb } from './facts.js';

export async function targetCompanyPage(db:FactDb,rules:LegalRule[],cursor:string|null,limit=500,now=new Date().toISOString()) {
  const values:unknown[]=[];const bind=(v:unknown)=>{values.push(v);return '$'+values.length;};
  const predicates:string[]=[];const broadReasons:string[]=[];
  for(const rule of rules) {
    const target=compileTargeting(rule.applicability.condition,ruleFactRequirements(rule),rule.factModel?.definitions??builtinFactDefinitions(),now,values.length+1);
    values.push(...target.values);predicates.push(target.sql);broadReasons.push(...target.broadReasons);
  }
  const ruleIds=rules.map(r=>r.ruleId);
  // Re-evaluate previously affected businesses even when the NEW condition is
  // false. Otherwise a raised threshold would leave their old duties alive.
  const previouslyAffected=`EXISTS(SELECT 1 FROM impact_assessments i WHERE i.company_id=c.id AND i.rule_id=ANY(${bind(ruleIds)}::text[]))`;
  const cursorParam=bind(cursor??''),limitParam=bind(Math.max(1,Math.min(limit,2000)));
  const rows=await db.query(`SELECT c.id FROM companies c WHERE c.id>${cursorParam}
    AND EXISTS(SELECT 1 FROM company_profiles p WHERE p.company_id=c.id)
    AND ((${predicates.length?predicates.join(' OR '):'FALSE'}) OR ${previouslyAffected})
    ORDER BY c.id LIMIT ${limitParam}`,values);
  return {companyIds:rows.rows.map(r=>r.id as string),broadReasons:[...new Set(broadReasons)]};
}
