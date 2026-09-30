import type { PoolClient } from 'pg';
import { getPool } from './client.js';
import { impactIsCurrent } from './runtime.js';

export type ActionStatusInput = {
  companyId:string;actionId:string;status:'open'|'in_progress'|'completed'|'dismissed';
  actorId?:string;origin?:'card_or_bot'|'checklist'|'legacy_check_import';
};

/** Caller holds the company lock. One mutation path for card, bot and checklist. */
export async function setActionStatusInTransaction(db:PoolClient,input:ActionStatusInput) {
  const row=(await db.query(`SELECT i.*,a.execution_status,a.review_required FROM action_items a
    JOIN impact_assessments i ON i.id=a.impact_id
    WHERE a.id=$1 AND i.company_id=$2 FOR UPDATE OF a`,[input.actionId,input.companyId])).rows[0];
  if(!row)return null;
  if(!await impactIsCurrent(row,db)||row.time_state!=='active'||row.verdict!=='applies'||
    row.review_state==='needs_review'||row.review_required||(row.missing_fields??[]).length)
    throw new Error('STALE_ACTION');
  const result=await db.query(`UPDATE action_items SET execution_status=$2,
    completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,now()) ELSE NULL END
    WHERE id=$1 RETURNING *`,[input.actionId,input.status]);
  await db.query(`INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
    VALUES($1,'user',$2,'action.status','action_item',$3,$4)`,[input.companyId,input.actorId??null,
    input.actionId,JSON.stringify({status:input.status,origin:input.origin??'card_or_bot'})]);
  if(['completed','dismissed'].includes(input.status))await db.query(`UPDATE notifications SET state='cancelled',terminal_at=now()
    WHERE company_id=$1 AND payload->>'actionId'=$2 AND state IN ('pending','retry')`,[input.companyId,input.actionId]);
  else await db.query(`UPDATE notifications SET state='pending',terminal_at=NULL
    WHERE company_id=$1 AND payload->>'actionId'=$2 AND state='cancelled' AND sent_at IS NULL`,[input.companyId,input.actionId]);
  return result.rows[0];
}

export async function updateActionStatus(input:ActionStatusInput) {
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[input.companyId]);
    const result=await setActionStatusInTransaction(db,input);
    await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
