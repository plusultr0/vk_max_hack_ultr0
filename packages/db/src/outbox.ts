import { getPool } from './client.js';
import { recalculateInTransaction } from './runtime.js';

// A short DB transaction fans out each event. No network call is held under a lock.
export async function expandPublicationOutbox() {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const event = (await db.query(`SELECT * FROM outbox_events WHERE status='pending' AND available_at<=now()
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!event) { await db.query('COMMIT'); return false; }
    if (event.event_type !== 'review.published') {
      await db.query("UPDATE outbox_events SET status='failed',last_error='UNSUPPORTED_EVENT',updated_at=now() WHERE id=$1",[event.id]);
    } else {
      await db.query(`INSERT INTO company_recalculation_jobs(company_id,event_id,request_key)
        SELECT DISTINCT company_id,$1,$1 || ':' || company_id FROM company_profiles ON CONFLICT DO NOTHING`,[event.id]);
      await db.query("UPDATE outbox_events SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1",[event.id]);
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
      await recalculateInTransaction(db, job.company_id, job.event_id ? 'regulatory_update' : 'refresh');
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

export async function enqueueScheduledRecalculations() {
  // UTC hour boundary: activations/expiry are re-evaluated after restarts too.
  await getPool().query(`INSERT INTO company_recalculation_jobs(company_id,request_key)
    SELECT DISTINCT company_id,'clock:' || company_id || ':' || to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD-HH24')
    FROM company_profiles ON CONFLICT DO NOTHING`);
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
