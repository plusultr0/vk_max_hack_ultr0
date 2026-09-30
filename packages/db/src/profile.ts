import { randomUUID } from 'node:crypto';
import { BASIC_ONBOARDING_FIELDS, OPTIONAL_PROFILE_FIELDS, CompanyProfileDraftSchema, CompanyProfileSchema, mergeProfileContext, profileWarnings, profileChanges, type CompanyProfile } from '@reg/domain';
import { getPool } from './client.js';
import { syncBuiltinProfileFacts, type FactDb } from './facts.js';

function progress(answeredFields: string[]) {
  const answered = new Set(answeredFields);
  const count = BASIC_ONBOARDING_FIELDS.filter((field) => answered.has(field)).length;
  return {
    answered: count,
    total: BASIC_ONBOARDING_FIELDS.length,
    percent: Math.round((count / BASIC_ONBOARDING_FIELDS.length) * 100),
    canConfirm: count === BASIC_ONBOARDING_FIELDS.length,
    missing: BASIC_ONBOARDING_FIELDS.filter((field) => !answered.has(field)),
  };
}

export async function getLatestConfirmedProfile(companyId: string, db:FactDb=getPool()): Promise<CompanyProfile | null> {
  const result = await db.query(
    'SELECT data FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC LIMIT 1',
    [companyId],
  );
  if (!result.rowCount) return null;
  return CompanyProfileSchema.parse(result.rows[0].data);
}

export async function getProfileHistory(companyId: string) {
  const result = await getPool().query(
    'SELECT id, profile_version, data, confirmed_at, created_at FROM company_profiles WHERE company_id=$1 ORDER BY profile_version DESC',
    [companyId],
  );
  return result.rows;
}

export async function getProfileState(companyId: string, pool:FactDb=getPool()) {
  const [confirmed, draftRow] = await Promise.all([
    getLatestConfirmedProfile(companyId,pool),
    pool.query('SELECT data, answered_fields, base_profile_version, updated_at FROM company_profile_drafts WHERE company_id=$1', [companyId]),
  ]);
  const draft = draftRow.rowCount ? CompanyProfileDraftSchema.parse({
    data: draftRow.rows[0].data,
    answeredFields: draftRow.rows[0].answered_fields,
    baseProfileVersion: draftRow.rows[0].base_profile_version,
    updatedAt: new Date(draftRow.rows[0].updated_at).toISOString(),
  }) : CompanyProfileDraftSchema.parse({
    data: confirmed ? { ...confirmed, profileVersion: undefined, confirmedAt: undefined } : {},
    answeredFields: confirmed ? [...BASIC_ONBOARDING_FIELDS,...OPTIONAL_PROFILE_FIELDS].filter((field) => (confirmed as Record<string, unknown>)[field] !== undefined) : [],
    baseProfileVersion: confirmed?.profileVersion ?? 0,
  });
  return { confirmed, draft, progress: progress(draft.answeredFields), warnings:profileWarnings(draft.data) };
}

async function lockCompany(db:FactDb,companyId:string) {
  if(!(await db.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId])).rowCount)throw new Error('COMPANY_NOT_FOUND');
}

export async function saveProfileDraft(input: { companyId: string; patch: Record<string, unknown>; answeredFields?: string[]; baseProfileVersion?: number }) {
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');await lockCompany(client,input.companyId);
    const current=await getProfileState(input.companyId,client);
    if(input.baseProfileVersion!==undefined && input.baseProfileVersion!==current.draft.baseProfileVersion)throw new Error('PROFILE_DRAFT_STALE');
    if(current.draft.baseProfileVersion!==(current.confirmed?.profileVersion??0))throw new Error('PROFILE_DRAFT_STALE');
    const data=mergeProfileContext(current.draft.data,input.patch);
    const answered=new Set([...current.draft.answeredFields,...Object.keys(input.patch),...(input.answeredFields??[])]);
    const parsed=CompanyProfileDraftSchema.parse({data,answeredFields:[...answered],baseProfileVersion:current.confirmed?.profileVersion??0});
    await client.query(`INSERT INTO company_profile_drafts(company_id,data,answered_fields,base_profile_version,updated_at)
      VALUES($1,$2,$3,$4,now()) ON CONFLICT(company_id) DO UPDATE SET data=EXCLUDED.data,
      answered_fields=EXCLUDED.answered_fields,base_profile_version=EXCLUDED.base_profile_version,updated_at=now()`,
      [input.companyId,JSON.stringify(parsed.data),JSON.stringify(parsed.answeredFields),parsed.baseProfileVersion]);
    const result=await getProfileState(input.companyId,client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function confirmProfileDraft(companyId: string): Promise<CompanyProfile> {
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');await lockCompany(client,companyId);
    const state=await getProfileState(companyId,client);
    if(!state.progress.canConfirm)throw new Error(`PROFILE_INCOMPLETE:${state.progress.missing.join(',')}`);
    if(state.draft.baseProfileVersion!==(state.confirmed?.profileVersion??0))throw new Error('PROFILE_DRAFT_STALE');
    const nextVersion=(state.confirmed?.profileVersion??0)+1,confirmedAt=new Date().toISOString(),id=randomUUID();
    const profile=CompanyProfileSchema.parse({...state.draft.data,profileVersion:nextVersion,confirmedAt});
    await client.query('INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,$2,$3,$4,$5)',
      [id,companyId,nextVersion,JSON.stringify(profile),confirmedAt]);
    await client.query(`INSERT INTO company_profile_drafts(company_id,data,answered_fields,base_profile_version,updated_at)
      VALUES($1,$2,$3,$4,now()) ON CONFLICT(company_id) DO UPDATE SET data=EXCLUDED.data,
      answered_fields=EXCLUDED.answered_fields,base_profile_version=EXCLUDED.base_profile_version,updated_at=now()`,
      [companyId,JSON.stringify(state.draft.data),JSON.stringify(state.draft.answeredFields),nextVersion]);
    // Imports changed fields only. Unrelated confirmations retain their age.
    await syncBuiltinProfileFacts(client,companyId);
    await client.query(`INSERT INTO audit_log(company_id,actor_type,event_type,entity_type,entity_id,data)
      VALUES($1,'user','profile.confirmed','company_profile',$2,$3)`,[companyId,id,JSON.stringify({profileVersion:nextVersion})]);
    await client.query('COMMIT');return profile;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function createConfirmedProfileVersion(input: { companyId: string; patch: Record<string, unknown>; actorId?: string }) {
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');await lockCompany(client,input.companyId);
    const current=await getLatestConfirmedProfile(input.companyId,client);
    if(!current)throw new Error('PROFILE_NOT_CONFIRMED');
    const nextVersion=current.profileVersion+1,id=randomUUID();
    const profile=CompanyProfileSchema.parse({...mergeProfileContext(current,input.patch),profileVersion:nextVersion,confirmedAt:new Date().toISOString()});
    await client.query('INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,$2,$3,$4,$5)',
      [id,input.companyId,nextVersion,JSON.stringify(profile),profile.confirmedAt]);
    await client.query('DELETE FROM company_profile_drafts WHERE company_id=$1',[input.companyId]);
    await syncBuiltinProfileFacts(client,input.companyId);
    await client.query(`INSERT INTO audit_log(company_id,actor_type,actor_id,event_type,entity_type,entity_id,data)
      VALUES($1,'user',$2,'profile.context_answer','company_profile',$3,$4)`,
      [input.companyId,input.actorId??null,id,JSON.stringify({profileVersion:nextVersion,fields:Object.keys(input.patch)})]);
    await client.query('COMMIT');return profile;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function hasDirtyDraft(companyId: string): Promise<boolean> {
  const state = await getProfileState(companyId);
  if (!state.confirmed) return Object.keys(state.draft.data).length > 0;
  const { profileVersion: _profileVersion, confirmedAt: _confirmedAt, ...confirmedData } = state.confirmed;
  return state.draft.baseProfileVersion === state.confirmed.profileVersion &&
    JSON.stringify(state.draft.data) !== JSON.stringify(confirmedData);
}

/** Keyset paging; include the preceding version for a correct boundary diff. */
export async function getProfileHistoryPage(companyId:string,options:{beforeVersion?:number;limit?:number}={}) {
  const limit=Math.min(100,Math.max(1,options.limit??20));
  const rows=(await getPool().query(`SELECT p.id,p.profile_version,p.data,p.confirmed_at,p.created_at,
    previous.data AS previous_data FROM company_profiles p
    LEFT JOIN LATERAL (SELECT data FROM company_profiles
      WHERE company_id=p.company_id AND profile_version<p.profile_version ORDER BY profile_version DESC LIMIT 1) previous ON true
    WHERE p.company_id=$1 AND ($2::int IS NULL OR p.profile_version<$2)
    ORDER BY p.profile_version DESC LIMIT $3`,[companyId,options.beforeVersion??null,limit+1])).rows;
  const items=rows.slice(0,limit).map(({previous_data,...p})=>({...p,changes:profileChanges(previous_data??null,p.data)}));
  return {items,nextVersion:rows.length>limit?items.at(-1)!.profile_version:null};
}
