import type { MaxUser } from '@reg/max';
import { getPool } from './client.js';

export async function upsertMaxIdentity(input: { user: MaxUser; chatId?: string | null }) {
  const maxUserId = String(input.user.user_id);
  const companyId = `company-max-${maxUserId}`;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO max_users (max_user_id, first_name, last_name, username, language_code, photo_url, raw, last_chat_id, bot_active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now())
       ON CONFLICT (max_user_id) DO UPDATE SET
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, username=EXCLUDED.username,
         language_code=EXCLUDED.language_code, photo_url=EXCLUDED.photo_url, raw=EXCLUDED.raw,
         last_chat_id=COALESCE(EXCLUDED.last_chat_id,max_users.last_chat_id), bot_active=true, updated_at=now()`,
      [maxUserId, input.user.first_name ?? null, input.user.last_name ?? null, input.user.username ?? null,
        input.user.language_code ?? null, input.user.photo_url ?? null, JSON.stringify(input.user), input.chatId ?? null],
    );
    await client.query(
      `INSERT INTO companies (id, owner_max_user_id, pilot_segment, updated_at)
       VALUES ($1,$2,'small_ecommerce',now())
       ON CONFLICT (id) DO UPDATE SET owner_max_user_id=EXCLUDED.owner_max_user_id, updated_at=now()`,
      [companyId, maxUserId],
    );
    await client.query('COMMIT');
    return { maxUserId, companyId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDevIdentity(devUserId = 'dev-user') {
  const companyId = `company-${devUserId}`;
  const pool = getPool();
  await pool.query(
    `INSERT INTO companies (id, owner_max_user_id, name, pilot_segment, updated_at)
     VALUES ($1,$2,'Demo company','small_ecommerce',now())
     ON CONFLICT DO NOTHING`,
    [companyId, devUserId],
  );
  const existing=await pool.query('SELECT id FROM companies WHERE owner_max_user_id=$1',[devUserId]);
  if(!existing.rowCount) throw new Error('DEV_COMPANY_NOT_FOUND');
  return { maxUserId: devUserId, companyId:existing.rows[0].id as string };
}

export async function updateBotChat(input: { maxUserId: string; chatId: string | null; active?: boolean }) {
  const pool = getPool();
  await pool.query(
    `UPDATE max_users SET last_chat_id=COALESCE($2,last_chat_id), bot_active=COALESCE($3,bot_active), updated_at=now()
     WHERE max_user_id=$1`,
    [input.maxUserId, input.chatId, input.active ?? null],
  );
}

export async function getMaxUser(maxUserId: string) {
  const result = await getPool().query('SELECT * FROM max_users WHERE max_user_id=$1', [maxUserId]);
  return result.rows[0] ?? null;
}
