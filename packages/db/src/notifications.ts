import { randomUUID } from 'node:crypto';
import { getPool } from './client.js';

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function reminderAt(deadline: string): Date | null {
  const target = new Date(`${deadline}T09:00:00+03:00`);
  if (Number.isNaN(target.getTime())) return null;
  const threeDays = new Date(target.getTime() - 3 * 24 * 60 * 60 * 1000);
  const now = new Date();
  if (target <= now) return null;
  return threeDays > now ? threeDays : now;
}

export async function scheduleDeadlineRemindersForCompany(companyId: string) {
  const result = await getPool().query(
    `SELECT ai.id AS action_id, ai.title, ai.deadline, ia.rule_id, c.owner_max_user_id
     FROM action_items ai
     JOIN impact_assessments ia ON ia.id=ai.impact_id
     JOIN companies c ON c.id=ia.company_id
     WHERE ia.company_id=$1 AND ai.deadline IS NOT NULL
       AND ai.execution_status IN ('open','in_progress') AND ai.review_required=false`,
    [companyId],
  );
  let created = 0;
  for (const row of result.rows) {
    if (!row.owner_max_user_id || String(row.owner_max_user_id).startsWith('dev-')) continue;
    const deadline = toIsoDate(row.deadline);
    if (!deadline) continue;
    const scheduled = reminderAt(deadline);
    if (!scheduled) continue;
    const dedupeKey = `deadline:${companyId}:${row.action_id}:${deadline}`;
    const insert = await getPool().query(
      `INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
       VALUES($1,$2,$3,'deadline_reminder',$4,$5,$6)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [randomUUID(), companyId, row.owner_max_user_id, dedupeKey, scheduled.toISOString(), JSON.stringify({
        actionId: row.action_id,
        ruleId: row.rule_id,
        deadline,
        title: row.title,
      })],
    );
    if (insert.rowCount) created += 1;
  }
  return { created };
}

export async function scheduleRegulatoryUpdateNotification(input: {
  companyId: string;
  ruleId: string;
  ruleVersion: number;
  impactId: string;
  userTitle: string;
}) {
  const user = await getPool().query('SELECT owner_max_user_id FROM companies WHERE id=$1', [input.companyId]);
  const maxUserId = user.rows[0]?.owner_max_user_id as string | undefined;
  if (!maxUserId || maxUserId.startsWith('dev-')) return { created: false };
  const dedupeKey = `regulatory:${input.companyId}:${input.ruleId}:${input.ruleVersion}`;
  const result = await getPool().query(
    `INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
     VALUES($1,$2,$3,'regulatory_update',$4,now(),$5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [randomUUID(), input.companyId, maxUserId, dedupeKey, JSON.stringify({
      impactId: input.impactId,
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      title: input.userTitle,
    })],
  );
  return { created: Boolean(result.rowCount) };
}

export async function recoverStaleNotifications() {
  const result = await getPool().query(
    `UPDATE notifications SET state='retry', claimed_at=NULL, updated_at=now(),
       last_error=COALESCE(last_error,'stale sending claim recovered')
     WHERE state='sending' AND claimed_at < now() - interval '10 minutes'
     RETURNING id`,
  );
  return result.rowCount ?? 0;
}

export async function claimDueNotification() {
  const result = await getPool().query(
    `WITH picked AS (
       SELECT id FROM notifications
       WHERE state IN ('pending','retry') AND scheduled_at <= now()
       ORDER BY scheduled_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE notifications n SET state='sending', claimed_at=now(), attempts=n.attempts+1, updated_at=now()
     FROM picked WHERE n.id=picked.id
     RETURNING n.*`,
  );
  return result.rows[0] ?? null;
}

export async function markNotificationSent(id: string) {
  await getPool().query(
    `UPDATE notifications SET state='sent', sent_at=now(), claimed_at=NULL, updated_at=now(), last_error=NULL WHERE id=$1`,
    [id],
  );
}

export async function markNotificationFailed(id: string, error: string) {
  const current = await getPool().query('SELECT attempts FROM notifications WHERE id=$1', [id]);
  if (!current.rowCount) return;
  const attempts = Number(current.rows[0].attempts ?? 0);
  if (attempts >= 5) {
    await getPool().query(
      `UPDATE notifications SET state='failed', terminal_at=now(), claimed_at=NULL, last_error=$2, updated_at=now() WHERE id=$1`,
      [id, error.slice(0, 2000)],
    );
  } else {
    await getPool().query(
      `UPDATE notifications SET state='retry', scheduled_at=now()+interval '5 minutes', claimed_at=NULL, last_error=$2, updated_at=now() WHERE id=$1`,
      [id, error.slice(0, 2000)],
    );
  }
}

export async function listNotifications(companyId: string, limit = 100) {
  const result = await getPool().query(
    `SELECT id,type,state,scheduled_at,attempts,last_error,payload,sent_at,created_at
     FROM notifications WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit],
  );
  return result.rows;
}
