import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { businessCheckTemplates,checkAnswerAllowed,summarizeBusinessChecks,actionCheckState } from '@reg/domain';
import { getPool } from './client.js';
import { listImpacts,getImpactById } from './impacts.js';
import { impactIsCurrent } from './runtime.js';
import { setActionStatusInTransaction } from './actions.js';
import { seedHash } from './canonical.js';
import { ReviewError } from './review.js';
import type { FactDb } from './facts.js';

async function checkBasis(companyId:string,ruleId:string,version:number,impactId:string,db:FactDb=getPool()) {
  const [r,p,i]=await Promise.all([
    db.query('SELECT seed_hash FROM legal_rules WHERE rule_id=$1 AND version=$2',[ruleId,version]),
    db.query('SELECT data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1',[companyId]),
    db.query('SELECT calculation_key FROM impact_assessments WHERE id=$1 AND company_id=$2',[impactId,companyId])
  ]);
  const scopeKey=p.rows[0]?.data?.tradeObjectId??companyId;
  return {scopeKey,basisHash:seedHash({rule:r.rows[0]?.seed_hash,scopeKey,calculationKey:i.rows[0]?.calculation_key})};
}

/** Preserve a pre-0.9.19 mark only on exactly the same basis. A newer explicit
 * action/bot mark always wins, including marks on carried-from action history. */
async function importLegacyActionAnswer(companyId:string,actionId:string,previous:any,basisHash:string) {
  if(!previous||previous.basis_hash!==basisHash)return false;
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
    if((await db.query('SELECT 1 FROM business_check_action_imports WHERE legacy_answer_id=$1',[previous.id])).rowCount){
      await db.query('COMMIT');return false;
    }
    const row=(await db.query(`SELECT i.* FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id
      WHERE a.id=$1 AND i.company_id=$2`,[actionId,companyId])).rows[0];
    if(!row||!await impactIsCurrent(row,db)||row.time_state!=='active'){
      await db.query('COMMIT');return false;
    }
    const latest=(await db.query(`WITH RECURSIVE chain AS (
      SELECT id,carried_from_action_id FROM action_items WHERE id=$1
      UNION SELECT a.id,a.carried_from_action_id FROM action_items a JOIN chain c ON a.id=c.carried_from_action_id
    ) SELECT max(l.created_at) AS at FROM audit_log l JOIN chain c ON c.id=l.entity_id
      WHERE l.company_id=$2 AND l.event_type='action.status'`,[actionId,companyId])).rows[0]?.at;
    const applied=['present','missing'].includes(previous.answer)&&(!latest||new Date(latest)<new Date(previous.created_at));
    if(applied)await setActionStatusInTransaction(db,{companyId,actionId,status:previous.answer==='present'?'completed':'open',
      actorId:previous.actor_id,origin:'legacy_check_import'});
    if(applied&&previous.answer==='present')await db.query(
      'UPDATE action_items SET completed_at=$2 WHERE id=$1',[actionId,previous.created_at]);
    await db.query(`INSERT INTO business_check_action_imports(legacy_answer_id,action_id,applied) VALUES($1,$2,$3)`,
      [previous.id,actionId,applied]);
    await db.query('COMMIT');return applied;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function listBusinessChecks(companyId:string) {
  let state=await listImpacts(companyId);
  const answers=(await getPool().query(`SELECT DISTINCT ON(check_key) * FROM business_check_answers
    WHERE company_id=$1 ORDER BY check_key,created_at DESC,id DESC`,[companyId])).rows;
  let imported=false;
  for(const {template,impact,checkKey,actionId} of businessCheckTemplates(state.impacts)) {
    if(template.kind!=='action'||!actionId||!checkAnswerAllowed(impact))continue;
    const previous=answers.find(a=>a.check_key===checkKey&&a.check_version===template.version);
    if(!previous)continue;
    const basis=await checkBasis(companyId,impact.ruleId,impact.ruleVersion,impact.id);
    if(await importLegacyActionAnswer(companyId,actionId,previous,basis.basisHash))imported=true;
  }
  if(imported)state=await listImpacts(companyId);
  const items=await Promise.all(businessCheckTemplates(state.impacts).map(async({template,impact,checkKey,actionId})=>{
    const basis=await checkBasis(companyId,impact.ruleId,impact.ruleVersion,impact.id);
    const previous=answers.find(a=>a.check_key===checkKey);
    const same=previous?.basis_hash===basis.basisHash&&previous?.check_version===template.version;
    const linkedAction=impact.actions.find(a=>a.id===actionId);
    const isAction=template.kind==='action';
    const canAnswer=checkAnswerAllowed(impact)&&(!isAction||!!linkedAction&&!linkedAction.reviewRequired);
    const clarification=impact.timeState==='upcoming'?'upcoming':impact.reviewState==='needs_review'?'review':
      isAction&&!linkedAction?'unavailable':'questions';
    return {checkKey,version:template.version,kind:template.kind,title:template.title,help:template.help,
      impactId:impact.id,ruleId:impact.ruleId,ruleVersion:impact.ruleVersion,timeState:impact.timeState,
      actionId:actionId??null,executionStatus:linkedAction?.executionStatus??null,
      sources:impact.rule.evidenceRefs,basisHash:basis.basisHash,
      state:!canAnswer?'clarify':isAction?actionCheckState(linkedAction?.executionStatus):same?previous.answer:'unchecked',
      needsRecheck:isAction?!!linkedAction?.reviewRequired:!!previous&&!same,canAnswer,
      answeredAt:isAction?linkedAction?.completedAt??null:same?previous.created_at:null,clarification};
  }));
  return {items,summary:summarizeBusinessChecks(items),
    refreshPending:state.refreshPending??false,refreshFailures:state.refreshFailures??0,coverage:{
    scope:'pilot_ecommerce',catalogueVersion:'shared-action-checks-v2',completeLegislationCoverage:false,
    warning:'Список зависит от ваших ответов и требований, которые есть в сервисе. Это не полный перечень документов для любой компании. Мы сохраняем ваши отметки и не читаем содержимое файлов.'
  }};
}

const AnswerSchema=z.object({requestId:z.string().uuid(),checkKey:z.string().min(1).max(600),
  impactId:z.string().min(1).max(300),basisHash:z.string().regex(/^[a-f0-9]{64}$/),
  answer:z.enum(['present','missing','unknown'])}).strict();

export async function answerBusinessCheck(companyId:string,actorId:string,value:unknown) {
  const body=AnswerSchema.parse(value),hash=seedHash(body);
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
    const old=(await db.query(`SELECT id,request_hash,answer FROM business_check_answers WHERE company_id=$1 AND request_id=$2
      UNION ALL SELECT id,request_hash,answer FROM business_check_action_requests WHERE company_id=$1 AND request_id=$2`,
      [companyId,body.requestId])).rows[0];
    if(old) {
      if(old.request_hash!==hash)throw new ReviewError('IDEMPOTENCY_CONFLICT',409);
      await db.query('COMMIT');return {id:old.id,answer:old.answer};
    }
    const row=(await db.query('SELECT * FROM impact_assessments WHERE id=$1 AND company_id=$2',[body.impactId,companyId])).rows[0];
    if(!row)throw new ReviewError('IMPACT_NOT_FOUND',404);
    if(!await impactIsCurrent(row,db))throw new ReviewError('CHECK_STALE',409);
    const impact=await getImpactById(companyId,body.impactId);
    if(!impact)throw new ReviewError('IMPACT_NOT_FOUND',404);
    const item=businessCheckTemplates([impact]).find(x=>x.checkKey===body.checkKey);
    if(!item)throw new ReviewError('CHECK_NOT_FOUND',404);
    if(!checkAnswerAllowed(impact))throw new ReviewError('CHECK_NOT_AVAILABLE',409);
    const basis=await checkBasis(companyId,impact.ruleId,impact.ruleVersion,impact.id,db);
    if(basis.basisHash!==body.basisHash)throw new ReviewError('CHECK_STALE',409);
    const id=randomUUID();
    if(item.template.kind==='action') {
      if(!item.actionId)throw new ReviewError('CHECK_NOT_AVAILABLE',409);
      if(body.answer==='unknown')throw new ReviewError('CHECK_ACTION_ANSWER_NOT_SUPPORTED',400);
      try {
        const result=await setActionStatusInTransaction(db,{companyId,actionId:item.actionId,
          status:body.answer==='present'?'completed':'open',actorId,origin:'checklist'});
        if(!result)throw new ReviewError('CHECK_NOT_FOUND',404);
      }catch(error){if(error instanceof Error&&error.message==='STALE_ACTION')throw new ReviewError('CHECK_STALE',409);throw error;}
      await db.query(`INSERT INTO business_check_action_requests(id,company_id,request_id,request_hash,action_id,check_key,answer)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,companyId,body.requestId,hash,item.actionId,body.checkKey,body.answer]);
    } else {
      await db.query(`INSERT INTO business_check_answers
        (id,company_id,request_id,request_hash,check_key,check_version,impact_id,rule_id,rule_version,basis_hash,scope_key,answer,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id,companyId,body.requestId,hash,body.checkKey,item.template.version,impact.id,impact.ruleId,impact.ruleVersion,basis.basisHash,basis.scopeKey,body.answer,actorId]);
      await db.query(`INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
        VALUES($1,'user',$2,'check.answered','business_check',$3,$4)`,
        [companyId,actorId,id,JSON.stringify({checkKey:body.checkKey,answer:body.answer,ruleId:impact.ruleId,ruleVersion:impact.ruleVersion})]);
    }
    await db.query('COMMIT');return {id,answer:body.answer};
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}

/** Startup reconciliation for existing installs. Unmatched/stale observations
 * remain immutable history; they are never coerced into current completion. */
export async function reconcileLegacyActionChecks() {
  const rows=(await getPool().query(`SELECT DISTINCT a.company_id FROM
    (SELECT DISTINCT ON(company_id,check_key) id,company_id FROM business_check_answers
      WHERE check_key LIKE 'rule-action:%'
      ORDER BY company_id,check_key,created_at DESC,id DESC) a
    WHERE NOT EXISTS (SELECT 1 FROM business_check_action_imports i WHERE i.legacy_answer_id=a.id)`)).rows;
  for(const row of rows)await listBusinessChecks(row.company_id);
  return rows.length;
}
