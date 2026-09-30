import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LegalActSchema, LegalRuleSchema, DemoProfileFixtureSchema } from '@reg/domain';
import { getPool, closePool } from './client.js';
import { seedHash } from './canonical.js';
import { installFactDefinitions, registerRuleDependencies } from './facts.js';

const seedDir = new URL('../../../seed/v1/', import.meta.url);

async function readJson<T>(name: string): Promise<T> {
  const text = await readFile(fileURLToPath(new URL(name, seedDir)), 'utf8');
  return JSON.parse(text) as T;
}

async function main() {
  const manifest = await readJson<{ seedVersion: string }>('manifest.json');
  const rawActs = await readJson<unknown[]>('legal-acts.json');
  const rawRules = await readJson<Record<string, unknown>[]>('legal-rules.json');
  const rawProfiles = await readJson<Record<string, unknown>[]>('profile-fixtures.json');
  const expected = await readJson<Array<{ fixtureKey: string; [key: string]: unknown }>>('expected-assessments.json');
  const relations = await readJson<Array<Record<string, unknown>>>('regulatory-relations.json');

  const acts = rawActs.map((item) => LegalActSchema.parse(item));
  const rules = rawRules.map((item) => {
    const hash = seedHash(item);
    return LegalRuleSchema.parse({ ...item, seedHash: hash });
  });
  const profiles = rawProfiles.map((item) => DemoProfileFixtureSchema.parse(item));

  const pool = getPool();
  const client = await pool.connect();
  let createdActs = 0;
  let createdRules = 0;
  let createdProfiles = 0;
  let conflicts = 0;

  try {
    await client.query('BEGIN');

    for (const act of acts) {
      const existing = await client.query('SELECT 1 FROM legal_acts WHERE act_id = $1', [act.actId]);
      if (existing.rowCount === 0) createdActs += 1;
      await client.query(
        `INSERT INTO legal_acts (
          act_id, title, number, issuer, publication_date, official_url,
          retrieved_at, verification_status, raw_text_hash, data, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        ON CONFLICT (act_id) DO UPDATE SET
          title = EXCLUDED.title,
          number = EXCLUDED.number,
          issuer = EXCLUDED.issuer,
          publication_date = EXCLUDED.publication_date,
          official_url = EXCLUDED.official_url,
          retrieved_at = EXCLUDED.retrieved_at,
          verification_status = EXCLUDED.verification_status,
          raw_text_hash = EXCLUDED.raw_text_hash,
          data = EXCLUDED.data,
          updated_at = now()`,
        [
          act.actId,
          act.title,
          act.number,
          act.issuer,
          act.publicationDate,
          act.officialUrl,
          act.retrievedAt,
          act.verificationStatus,
          act.rawTextHash ?? null,
          JSON.stringify(act),
        ],
      );
    }

    const factDefinitions = rules.flatMap((rule) => rule.factModel?.definitions ?? []);
    if (factDefinitions.length) {
      await installFactDefinitions(client, factDefinitions, 'human');
    }

    for (const rule of rules) {
      const existing = await client.query(
        'SELECT seed_hash FROM legal_rules WHERE rule_id = $1 AND version = $2',
        [rule.ruleId, rule.version],
      );
      if (existing.rowCount && existing.rows[0].seed_hash !== rule.seedHash) {
        conflicts += 1;
        throw new Error(`IMMUTABLE_RULE_VERSION_CONFLICT:${rule.ruleId}@${rule.version}`);
      }
      if (existing.rowCount === 0) {
        await client.query(
          `INSERT INTO legal_rules (
            rule_id, version, act_id, seed_hash, legal_status, review_status,
            valid_from, valid_to, checked_at, data
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            rule.ruleId,
            rule.version,
            rule.actId,
            rule.seedHash,
            rule.legalStatus,
            rule.reviewStatus,
            rule.validFrom,
            rule.validTo,
            rule.checkedAt,
            JSON.stringify(rule),
          ],
        );
        createdRules += 1;
      }
      await registerRuleDependencies(client, rule);
    }

    for (const relation of relations) {
      await client.query(
        `INSERT INTO regulatory_relations (
          from_rule_id, from_version, to_rule_id, to_version, relation_type,
          effective_from, evidence_ref, is_synthetic
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING`,
        [
          relation.fromRuleId,
          relation.fromVersion,
          relation.toRuleId,
          relation.toVersion,
          relation.relationType,
          relation.effectiveFrom ?? null,
          relation.evidenceRef ?? null,
          relation.isSynthetic ?? false,
        ],
      );
    }

    for (const profile of profiles) {
      const fixtureId = profile.fixtureId;
      if (!fixtureId) throw new Error('Every demo profile must have fixtureId');
      const existing = await client.query('SELECT 1 FROM demo_profile_fixtures WHERE fixture_id = $1', [fixtureId]);
      if (existing.rowCount === 0) createdProfiles += 1;
      await client.query(
        `INSERT INTO demo_profile_fixtures (fixture_id, seed_version, data, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (fixture_id) DO UPDATE SET seed_version = EXCLUDED.seed_version, data = EXCLUDED.data, updated_at = now()`,
        [fixtureId, manifest.seedVersion, JSON.stringify(profile)],
      );
    }

    for (const item of expected) {
      await client.query(
        `INSERT INTO demo_expected_assessments (fixture_key, seed_version, data, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (fixture_key) DO UPDATE SET seed_version = EXCLUDED.seed_version, data = EXCLUDED.data, updated_at = now()`,
        [item.fixtureKey, manifest.seedVersion, JSON.stringify(item)],
      );
    }

    await client.query(
      `INSERT INTO seed_execution_log (
        seed_version, status, created_acts, created_rules, created_profiles, conflicts, details
      ) VALUES ($1,'success',$2,$3,$4,$5,$6)`,
      [
        manifest.seedVersion,
        createdActs,
        createdRules,
        createdProfiles,
        conflicts,
        JSON.stringify({ rules: rules.length, profiles: profiles.length }),
      ],
    );

    await client.query('COMMIT');
    console.log(JSON.stringify({
      seedVersion: manifest.seedVersion,
      createdActs,
      createdRules,
      createdProfiles,
      conflicts,
      status: createdActs + createdRules + createdProfiles === 0 ? 'success/no-op' : 'success',
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
