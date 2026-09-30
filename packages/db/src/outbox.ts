import { randomUUID } from 'node:crypto';
import { getPool } from './client.js';
import { recalculateInTransaction, selectedRules } from './runtime.js';
import { LegalRuleSchema, ruleFactRequirements, periodWindow } from '@reg/domain';
import { targetCompanyPage } from './targeting.js';
import { seedHash } from './canonical.js';

// A short DB transaction fans out each event. No network call is held under a lock.
export async function expandPublicationOutbox() {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const event = (await db.query(`SELECT * FROM outbox_events WHERE status='pending' AND available_at<=now()
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!event) { await db.query('COMMIT'); return false; }
    if (!['review.published','rule.refresh'].includes(event.event_type)) {
      await db.query("UPDATE outbox_events SET status='failed',last_error='UNSUPPORTED_EVENT',updated_at=now() WHERE id=$1",[event.id]);
    } else {
      const refs=event.payload?.rules??[];
      const ruleRows=await db.query(`SELECT l.data FROM legal_rules l JOIN jsonb_to_recordset($1::jsonb) r("ruleId" text,version integer)
        ON l.rule_id=r."ruleId" AND l.version=r.version`,[JSON.stringify(refs)]);
      if(ruleRows.rowCount!==refs.length||!refs.length)throw new Error('OUTBOX_RULE_BUNDLE_INVALID');
      const rules=ruleRows.rows.map(r=>LegalRuleSchema.parse(r.data));
      const page=await targetCompanyPage(db,rules,event.fanout_cursor,500);
      if(page.companyIds.length)await db.query(`INSERT INTO company_recalculation_jobs(company_id,event_id,request_key,rule_ids)
        SELECT company_id,$1,$1 || ':' || company_id,$3::jsonb FROM unnest($2::text[]) company_id ON CONFLICT DO NOTHING`,
        [event.id,page.companyIds,JSON.stringify(rules.map(r=>r.ruleId))]);
      await db.query(`UPDATE outbox_events SET status=$2,fanout_cursor=COALESCE($3,fanout_cursor),
        attempts=attempts+1,updated_at=now() WHERE id=$1`,[event.id,page.companyIds.length===500?'pending':'processing',page.companyIds.at(-1)??null]);
    }
    await db.query('COMMIT'); return true;
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function processRecalculationJob() {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const job = (await db.query(`SELECT * FROM company_recalculation_jobs
      WHERE status IN ('pending','failed') AND attempts<8 AND available_at<=now()
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!job) { await db.query('COMMIT'); return false; }
    await db.query('UPDATE company_recalculation_jobs SET attempts=attempts+1 WHERE id=$1',[job.id]);
    await db.query('SAVEPOINT calculation');
    try {
      await recalculateInTransaction(db, job.company_id, job.event_id ? 'regulatory_update' : 'refresh', undefined, job.rule_ids??undefined);
      await db.query("UPDATE company_recalculation_jobs SET status='processed',processed_at=now(),last_error=NULL WHERE id=$1",[job.id]);
    } catch {
      await db.query('ROLLBACK TO SAVEPOINT calculation');
      // Do not store arbitrary SQL/provider messages that could expose personal data.
      await db.query(`UPDATE company_recalculation_jobs SET status='failed',last_error='RECALCULATION_FAILED',
        available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,attempts-1)::int)) WHERE id=$1`,[job.id]);
    }
    await db.query('COMMIT'); return true;
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function finishPublicationOutbox() {
  await getPool().query(`UPDATE outbox_events e SET status='processed',processed_at=now(),last_error=NULL,updated_at=now()
    WHERE e.status='processing' AND NOT EXISTS(SELECT 1 FROM company_recalculation_jobs j WHERE j.event_id=e.id AND j.status<>'processed')`);
  await getPool().query(`UPDATE outbox_events e SET last_error='COMPANY_RECALCULATION_FAILED',updated_at=now()
    WHERE e.status='processing' AND EXISTS(SELECT 1 FROM company_recalculation_jobs j WHERE j.event_id=e.id AND j.status='failed')`);
}

async function enqueueRuleClockRefreshes() {
  const now=new Date().toISOString(),rules=await selectedRules();
  const events=rules.map(s=>{
    const periods=ruleFactRequirements(s.rule).filter(r=>['month','quarter','calendar_year','previous_calendar_year','current_ytd'].includes(r.period.kind))
      .map(r=>({field:r.field,period:r.period.kind==='current_ytd'?now.slice(0,4):periodWindow(r.period,now.slice(0,10)).key}));
    return {id:randomUUID(),key:'rule-clock:'+s.rule.ruleId+':'+s.rule.version+':'+seedHash({state:s.timeState,effectiveOn:s.effectiveOn,periods}),
      payload:{reason:'clock_refresh',rules:[{ruleId:s.rule.ruleId,version:s.rule.version}]}};
  });
  // A bounded targeted outbox event per changed rule/period, not an unfiltered
  // million-company scan. NOT EXISTS prevents an old page from starving new work.
  await getPool().query(`INSERT INTO outbox_events(id,event_type,aggregate_id,payload,idempotency_key)
    SELECT e.id,'rule.refresh',NULL,e.payload,e.key FROM jsonb_to_recordset($1::jsonb) e(id text,key text,payload jsonb)
    WHERE NOT EXISTS(SELECT 1 FROM outbox_events old WHERE old.idempotency_key=e.key)
    ORDER BY e.key LIMIT 100 ON CONFLICT DO NOTHING`,[JSON.stringify(events)]);
}

export async function enqueueScheduledRecalculations() {
  await enqueueRuleClockRefreshes();
  // Only elapsed fact confirmations and version boundaries. Not every business
  // every hour. Profile creation is already queued by its existing DB trigger.
  await getPool().query(`INSERT INTO company_recalculation_jobs(company_id,request_key,rule_ids)
    SELECT f.company_id,'fact-expiry:'||f.observation_id||':'||d.rule_id||':'||d.rule_version,jsonb_build_array(d.rule_id)
    FROM company_fact_current f JOIN rule_fact_dependencies d ON d.fact_key=f.fact_key AND d.definition_version=f.definition_version
    JOIN legal_rules l ON l.rule_id=d.rule_id AND l.version=d.rule_version
    WHERE (f.fresh_until<=now() OR (d.requirement->>'maxAgeDays' IS NOT NULL
      AND f.confirmed_at+((d.requirement->>'maxAgeDays')::integer*interval '1 day')<=now()))
      AND l.review_status='reviewed'
      AND NOT EXISTS(SELECT 1 FROM company_recalculation_jobs j WHERE j.request_key='fact-expiry:'||f.observation_id||':'||d.rule_id||':'||d.rule_version)
    ORDER BY f.confirmed_at,f.company_id,d.rule_id LIMIT 500 ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO company_recalculation_jobs(company_id,request_key,rule_ids)
    SELECT i.company_id,'facts:'||i.id||':'||to_char(i.next_fact_check_at AT TIME ZONE 'UTC','YYYY-MM-DD-HH24-MI'),jsonb_build_array(i.rule_id)
    FROM impact_assessments i WHERE i.next_fact_check_at<=now()
    AND NOT EXISTS(SELECT 1 FROM impact_assessments n WHERE n.company_id=i.company_id AND n.rule_id=i.rule_id
      AND (n.created_at,n.id)>(i.created_at,i.id)) ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO company_recalculation_jobs(company_id,request_key,rule_ids)
    SELECT DISTINCT i.company_id,'boundary:'||i.company_id||':'||l.rule_id||':'||l.version||':'||current_date::text,jsonb_build_array(l.rule_id)
    FROM impact_assessments i JOIN legal_rules l ON l.rule_id=i.rule_id AND l.version=i.rule_version
    WHERE ((i.time_state='upcoming' AND l.valid_from<=current_date)
       OR (i.time_state='active' AND (l.valid_to<=current_date OR l.legal_status IN ('expired','repealed'))))
      AND NOT EXISTS(SELECT 1 FROM impact_assessments n WHERE n.company_id=i.company_id AND n.rule_id=i.rule_id
        AND n.rule_version=i.rule_version AND (n.created_at,n.id)>(i.created_at,i.id))
    ON CONFLICT DO NOTHING`);
}

export async function processPublicationDelivery(limit = 50) {
  for(let i=0;i<limit && await expandPublicationOutbox();i++) { /* durable fan-out */ }
  for(let i=0;i<limit && await processRecalculationJob();i++) { /* failures do not stop other companies */ }
  await finishPublicationOutbox();
}

export async function publicationDeliveryStatus(candidateId: string) {
  const result = await getPool().query(`SELECT p.id,p.revision,e.id AS event_id,e.status,e.attempts,e.last_error,e.processed_at,
    count(j.id)::int AS companies,count(j.id) FILTER(WHERE j.status='processed')::int AS completed,
    count(j.id) FILTER(WHERE j.status='failed')::int AS failed
    FROM review_publications p JOIN outbox_events e ON e.aggregate_id=p.id
    LEFT JOIN company_recalculation_jobs j ON j.event_id=e.id WHERE p.candidate_id=$1
    GROUP BY p.id,e.id`,[candidateId]);
  return result.rows[0] ?? null;
}

export async function retryPublicationDelivery(candidateId: string, actorId: string) {
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    const result=await db.query(`UPDATE company_recalculation_jobs j SET status='pending',attempts=0,available_at=now(),last_error=NULL
      FROM outbox_events e JOIN review_publications p ON p.id=e.aggregate_id
      WHERE j.event_id=e.id AND p.candidate_id=$1 AND j.status='failed' RETURNING j.id`,[candidateId]);
    await db.query(`INSERT INTO audit_log(actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES('admin',$1,'delivery.retry','legal_rule_candidate',$2,$3)`,[actorId,candidateId,JSON.stringify({jobs:result.rowCount})]);
    await db.query('COMMIT'); return { retried:result.rowCount };
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
