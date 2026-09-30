import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  FactDefinitionSchema, builtinFactDefinitions, ruleFactRequirements, validateFactValue, periodWindow,
  type FactDefinition, type FactObservation, type FactRequirement, type CompanyProfile, type LegalRule,
} from '@reg/domain';
import { getPool } from './client.js';
import { seedHash } from './canonical.js';
export type FactDb=Pick<PoolClient,'query'>;

export async function ensureBuiltinFacts(db:FactDb=getPool()) {
  const definitions=builtinFactDefinitions();
  await db.query(`INSERT INTO business_fact_definitions(fact_key,version,semantic_key,definition,origin)
    SELECT x->>'key',(x->>'version')::integer,x->>'semanticKey',x,'builtin'
    FROM jsonb_array_elements($1::jsonb) x ON CONFLICT DO NOTHING`,[JSON.stringify(definitions)]);
  return definitions;
}
export async function listFactDefinitions(db:FactDb=getPool()):Promise<FactDefinition[]> {
  return (await db.query('SELECT definition FROM business_fact_definitions ORDER BY fact_key,version')).rows.map(r=>FactDefinitionSchema.parse(r.definition));
}
const normalized=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]/gu,'');
export function factDefinitionConflicts(proposals:FactDefinition[],existing:FactDefinition[],mode:'machine'|'human'='machine'):string[] {
  const issues:string[]=[];const all=[...existing];
  for(const raw of proposals) {
    const parsed=FactDefinitionSchema.safeParse(raw);
    if(!parsed.success){issues.push('FACT_SCHEMA_INVALID');continue;}
    const d=parsed.data;
    const same=all.find(a=>a.key===d.key&&a.version===d.version);
    if(same) {if(seedHash(same)!==seedHash(d))issues.push('FACT_DEFINITION_CONFLICT:'+d.key);continue;}
    if(d.legacyField || (mode==='machine' ? d.origin!=='model'||d.version!==1 : !['model','operator'].includes(d.origin))) {
      issues.push('NEW_FACT_ORIGIN_INVALID:'+d.key);
    }
    const other=all.find(a=>a.key!==d.key&&(a.semanticKey===d.semanticKey||normalized(a.question)===normalized(d.question)||normalized(a.title)===normalized(d.title)));
    if(other)issues.push('AMBIGUOUS_FACT_ALIAS:'+d.key+':'+other.key);
    // Reusing a semantic concept with a different unit/scope/type is not an alias.
    const versions=all.filter(a=>a.key===d.key);
    if (versions.length) {
      if(mode==='machine')issues.push('FACT_VERSION_REQUIRES_REVIEW:'+d.key);
      else if(d.origin!=='operator' || d.version!==Math.max(...versions.map(v=>v.version))+1 || versions.some(v=>v.semanticKey!==d.semanticKey))issues.push('FACT_VERSION_SEQUENCE_INVALID:'+d.key);
    } else if(d.version!==1)issues.push('NEW_FACT_VERSION_INVALID:'+d.key);
    all.push(d);
  }
  return [...new Set(issues)];
}
export async function installFactDefinitions(db:FactDb,proposals:FactDefinition[],mode:'machine'|'human'='machine') {
  await ensureBuiltinFacts(db);
  // Serialize dictionary changes to prevent races on semantic aliases.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('business-fact-registry'))");
  const existing=await listFactDefinitions(db);
  const issues=factDefinitionConflicts(proposals,existing,mode);
  if(issues.length)throw new Error(issues.join(';'));
  for(const d of proposals)await db.query(`INSERT INTO business_fact_definitions(fact_key,version,semantic_key,definition,origin)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[d.key,d.version,d.semanticKey,JSON.stringify(d),d.origin]);
}
export async function writeFactObservation(db:FactDb,input:{companyId:string;definition:FactDefinition;scopeId:string;
  period:FactObservation['period'];value:unknown;confirmedAt:string;source:string;provenance:Record<string,unknown>}) {
  const {definition:d,value}=input;
  if(!validateFactValue(d,value))throw new Error('INVALID_FACT_VALUE:'+d.key);
  if(d.scope==='company'&&input.scopeId!==input.companyId)throw new Error('INVALID_FACT_SCOPE');
  const id=randomUUID();
  await db.query(`INSERT INTO business_fact_observations(id,company_id,fact_key,definition_version,scope_id,period_key,period,value,confirmed_at,source,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,input.companyId,d.key,d.version,input.scopeId,input.period.key,JSON.stringify(input.period),JSON.stringify(value),input.confirmedAt,input.source,JSON.stringify(input.provenance)]);
  const freshUntil=d.freshness.maxAgeDays?new Date(Date.parse(input.confirmedAt)+d.freshness.maxAgeDays*86400_000).toISOString():null;
  await db.query(`INSERT INTO company_fact_current(company_id,fact_key,definition_version,scope_id,period_key,observation_id,value,text_value,number_value,boolean_value,confirmed_at,fresh_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(company_id,fact_key,definition_version,scope_id,period_key) DO UPDATE SET
      observation_id=EXCLUDED.observation_id,value=EXCLUDED.value,text_value=EXCLUDED.text_value,number_value=EXCLUDED.number_value,
      boolean_value=EXCLUDED.boolean_value,confirmed_at=EXCLUDED.confirmed_at,fresh_until=EXCLUDED.fresh_until`,
  [input.companyId,d.key,d.version,input.scopeId,input.period.key,id,JSON.stringify(value),typeof value==='string'?value:null,typeof value==='number'?value:null,typeof value==='boolean'?value:null,input.confirmedAt,freshUntil]);
  return id;
}
export async function loadFactObservations(companyId:string,db:FactDb=getPool()):Promise<FactObservation[]> {
  const rows=await db.query(`SELECT o.* FROM company_fact_current c JOIN business_fact_observations o ON o.id=c.observation_id WHERE c.company_id=$1`,[companyId]);
  return rows.rows.map(r=>({id:r.id,key:r.fact_key,definitionVersion:r.definition_version,scopeId:r.scope_id,value:r.value,
    confirmedAt:new Date(r.confirmed_at).toISOString(),source:r.source,period:r.period}));
}

// The legacy immutable profile is a source, not a global freshness timestamp.
// Import each changed field once. Answering an unrelated question never refreshes
// every field and never converts a 2025 number into a 2026 number.
export async function syncBuiltinProfileFacts(db:FactDb,companyId:string) {
  const defs=await ensureBuiltinFacts(db);
  const sync=(await db.query('SELECT profile_version FROM business_fact_sync WHERE company_id=$1',[companyId])).rows[0];
  const since=sync?.profile_version??0;
  const rows=(await db.query('SELECT profile_version,data,confirmed_at,created_at FROM company_profiles WHERE company_id=$1 AND profile_version>=$2 ORDER BY profile_version',[companyId,Math.max(1,since)])).rows;
  let previous:Record<string,unknown>=since&&rows[0]?.profile_version===since?rows.shift()!.data:{};
  for(const row of rows) {
    const profile=row.data as CompanyProfile;
    const confirmed=new Date(row.confirmed_at??row.created_at).toISOString();
    for(const d of defs) {
      const field=d.legacyField!,value=(profile as Record<string,unknown>)[field];
      if(value===undefined)continue;
      if(seedHash(value)===seedHash(previous[field]??null)&&previous[field]!==undefined&&
         !(d.scope==='trade_object'&&previous.tradeObjectId!==profile.tradeObjectId)&&
         !(field==='incomeYtd2026'&&previous.incomeAsOf!==profile.incomeAsOf))continue;
      const scopeId=d.scope==='company'?companyId:profile.tradeObjectId;
      if(!scopeId)continue;
      let period:FactRequirement['period']={kind:'none'},date=confirmed.slice(0,10);
      if(field==='income2025Usn')period={kind:'range',start:'2025-01-01',end:'2026-01-01'};
      else if(field==='incomeYtd2026') {
        if(!profile.incomeAsOf||!profile.incomeAsOf.startsWith('2026-'))continue;
        period={kind:'current_ytd'};date=profile.incomeAsOf;
      }else if(d.periodic)period={kind:'previous_calendar_year'};
      await writeFactObservation(db,{companyId,definition:d,scopeId,value,confirmedAt:confirmed,period:periodWindow(period,date),
        source:'profile',provenance:{profileVersion:row.profile_version,legacyField:field}});
    }
    previous=profile;
    await db.query(`INSERT INTO business_fact_sync(company_id,profile_version) VALUES($1,$2)
      ON CONFLICT(company_id) DO UPDATE SET profile_version=EXCLUDED.profile_version`,[companyId,row.profile_version]);
  }
}
export async function registerRuleDependencies(db:FactDb,rule:LegalRule) {
  const requirements=ruleFactRequirements(rule);
  for(const req of requirements)await db.query(`INSERT INTO rule_fact_dependencies(rule_id,rule_version,field,fact_key,definition_version,requirement)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[rule.ruleId,rule.version,req.field,req.key,req.definitionVersion,JSON.stringify(req)]);
}
export async function companyFactHistory(companyId:string) {
  return (await getPool().query(`SELECT id,fact_key,definition_version,scope_id,period,value,confirmed_at,source,provenance
    FROM business_fact_observations WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200`,[companyId])).rows;
}

export async function backfillBusinessFactIndex(limit=200) {
  const db=await getPool().connect();
  try {
    await db.query('BEGIN');
    await ensureBuiltinFacts(db);
    const rows=await db.query(`SELECT c.id FROM companies c WHERE EXISTS(SELECT 1 FROM company_profiles p WHERE p.company_id=c.id
      AND p.profile_version>COALESCE((SELECT s.profile_version FROM business_fact_sync s WHERE s.company_id=c.id),0))
      ORDER BY c.id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
    for(const r of rows.rows)await syncBuiltinProfileFacts(db,r.id);
    await db.query('COMMIT');return rows.rowCount??0;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
