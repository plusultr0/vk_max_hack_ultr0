import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CompanyProfileSchema, LegalRuleSchema, selectRuleVersions, assessSelectedRule, type SelectedRule, type LegalRule, type CompanyProfile, type FactResolution } from '@reg/domain';
import { getPool } from './client.js';
import { seedHash } from './canonical.js';
import { loadFactObservations, syncBuiltinProfileFacts, registerRuleDependencies } from './facts.js';
import { evaluateWithFacts } from './fact-evaluation.js';

type Queryable = Pick<PoolClient,'query'>;
export const utcDay = () => new Date().toISOString().slice(0,10);
export const isoDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0,10) : value ? String(value).slice(0,10) : null;

export function actionHash(rule: LegalRule, scope: string, profile: CompanyProfile, action: {
  actionKey: string; title: string; description: string; deadline: string | null; deadlineKind: string;
}, resolutions:FactResolution[]=[]) {
  const definition=rule.actions.find(a=>a.actionKey===action.actionKey);
  if(!definition) throw new Error('ACTION_DEFINITION_NOT_FOUND');
  return seedHash({ruleId:rule.ruleId,scope,context:scope==='trade_object'?profile.tradeObjectId:null,
    applicability:rule.applicability.condition,compliance:rule.compliance,title:action.title,
    description:action.description,when:definition.when,deadline:action.deadline,deadlineKind:action.deadlineKind,
    ...(rule.factModel?{factSemantics:{requirements:rule.factModel.requiredFacts,definitions:rule.factModel.definitions.map(d=>({key:d.key,version:d.version,type:d.type,scope:d.scope,semanticKey:d.semanticKey,unit:d.unit})),
      periods:resolutions.filter(r=>r.requirement.period.kind!=='none').map(r=>({key:r.requirement.key,period:r.requirement.period.kind==='current_ytd'?{year:r.window.start}:r.window}))}}:{})});
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
  const latest = (await db.query('SELECT profile_version,data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1', [row.company_id])).rows[0];
  if (!latest || row.profile_version !== latest.profile_version) return false;
  const selected = (await selectedRules(db,asOf)).find(s=>s.rule.ruleId===row.rule_id&&s.rule.version===row.rule_version&&s.timeState===row.time_state);
  if(!selected)return false;
  // Pre-S9.9 assessments do not prove per-fact freshness. Preserve as history
  // until the worker produces a calculation-keyed replacement.
  if(!row.calculation_key||row.calculation_key==='legacy')return false;
  const observations=await loadFactObservations(row.company_id,db);
  const now=asOf===utcDay()?new Date().toISOString():asOf+'T12:00:00.000Z';
  return evaluateWithFacts(selected,CompanyProfileSchema.parse(latest.data),observations,row.company_id,now).calculationKey===row.calculation_key;
}

// Caller owns the transaction and holds the company row lock. Assessment,
// actions, notification intent and job completion must commit together.
export async function recalculateInTransaction(db: PoolClient, companyId: string, reason: string, asOf = utcDay(), onlyRuleIds?: string[]) {
  const company = (await db.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE', [companyId])).rows[0];
  const seenJobIds = !onlyRuleIds ? (await db.query(
    "SELECT id FROM company_recalculation_jobs WHERE company_id=$1 AND status<>'processed'",[companyId])).rows.map(r=>r.id) : [];
  if (!company) throw new Error('COMPANY_NOT_FOUND');
  const latest = (await db.query('SELECT data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1', [companyId])).rows[0];
  if (!latest) return [];
  const profile = CompanyProfileSchema.parse(latest.data);
  await syncBuiltinProfileFacts(db,companyId);
  const observations=await loadFactObservations(companyId,db);
  const evaluationNow=asOf===utcDay()?new Date().toISOString():asOf+'T12:00:00.000Z';
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
  const selections = (await selectedRules(db, asOf)).filter(s=>!onlyRuleIds||onlyRuleIds.includes(s.rule.ruleId));
  const currentIds: string[] = [];
  for (const selected of selections) {
    const rule = selected.rule;
    await registerRuleDependencies(db,rule);
    const factEvaluation=evaluateWithFacts(selected,profile,observations,companyId,evaluationNow);
    const existing = await db.query(`SELECT id FROM impact_assessments
      WHERE company_id=$1 AND profile_version=$2 AND rule_id=$3 AND rule_version=$4 AND time_state=$5 AND calculation_key=$6
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [companyId,profile.profileVersion,rule.ruleId,rule.version,selected.timeState,factEvaluation.calculationKey]);
    const evaluation = factEvaluation.evaluation;
    const previous = (await db.query(`SELECT id FROM impact_assessments WHERE company_id=$1 AND rule_id=$2
      ORDER BY created_at DESC,id DESC LIMIT 1`, [companyId,rule.ruleId])).rows[0];
    const id = existing.rows[0]?.id ?? randomUUID(); currentIds.push(id);
    if(!existing.rowCount) await db.query(`INSERT INTO impact_assessments(id,company_id,profile_version,rule_id,rule_version,verdict,review_state,
      compliance_state,reasons,missing_fields,evidence_refs,review_reasons,effective_from,previous_assessment_id,time_state,calculation_key,fact_context,clarification_state,next_fact_check_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id,companyId,profile.profileVersion,rule.ruleId,rule.version,evaluation.verdict,evaluation.reviewState,
      evaluation.complianceState,JSON.stringify(evaluation.reasons),JSON.stringify(evaluation.missingFields),
      JSON.stringify(evaluation.evidenceRefs),JSON.stringify(evaluation.reviewReasons),evaluation.effectiveFrom,previous?.id ?? null,selected.timeState,factEvaluation.calculationKey,JSON.stringify(factEvaluation.context),factEvaluation.clarificationState,factEvaluation.nextFactCheckAt]);
    for (const action of evaluation.actions) {
      // Changes in obligation/condition/context/deadline break completion carry-over.
      const semanticHash = actionHash(rule,selected.scope,profile,action,factEvaluation.resolutions);
      const old = (await db.query(`SELECT a.* FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id
        WHERE i.company_id=$1 AND i.rule_id=$2 AND a.semantic_hash=$3 ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
      [companyId,rule.ruleId,semanticHash])).rows[0];
      const persisted=(await db.query(`INSERT INTO action_items(id,impact_id,action_key,title,description,deadline,deadline_kind,execution_status,
        completed_at,semantic_hash,carried_from_action_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(impact_id,action_key) DO UPDATE SET
        semantic_hash=COALESCE(action_items.semantic_hash,EXCLUDED.semantic_hash),
        review_required=false,review_reason=NULL
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
    if(!existing.rowCount) await db.query(`INSERT INTO audit_log(company_id,actor_type,event_type,entity_type,entity_id,data)
      VALUES($1,'system',$2,'impact_assessment',$3,$4)`,
    [companyId,'impact.'+reason,id,JSON.stringify({ruleId:rule.ruleId,ruleVersion:rule.version,profileVersion:profile.profileVersion,timeState:selected.timeState})]);
  }
  // HOTFIX_0_9_19_6_REGULATORY_REPAIR
  // A regulatory publication recalculation must restore lost notification intent
  // for the exact assessments selected by this same transaction. currentIds is the
  // authoritative result set here: it contains both newly-created and already-
  // existing assessments and avoids a second identity lookup that can drift.
  const owner = company.owner_max_user_id as string | null;
  if(reason==='regulatory_update' && owner && !owner.startsWith('dev-') && currentIds.length) {
    const currentNotices=await db.query(`SELECT i.id AS impact_id,i.rule_id,i.rule_version,i.verdict,i.missing_fields,
        l.data->>'userTitle' AS title
      FROM impact_assessments i
      JOIN legal_rules l ON l.rule_id=i.rule_id AND l.version=i.rule_version
      WHERE i.company_id=$1 AND i.id=ANY($2::text[]) AND i.profile_version=$3
        AND i.time_state='active' AND i.verdict IN ('applies','needs_info')`,
    [companyId,currentIds,profile.profileVersion]);
    for(const notice of currentNotices.rows) {
      const dedupeKey='regulatory:' + companyId + ':' + notice.rule_id + ':' + notice.rule_version;
      const payload=JSON.stringify({impactId:notice.impact_id,ruleId:notice.rule_id,ruleVersion:notice.rule_version,title:notice.title,
        verdict:notice.verdict,needsInfo:notice.verdict==='needs_info'||(notice.missing_fields??[]).length>0});
      await db.query(`INSERT INTO notifications(id,company_id,max_user_id,type,dedupe_key,scheduled_at,payload)
        VALUES($1,$2,$3,'regulatory_update',$4,now(),$5)
        ON CONFLICT(dedupe_key) DO UPDATE SET max_user_id=EXCLUDED.max_user_id,payload=EXCLUDED.payload,
          state=CASE WHEN notifications.state='cancelled' THEN 'pending' ELSE notifications.state END,
          terminal_at=CASE WHEN notifications.state='cancelled' THEN NULL ELSE notifications.terminal_at END`,
      [randomUUID(),companyId,owner,dedupeKey,payload]);
    }
  }
  await db.query(`UPDATE action_items a SET review_required=true,review_reason='Основание или профиль изменились; действие осталось в истории'
    FROM impact_assessments i WHERE a.impact_id=i.id AND i.company_id=$1 AND NOT(i.id=ANY($2::text[]))
    AND a.execution_status IN ('open','in_progress') AND ($3::text[] IS NULL OR i.rule_id=ANY($3))`, [companyId,currentIds,onlyRuleIds??null]);
  await db.query(`UPDATE notifications SET state='cancelled',terminal_at=now(),claim_token=NULL,claimed_at=NULL
    WHERE company_id=$1 AND state IN ('pending','retry') AND payload ? 'impactId'
    AND NOT(payload->>'impactId'=ANY($2::text[])) AND ($3::text[] IS NULL OR payload->>'ruleId'=ANY($3))`, [companyId,currentIds,onlyRuleIds??null]);
  // A complete recalculation uses the latest confirmed profile and therefore
  // supersedes all currently visible queued recalculations for this company.
  // Leaving failed publication or older profile jobs pending reports `refreshPending`
  // even though every visible assessment had already been recalculated.
  if(!onlyRuleIds) await db.query(`UPDATE company_recalculation_jobs
    SET status='processed',processed_at=COALESCE(processed_at,now()),last_error=NULL
    WHERE company_id=$1 AND status<>'processed' AND id=ANY($2::bigint[])
      AND id IN (SELECT id FROM company_recalculation_jobs WHERE company_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE SKIP LOCKED)`,
    [companyId,seenJobIds]);
  return currentIds;
}

export async function recalculateCompanyAtomic(companyId: string, reason = 'manual', asOf = utcDay(), onlyRuleIds?:string[]) {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const ids = await recalculateInTransaction(db, companyId, reason, asOf, onlyRuleIds);
    await db.query('COMMIT'); return ids;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
