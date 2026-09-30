import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';
import { reconcileLegacyActionChecks } from './business-checks.js';

// Earlier archives replayed all migrations on each startup. A journal is now
// required: replaying 010 would recreate an obsolete assessment uniqueness rule.
const legacyProbes:Record<string,string>={
  '001':'SELECT to_regclass(\'companies\') IS NOT NULL AS ok',
  '002':"SELECT to_regclass('max_users') IS NOT NULL AS ok",
  '003':"SELECT to_regclass('company_profile_drafts') IS NOT NULL AS ok",
  '004':"SELECT to_regclass('impact_feedback') IS NOT NULL AS ok",
  '005':"SELECT to_regclass('notifications') IS NOT NULL AS ok",
  '006':"SELECT to_regclass('source_documents') IS NOT NULL AS ok",
  '007':"SELECT to_regclass('source_snapshots') IS NOT NULL AS ok",
  '008':"SELECT to_regclass('review_revisions') IS NOT NULL AS ok",
  '009':"SELECT to_regclass('outbox_events') IS NOT NULL AS ok",
  '010':"SELECT to_regclass('extraction_jobs') IS NOT NULL AS ok",
};
async function main() {
  const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
  const files=(await readdir(directory)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  const db=await getPool().connect();
  try {
    await db.query("SELECT pg_advisory_lock(hashtext('regcontrol:migrations'))");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),legacy_baseline BOOLEAN NOT NULL DEFAULT false)');
    for(const file of files) {
      if((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).rowCount)continue;
      const probe=legacyProbes[file.slice(0,3)];
      if(probe&&(await db.query(probe)).rows[0]?.ok) {
        await db.query('INSERT INTO schema_migrations(name,legacy_baseline) VALUES($1,true)',[file]);
        console.log('Recorded existing migration',file);continue;
      }
      const sql=await readFile(directory+'/'+file,'utf8');
      await db.query('BEGIN');
      try {
        // Uniform transaction ownership, including older scripts with BEGIN/COMMIT.
        await db.query(sql.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,''));
        await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
        await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}
      console.log('Applied migration',file);
    }
  }finally{await db.query("SELECT pg_advisory_unlock(hashtext('regcontrol:migrations'))");db.release();}
  const checked=await reconcileLegacyActionChecks();
  if(checked)console.log('Reconciled legacy action check companies:',checked);
}
main().catch(()=>{console.error('MIGRATION_FAILED: inspect the database with your administrator; credentials are not logged.');process.exitCode=1;}).finally(closePool);
