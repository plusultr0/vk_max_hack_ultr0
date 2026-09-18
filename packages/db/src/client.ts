import pg from 'pg';
import { getConfig } from '@reg/config';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
let pool: PgPool | null = null;

export function getPool(): PgPool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({ connectionString: config.DATABASE_URL });
    // An idle connection lost during a DB restart must not crash the process or
    // print the pg client (which includes connection credentials).
    pool.on('error', () => console.error('[db] idle connection lost; reconnecting on next query'));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
