import pg from 'pg';
import { getConfig } from '@reg/config';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
let pool: PgPool | null = null;

export function getPool(): PgPool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({ connectionString: config.DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
