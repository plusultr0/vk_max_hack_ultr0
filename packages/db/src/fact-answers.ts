import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CompanyProfileSchema, ruleFactRequirements, validateFactValue, canProjectLegacyFact, builtinFactDefinitions, periodWindow, type FactResolution } from '@reg/domain';
import { getPool } from './client.js';
import { seedHash } from './canonical.js';
import { loadFactObservations, syncBuiltinProfileFacts, writeFactObservation } from './facts.js';
import { evaluateWithFacts } from './fact-evaluation.js';
import { impactIsCurrent, selectedRules, recalculateInTransaction } from './runtime.js';
import { ReviewError } from './review.js';

export const FactAnswersSchema=z.object({
  requestId:z.string().uuid(),
  edit:z.boolean().optional(),
  answers:z.array(z.object({field:z.string().min(1).max(200),value:z.unknown().optional(),confirm:z.boolean().optional(),
    expectedObservationId:z.string().nullable().optional()}).strict()).min(1).max(30),
}).strict();
export async function answerImpactFacts(companyId:string,impactId:string,body:unknown,actorId:string) {
  const request=FactAnswersSchema.parse(body),hash=seedHash({impactId,answers:request.answers,...(request.edit?{edit:true}:{})});
  if(new Set(request.answers.map(a=>a.field)).size!==request.answers.length)throw new ReviewError('DUPLICATE_FACT_ANSWER',400);
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
    const replay=(await db.query('SELECT request_hash,result FROM fact_answer_requests WHERE company_id=$1 AND request_id=$2',[companyId,request.requestId])).rows[0];
    if(replay){if(replay.request_hash!==hash)throw new ReviewError('IDEMPOTENCY_CONFLICT',409);await db.query('COMMIT');return replay.result;}
    const impact=(await db.query('SELECT * FROM impact_assessments WHERE id=$1 AND company_id=$2',[impactId,companyId])).rows[0];
    if(!impact)throw new ReviewError('IMPACT_NOT_FOUND',404);
    await syncBuiltinProfileFacts(db,companyId);
    if(!await impactIsCurrent(impact,db))throw new ReviewError('STALE_IMPACT',409);
    const profile=CompanyProfileSchema.parse((await db.query('SELECT data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1',[companyId])).rows[0]?.data);
    const selections=await selectedRules(db);
    const selected=selections.find(s=>s.rule.ruleId===impact.rule_id&&s.rule.version===impact.rule_version&&s.timeState===impact.time_state);
    if(!selected||['ended','cancelled'].includes(selected.timeState))throw new ReviewError('STALE_IMPACT',409);
    const now=new Date().toISOString(),observations=await loadFactObservations(companyId,db);
    const calculated=evaluateWithFacts(selected,profile,observations,companyId,now);
    const patch:Record<string,unknown>={},changedKeys=new Set<string>(),savedIds:string[]=[];
    const updates:Array<{r:FactResolution;value:unknown}>=[];
    for(const answer of request.answers) {
      if(!request.edit&&!calculated.evaluation.missingFields.includes(answer.field))throw new ReviewError('FIELD_NOT_REQUESTED',400);
      const r=calculated.resolutions.find(r=>r.requirement.field===answer.field);
      if(!r) {
        if(!calculated.evaluation.missingFields.includes(answer.field)||answer.field!=='tradeObjectId'||answer.confirm||typeof answer.value!=='string'||!answer.value.trim())throw new ReviewError('UNSUPPORTED_FACT_FIELD',422);
        patch.tradeObjectId=answer.value.trim();continue;
      }
      if(answer.expectedObservationId!==undefined&&answer.expectedObservationId!==(r.observation?.id??null))throw new ReviewError('FACT_CHANGED',409);
      if(answer.confirm&&(r.status!=='stale'||!r.observation||r.observation.value===null))throw new ReviewError('FACT_NOT_CONFIRMABLE',400);
      const value=answer.confirm?r.observation!.value:answer.value;
      if(!validateFactValue(r.definition,value))throw new ReviewError('INVALID_FACT_VALUE',400,{field:answer.field});
      if(r.definition.scope==='trade_object'&&!profile.tradeObjectId)throw new ReviewError('TRADE_OBJECT_REQUIRED',400);
      updates.push({r,value});changedKeys.add(r.requirement.key);
      if(canProjectLegacyFact(r.definition,r.requirement,now))patch[r.definition.legacyField!]=value;
    }
    if(updates.some(({r})=>r.definition.legacyField==='incomeYtd2026'&&canProjectLegacyFact(r.definition,r.requirement,now)))patch.incomeAsOf=now.slice(0,10);
    for(const {r,value} of updates)savedIds.push(await writeFactObservation(db,{companyId,definition:r.definition,
      scopeId:r.definition.scope==='company'?companyId:profile.tradeObjectId!,value,period:r.window,
      confirmedAt:now,source:'user',provenance:{actorId,impactId,requestId:request.requestId,confirmed:request.answers.find(a=>a.field===r.requirement.field)?.confirm===true}}));
    if(patch.incomeAsOf) {
      // The legacy YTD alias includes its measurement date. Persist that date as
      // a fact too; advancing the sync marker must not hide this related change.
      const dateDefinition=builtinFactDefinitions().find(d=>d.legacyField==='incomeAsOf')!;
      savedIds.push(await writeFactObservation(db,{companyId,definition:dateDefinition,
        scopeId:companyId,value:patch.incomeAsOf,period:periodWindow({kind:'none'},now.slice(0,10)),
        confirmedAt:now,source:'user',provenance:{actorId,impactId,requestId:request.requestId,derivedFrom:'incomeYtd2026'}}));
      changedKeys.add(dateDefinition.key);
    }
    // Legacy profile aliases remain useful to existing clients. Fact timestamps
    // stay per-field, not the timestamp of this aggregate profile version.
    const changed=Object.keys(patch).some(k=>seedHash((profile as any)[k]??null)!==seedHash(patch[k]));
    let profileVersion=profile.profileVersion;
    if(changed) {
      const newProfile=CompanyProfileSchema.parse({...profile,...patch,profileVersion:profile.profileVersion+1,confirmedAt:now});
      if(patch.tradeObjectId&&patch.tradeObjectId!==profile.tradeObjectId){newProfile.tradeObjectRevenuePreviousYear=null;newProfile.paymentLocationHasInternet=null;}
      await db.query('INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),companyId,newProfile.profileVersion,JSON.stringify(newProfile),now]);
      profileVersion=newProfile.profileVersion;
      await db.query('INSERT INTO business_fact_sync(company_id,profile_version) VALUES($1,$2) ON CONFLICT(company_id) DO UPDATE SET profile_version=EXCLUDED.profile_version',[companyId,profileVersion]);
      await db.query('DELETE FROM company_profile_drafts WHERE company_id=$1',[companyId]);
      // This request already recalculates all changed dependencies atomically.
      await db.query("UPDATE company_recalculation_jobs SET status='processed',processed_at=now() WHERE request_key=$1",['profile:'+companyId+':'+profileVersion]);
    }
    const ruleIds=[...new Set([selected.rule.ruleId,...selections.filter(s=>
      ruleFactRequirements(s.rule).some(r=>changedKeys.has(r.key))||!!patch.tradeObjectId&&s.scope==='trade_object').map(s=>s.rule.ruleId)])];
    // A new aggregate profile version invalidates ALL old assessments, even
    // those that do not depend on the answered fact. Recalculate all of them in
    // this transaction. Otherwise unrelated cards disappear indefinitely.
    const affectedRuleIds=changed?[...new Set(selections.map(s=>s.rule.ruleId))]:ruleIds;
    const impactIds=await recalculateInTransaction(db,companyId,'fact_answer',now.slice(0,10),changed?undefined:ruleIds);
    const result={profileVersion,updatedFacts:[...changedKeys],impactIds,ruleIds:affectedRuleIds};
    await db.query(`INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES($1,'user',$2,'facts.answered','impact_assessment',$3,$4)`,[companyId,actorId,impactId,JSON.stringify({requestId:request.requestId,observationIds:savedIds,keys:[...changedKeys]})]);
    await db.query('INSERT INTO fact_answer_requests(company_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)',[companyId,request.requestId,hash,JSON.stringify(result)]);
    await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
