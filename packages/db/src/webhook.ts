import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { seedHash } from './canonical.js';
import { getPool } from './client.js';

export const BotEventSchema=z.object({
  update_type:z.enum(['bot_started','bot_stopped','dialog_removed']),
  timestamp:z.number().int().nonnegative(),
  chat_id:z.union([z.number().int(),z.string().min(1)]).optional(),
  user:z.object({user_id:z.union([z.number().int(),z.string().min(1)]),first_name:z.string().optional()}).passthrough(),
  payload:z.string().max(1000).optional(),
}).passthrough();
export async function acceptBotEvent(value:unknown) {
  const update=BotEventSchema.parse(value), eventKey=seedHash(update), userId=String(update.user.user_id), companyId='company-max-'+userId;
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    const inserted=await db.query('INSERT INTO bot_webhook_events(event_key,update_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_key',[eventKey,update.update_type]);
    if(!inserted.rowCount){await db.query('COMMIT');return {ok:true,duplicate:true};}
    const active=update.update_type==='bot_started';
    await db.query(`INSERT INTO max_users(max_user_id,first_name,raw,last_chat_id,bot_active)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(max_user_id) DO UPDATE SET last_chat_id=COALESCE(EXCLUDED.last_chat_id,max_users.last_chat_id),
      bot_active=EXCLUDED.bot_active,updated_at=now()`,[userId,update.user.first_name??null,JSON.stringify(update.user),update.chat_id??null,active]);
    await db.query(`INSERT INTO companies(id,owner_max_user_id,pilot_segment) VALUES($1,$2,'small_ecommerce') ON CONFLICT DO NOTHING`,[companyId,userId]);
    if(active) await db.query(`INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
      VALUES($1,$2,$3,'bot_welcome',$4,now(),$5) ON CONFLICT DO NOTHING`,
    [randomUUID(),companyId,userId,'welcome:'+eventKey,JSON.stringify({startParam:update.payload??'home'})]);
    await db.query('COMMIT');return {ok:true,duplicate:false};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
