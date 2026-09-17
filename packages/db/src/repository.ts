import { LegalRuleSchema, DemoProfileFixtureSchema } from '@reg/domain';
import { getPool } from './client.js';

export async function getDemoCatalog() {
  const pool = getPool();
  const [profiles, rules] = await Promise.all([
    pool.query('SELECT fixture_id, data FROM demo_profile_fixtures ORDER BY fixture_id'),
    pool.query('SELECT rule_id, version, data FROM legal_rules ORDER BY rule_id, version DESC'),
  ]);

  const latest = new Map<string, { ruleId: string; version: number; userTitle: string }>();
  for (const row of rules.rows) {
    if (!latest.has(row.rule_id)) {
      const rule = LegalRuleSchema.parse(row.data);
      latest.set(row.rule_id, { ruleId: rule.ruleId, version: rule.version, userTitle: rule.userTitle });
    }
  }

  return {
    profiles: profiles.rows.map((row) => ({
      fixtureId: row.fixture_id as string,
      profileVersion: DemoProfileFixtureSchema.parse(row.data).profileVersion,
    })),
    rules: [...latest.values()],
  };
}

export async function getDemoProfile(fixtureId: string) {
  const pool = getPool();
  const result = await pool.query('SELECT data FROM demo_profile_fixtures WHERE fixture_id = $1', [fixtureId]);
  if (result.rowCount === 0) return null;
  return DemoProfileFixtureSchema.parse(result.rows[0].data);
}

export async function getLegalRule(ruleId: string, version?: number) {
  const pool = getPool();
  const result = version
    ? await pool.query('SELECT data FROM legal_rules WHERE rule_id = $1 AND version = $2', [ruleId, version])
    : await pool.query('SELECT data FROM legal_rules WHERE rule_id = $1 ORDER BY version DESC LIMIT 1', [ruleId]);
  if (result.rowCount === 0) return null;
  return LegalRuleSchema.parse(result.rows[0].data);
}
