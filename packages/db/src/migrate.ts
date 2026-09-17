import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

const migrationsDir = new URL('../migrations/', import.meta.url);

async function main() {
  const directory = fileURLToPath(migrationsDir);
  const files = (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  const pool = getPool();
  for (const file of files) {
    const sql = await readFile(fileURLToPath(new URL(file, migrationsDir)), 'utf8');
    await pool.query(sql);
    console.log(`Migration ${file} applied.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => closePool());
