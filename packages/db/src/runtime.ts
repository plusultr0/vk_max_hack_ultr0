import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CompanyProfileSchema, LegalRuleSchema, selectRuleVersions, assessSelectedRule, type SelectedRule, type LegalRule, type CompanyProfile } from '@reg/domain';
import { getPool } from './client.js';
import { seedHash } from './canonical.js';

type Queryable = Pick<PoolClient,'query'>;
export const utcDay = () => new Date().toISOString().slice(0,10);
export const isoDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0,10) : value ? String(value).slice(0,10) : null;

function actionHash(rule: LegalRule, scope: string, profile: CompanyProfile, action: {
  actionKey: string; title: string; description: string; deadline: string | null; deadlineKind: string;
}) {
  const definition=rule.actions.find(a=>a.actionKey===action.actionKey);
  if(!definition) throw new Error('ACTION_DEFINITION_NOT_FOUND');
  return seedHash({ruleId:rule.ruleId,scope,context:scope==='trade_object'?profile.tradeObjectId:null,
    applicability:rule.applicability.condition,compliance:rule.compliance,title:action.title,
    description:action.description,when:definition.when,deadline:action.deadline,deadlineKind:action.deadlineKind});
}

export async function selectedRules(db: Queryable = getPool(), asOf = utcDay()): Promise<SelectedRule[]> {
  const rows = await db.query(`SELECT l.data, p.compilation->>'scope' AS scope,
    (SELECT max(r.effective_from) FROM regulatory_relations r WHERE r.to_rule_id=l.rule_id AND r.to_version=l.version) AS activation,
    EXISTS(SELECT 1 FROM regulatory_relations r WHERE r.to_rule_id=l.rule_id AND r.to_version=l.version AND r.relation_type='cancels') AS cancelled
    FROM legal_rules l LEFT JOIN review_publication_rules p ON p.rule_id=l.rule_id AND p.rule_version=l.version`);
  return selectRuleVersions(rows.rows.map(row => {
    const rule = LegalRuleSchema.parse(row.data);
    const activation=isoDate(row.activation) ?? rule.validFrom ?? '0001-01-01';
    return { rule, scope: row.scope === 'trade_object' || rule.tags.includes('scope:trade_object') ? 'trade_object' : 'company',
      effectiveOn: !row.cancelled && rule.validFrom && rule.validFrom>activation ? rule.validFrom : activation, cancelled: row.cancelled };
  }), asOf);
}

export async function impactIsCurrent(row: any, db: Queryable = getPool(), asOf = utcDay()) {
  const latest = await db.query('SELECT max(profile_version) AS version FROM company_profiles WHERE company_id=$1', [row.company_id]);
  if (latest.rows[0]?.version !== row.profile_version) return false;
  return (await selectedRules(db, asOf)).some(s => s.rule.ruleId === row.rule_id && s.rule.version === row.rule_version && s.timeState === row.time_state);
}

// Caller owns the transaction and holds the company row lock. Assessment,
// actions, notification intent and job completion must commit together.
export async function recalculateInTransaction(db: PoolClient, companyId: string, reason: string, asOf = utcDay()) {
  const company = (await db.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE', [companyId])).rows[0];
  if (!company) throw new Error('COMPANY_NOT_FOUND');
  const latest = (await db.query('SELECT data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1', [companyId])).rows[0];
  if (!latest) return [];
  const profile = CompanyProfileSchema.parse(latest.data);
  // Upgrade existing action history before considering carry-over. Preserve its
  // status; only derive identity from the original rule/profile, never the new one.
  const legacy=await db.query(`SELECT a.*,l.data AS rule_data,p.data AS profile_data,r.compilation->>'scope' AS scope
    FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id
    JOIN legal_rules l ON l.rule_id=i.rule_id AND l.version=i.rule_version
    JOIN company_profiles p ON p.company_id=i.company_id AND p.profile_version=i.profile_version
    LEFT JOIN review_publication_rules r ON r.rule_id=i.rule_id AND r.rule_version=i.rule_version
    WHERE i.company_id=$1 AND a.semantic_hash IS NULL`,[companyId]);
  for(const a of legacy.rows) {
    const original=LegalRuleSchema.parse(a.rule_data);
    if(!original.actions.some(definition=>definition.actionKey===a.action_key)) continue;
    const scope=a.scope==='trade_object'||original.tags.includes('scope:trade_object')?'trade_object':'company';
    const hash=actionHash(original,scope,CompanyProfileSchema.parse(a.profile_data),{
      actionKey:a.action_key,title:a.title,description:a.description,deadline:isoDate(a.deadline),deadlineKind:a.deadline_kind});
    await db.query('UPDATE action_items SET semantic_hash=$2 WHERE id=$1',[a.id,hash]);
  }
  const selections = await selectedRules(db, asOf);
  const currentIds: string[] = [];
  for (const selected of selections) {
    const rule = selected.rule;
    const existing = await db.query(`SELECT id FROM impact_assessments
      WHERE company_id=$1 AND profile_version=$2 AND rule_id=$3 AND rule_version=$4 AND time_state=$5`,
    [companyId, profile.profileVersion, rule.ruleId, rule.version, selected.timeState]);
    const evaluation = assessSelectedRule(selected, profile, asOf);
    const previous = (await db.query(`SELECT id FROM impact_assessments WHERE company_id=$1 AND rule_id=$2
      ORDER BY created_at DESC,id DESC LIMIT 1`, [companyId,rule.ruleId])).rows[0];
    const id = existing.rows[0]?.id ?? randomUUID(); currentIds.push(id);
    if(!existing.rowCount) await db.query(`INSERT INTO impact_assessments(id,company_id,profile_version,rule_id,rule_version,verdict,review_state,
      compliance_state,reasons,missing_fields,evidence_refs,review_reasons,effective_from,previous_assessment_id,time_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id,companyId,profile.profileVersion,rule.ruleId,rule.version,evaluation.verdict,evaluation.reviewState,
      evaluation.complianceState,JSON.stringify(evaluation.reasons),JSON.stringify(evaluation.missingFields),
      JSON.stringify(evaluation.evidenceRefs),JSON.stringify(evaluation.reviewReasons),evaluation.effectiveFrom,previous?.id ?? null,selected.timeState]);
    for (const action of evaluation.actions) {
      // Changes in obligation/condition/context/deadline break completion carry-over.
      const semanticHash = actionHash(rule,selected.scope,profile,action);
      const old = (await db.query(`SELECT a.* FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id
        WHERE i.company_id=$1 AND i.rule_id=$2 AND a.semantic_hash=$3 ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
      [companyId,rule.ruleId,semanticHash])).rows[0];
      const persisted=(await db.query(`INSERT INTO action_items(id,impact_id,action_key,title,description,deadline,deadline_kind,execution_status,
        completed_at,semantic_hash,carried_from_action_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(impact_id,action_key) DO UPDATE SET semantic_hash=COALESCE(action_items.semantic_hash,EXCLUDED.semantic_hash)
        RETURNING id,execution_status`,
      [randomUUID(),id,action.actionKey,action.title,action.description,action.deadline,action.deadlineKind,old?.execution_status ?? 'open',
        old?.completed_at ?? null,semanticHash,old?.id ?? null])).rows[0];
      const actionId=persisted.id;
      const owner = company.owner_max_user_id as string | null;
      if (owner && !owner.startsWith('dev-') && action.deadline && action.deadline >= asOf &&
          !['completed','dismissed'].includes(persisted.execution_status)) {
        const target = new Date(action.deadline + 'T09:00:00+03:00');
        const schedule = new Date(Math.max(Date.now(), target.getTime() - 3*86400_000));
        await db.query(`INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
          VALUES($1,$2,$3,'deadline_reminder',$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
        [randomUUID(),companyId,owner,'deadline:' + companyId + ':' + semanticHash,schedule.toISOString(),
          JSON.stringify({ actionId,impactId:id,ruleId:rule.ruleId,ruleVersion:rule.version,semanticHash,title:action.title,deadline:action.deadline })]);
        // Retarget a still-pending reminder when the same duty moves to a new profile.
        await db.query(`UPDATE notifications SET payload=$2,
          state=CASE WHEN state='cancelled' THEN 'pending' ELSE state END,terminal_at=NULL
          WHERE dedupe_key=$1 AND state IN ('pending','retry','cancelled')`,
        ['deadline:' + companyId + ':' + semanticHash, JSON.stringify({actionId,impactId:id,ruleId:rule.ruleId,ruleVersion:rule.version,semanticHash,title:action.title,deadline:action.deadline})]);
      }
    }
    const owner = company.owner_max_user_id as string | null;
    if (owner && !owner.startsWith('dev-') && selected.timeState === 'active' && evaluation.verdict === 'applies') {
      await db.query(`INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
        VALUES($1,$2,$3,'regulatory_update',$4,now(),$5) ON CONFLICT(dedupe_key) DO NOTHING`,
      [randomUUID(),companyId,owner,'regulatory:' + companyId + ':' + rule.ruleId + ':' + rule.version,
        JSON.stringify({ impactId:id,ruleId:rule.ruleId,ruleVersion:rule.version,title:rule.userTitle })]);
      await db.query(`UPDATE notifications SET payload=$2,
        state=CASE WHEN state='cancelled' THEN 'pending' ELSE state END,terminal_at=NULL
        WHERE dedupe_key=$1 AND state IN ('pending','retry','cancelled')`,
      ['regulatory:' + companyId + ':' + rule.ruleId + ':' + rule.version,
        JSON.stringify({impactId:id,ruleId:rule.ruleId,ruleVersion:rule.version,title:rule.userTitle})]);
    }
    if(!existing.rowCount) await db.query(`INSERT INTO audit_log(company_id,actor_type,event_type,entity_type,entity_id,data)
      VALUES($1,'system',$2,'impact_assessment',$3,$4)`,
    [companyId,'impact.'+reason,id,JSON.stringify({ruleId:rule.ruleId,ruleVersion:rule.version,profileVersion:profile.profileVersion,timeState:selected.timeState})]);
  }
  await db.query(`UPDATE action_items a SET review_required=true,review_reason='Основание или профиль изменились; действие осталось в истории'
    FROM impact_assessments i WHERE a.impact_id=i.id AND i.company_id=$1 AND NOT(i.id=ANY($2::text[]))
    AND a.execution_status IN ('open','in_progress')`, [companyId,currentIds]);
  await db.query(`UPDATE notifications SET state='cancelled',terminal_at=now(),claim_token=NULL,claimed_at=NULL
    WHERE company_id=$1 AND state IN ('pending','retry') AND payload ? 'impactId'
    AND NOT(payload->>'impactId'=ANY($2::text[]))`, [companyId,currentIds]);
  return currentIds;
}

export async function recalculateCompanyAtomic(companyId: string, reason = 'manual', asOf = utcDay()) {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const ids = await recalculateInTransaction(db, companyId, reason, asOf);
    await db.query('COMMIT'); return ids;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
