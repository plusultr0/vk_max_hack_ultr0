/** 0.9.19: real PostgreSQL regressions in a random, disposable schema only.
 * Uses seeded requirements as fixtures; no network, MAX, model or legal validation.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
import { getPool,closePool } from './client.js';
import { recalculateCompanyAtomic } from './runtime.js';
import { listImpacts,updateActionStatus,listAuditPage } from './impacts.js';
import { answerImpactFacts } from './fact-answers.js';
import { answerBusinessCheck,listBusinessChecks,reconcileLegacyActionChecks } from './business-checks.js';
import { installFactDefinitions } from './facts.js';
import { createConfirmedProfileVersion,saveProfileDraft,confirmProfileDraft,getProfileHistoryPage,getProfileState } from './profile.js';
if(process.env.ALLOW_INTEGRATION_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('ISOLATED_INTEGRATION_OPT_IN_REQUIRED');
const original=process.env.DATABASE_URL,schema='journey_'+randomUUID().replaceAll('-','');
assert.match(schema,/^journey_[a-f0-9]{32}$/);
const admin=new pg.Client({connectionString:original});await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(original);url.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=15000');
  process.env.DATABASE_URL=url.toString();process.env.NODE_ENV='test';
  const db=getPool(),dir=new URL('../migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())
    await db.query(await readFile(new URL(file,dir),'utf8'));
  await db.query(await readFile(new URL('013_action_checks_and_history.sql',dir),'utf8'));
  const rules=JSON.parse(await readFile(new URL('../../../seed/v1/legal-rules.json',import.meta.url),'utf8'));
  const acts=JSON.parse(await readFile(new URL('../../../seed/v1/legal-acts.json',import.meta.url),'utf8'));
  const actionRule='pd_operator_notification_v1';
  const journeyRules=rules.filter((r:any)=>[actionRule,'pd_consent_separate_v1'].includes(r.ruleId));
  const factDefinitions=journeyRules.flatMap((r:any)=>r.factModel?.definitions??[]);
  if(factDefinitions.length) await installFactDefinitions(db,factDefinitions,'human');
  for(const rule of journeyRules) {
    const act=acts.find((a:any)=>a.actId===rule.actId);
    await db.query(`INSERT INTO legal_acts(act_id,title,number,issuer,publication_date,official_url,retrieved_at,verification_status,raw_text_hash,data)
      VALUES($1,$2,$3,$4,$5,$6,now(),'reviewed',$7,$8) ON CONFLICT DO NOTHING`,
      [act.actId,act.title,act.number,act.issuer,act.publicationDate,act.officialUrl,act.rawTextHash??'synthetic',JSON.stringify(act)]);
    await db.query(`INSERT INTO legal_rules(rule_id,version,act_id,seed_hash,legal_status,review_status,valid_from,valid_to,checked_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [rule.ruleId,rule.version,rule.actId,rule.seedHash,rule.legalStatus,rule.reviewStatus,rule.validFrom,rule.validTo,rule.checkedAt,JSON.stringify(rule)]);
  }
  async function readyCompany(id:string) {
    await db.query('INSERT INTO companies(id,owner_max_user_id) VALUES($1,$2)',[id,'dev-'+id]);
    // Exactly the five required fields. Optional fields are intentionally absent.
    await saveProfileDraft({companyId:id,baseProfileVersion:0,patch:{legalForm:'LLC',taxRegime:'USN',
      sellsToConsumers:true,distanceSales:true,collectsPersonalData:true,usesConsent:true,consentSeparate:true}});
    const p=await confirmProfileDraft(id);assert.equal(p.region,undefined);
    await recalculateCompanyAtomic(id,'manual');
    for(let n=0;n<4;n++){
      const i=(await listImpacts(id)).impacts.find(x=>x.ruleId===actionRule)!;
      if(!i.questions.length)break;
      assert.ok(i.questions.every(q=>['facts.pd.only_non_automated_processing','facts.pd.operator_notification_sent'].includes(q.field)));
      await answerImpactFacts(id,i.id,{requestId:randomUUID(),answers:i.questions.map(q=>({
        field:q.field,value:false,expectedObservationId:q.expectedObservationId}))},'dev-'+id);
    }
    const check=(await listBusinessChecks(id)).items.find(c=>c.kind==='action'&&c.canAnswer)!;
    assert.ok(check?.actionId,'expected an actionable generated checklist entry');
    return check;
  }
  const company='owner',check=await readyCompany(company);
  await readyCompany('foreign');
  const payload=(answer:string)=>({requestId:randomUUID(),checkKey:check.checkKey,impactId:check.impactId,basisHash:check.basisHash,answer});
  const currentState=async()=> (await listBusinessChecks(company)).items.find(c=>c.checkKey===check.checkKey)!;
  await updateActionStatus({companyId:company,actionId:check.actionId!,status:'completed'});
  assert.equal((await currentState()).state,'present');
  await updateActionStatus({companyId:company,actionId:check.actionId!,status:'open'});
  assert.equal((await currentState()).state,'missing');
  const request=payload('present'),receipt=await answerBusinessCheck(company,'dev-owner',request);
  assert.equal((await db.query('SELECT execution_status FROM action_items WHERE id=$1',[check.actionId])).rows[0].execution_status,'completed');
  assert.deepEqual(await answerBusinessCheck(company,'dev-owner',request),receipt);
  assert.equal((await db.query("SELECT count(*)::int n FROM business_check_answers WHERE company_id=$1 AND check_key LIKE 'rule-action:%'",[company])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM business_check_action_requests WHERE company_id=$1',[company])).rows[0].n,1);
  // A transport retry may replay its receipt, but must not replay the mutation
  // over a newer mark made through the bot/card.
  await updateActionStatus({companyId:company,actionId:check.actionId!,status:'open'});
  assert.deepEqual(await answerBusinessCheck(company,'dev-owner',request),receipt);
  assert.equal((await currentState()).state,'missing');
  await assert.rejects(()=>answerBusinessCheck(company,'dev-owner',{...request,answer:'missing'}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(()=>answerBusinessCheck(company,'dev-owner',payload('unknown')),/CHECK_ACTION_ANSWER_NOT_SUPPORTED/);
  await assert.rejects(()=>answerBusinessCheck('foreign','dev-foreign',payload('present')),/IMPACT_NOT_FOUND/);
  assert.equal(await updateActionStatus({companyId:'foreign',actionId:check.actionId!,status:'completed'}),null);
  console.log('PASS shared action state, bidirectional writes, idempotent retries, ownership');

  const document=(await listBusinessChecks(company)).items.find(c=>c.kind==='document'&&c.canAnswer)!;assert.ok(document);
  await answerBusinessCheck(company,'dev-owner',{requestId:randomUUID(),checkKey:document.checkKey,impactId:document.impactId,basisHash:document.basisHash,answer:'unknown'});
  assert.equal((await listBusinessChecks(company)).items.find(c=>c.checkKey===document.checkKey)!.state,'unknown');
  assert.equal((await currentState()).state,'missing');
  console.log('PASS document observations remain independent; unknown never means completed');

  async function insertLegacy(id:string,item:typeof check,basis=item.basisHash,answer='present',createdAt=new Date().toISOString()) {
    const legacyId=randomUUID();
    await db.query(`INSERT INTO business_check_answers(id,company_id,request_id,request_hash,check_key,check_version,
      impact_id,rule_id,rule_version,basis_hash,scope_key,answer,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$2,$10,$11,$12)`,
      [legacyId,id,randomUUID(),'legacy-fixture',item.checkKey,item.impactId,item.ruleId,item.ruleVersion,basis,answer,'dev-'+id,createdAt]);
    return legacyId;
  }
  const legacy=await readyCompany('legacy');
  const legacyId=await insertLegacy('legacy',legacy);
  await reconcileLegacyActionChecks();
  assert.equal((await listBusinessChecks('legacy')).items.find(c=>c.checkKey===legacy.checkKey)!.state,'present');
  await updateActionStatus({companyId:'legacy',actionId:legacy.actionId!,status:'open'});
  await reconcileLegacyActionChecks();
  assert.equal((await listBusinessChecks('legacy')).items.find(c=>c.checkKey===legacy.checkKey)!.state,'missing');
  assert.equal((await db.query('SELECT count(*)::int n FROM business_check_action_imports WHERE legacy_answer_id=$1',[legacyId])).rows[0].n,1);
  await assert.rejects(()=>db.query("UPDATE business_check_answers SET answer='missing' WHERE id=$1",[legacyId]),/BUSINESS_CHECK_HISTORY_IMMUTABLE/);

  const conflict=await readyCompany('conflict');
  const conflictId=await insertLegacy('conflict',conflict,conflict.basisHash,'present','2000-01-01T00:00:00Z');
  await updateActionStatus({companyId:'conflict',actionId:conflict.actionId!,status:'open'});
  await listBusinessChecks('conflict');
  assert.equal((await db.query('SELECT applied FROM business_check_action_imports WHERE legacy_answer_id=$1',[conflictId])).rows[0].applied,false);
  const stale=await readyCompany('stale');
  const staleId=await insertLegacy('stale',stale,'0'.repeat(64));
  assert.equal((await listBusinessChecks('stale')).items.find(c=>c.checkKey===stale.checkKey)!.state,'missing');
  assert.equal((await db.query('SELECT count(*)::int n FROM business_check_action_imports WHERE legacy_answer_id=$1',[staleId])).rows[0].n,0);
  console.log('PASS legacy migration once only; immutable history; newer mark wins; stale basis not reused');

  await db.query(`INSERT INTO company_recalculation_jobs(company_id,request_key,status,last_error)
    VALUES($1,$2,'failed','fixture failure')`,[company,randomUUID()]);
  assert.equal((await listImpacts(company)).refreshFailures,1);
  await recalculateCompanyAtomic(company,'manual');
  assert.equal((await listImpacts(company)).refreshFailures,0);
  assert.equal((await listImpacts(company)).refreshPending,false);
  // Worker lock order: job then company. Manual refresh holds company first.
  // It must skip claimed jobs rather than deadlock on their row.
  const pending=(await db.query(`INSERT INTO company_recalculation_jobs(company_id,request_key)
    VALUES($1,$2) RETURNING id`,[company,randomUUID()])).rows[0].id;
  const claim=await db.connect();
  try{
    await claim.query('BEGIN');
    await claim.query('SELECT id FROM company_recalculation_jobs WHERE id=$1 FOR UPDATE',[pending]);
    await recalculateCompanyAtomic(company,'manual');
    assert.equal((await db.query('SELECT status FROM company_recalculation_jobs WHERE id=$1',[pending])).rows[0].status,'pending');
    await claim.query('ROLLBACK');
  }finally{claim.release();}
  await recalculateCompanyAtomic(company,'manual');
  assert.equal((await listImpacts(company)).refreshPending,false);
  console.log('PASS failed-job retry and lock-safe full recalculation');

  // Optional edits preserve data and marks. Meaningful profile edit makes old
  // assessment writes invalid rather than silently changing an old card.
  await createConfirmedProfileVersion({companyId:company,patch:{region:'78'}});
  assert.ok((await getProfileState(company)).draft.answeredFields.includes('region'));
  await recalculateCompanyAtomic(company,'manual');
  await assert.rejects(()=>answerBusinessCheck(company,'dev-owner',payload('present')),/CHECK_STALE/);
  await assert.rejects(()=>updateActionStatus({companyId:company,actionId:check.actionId!,status:'completed'}),/STALE_ACTION/);
  await createConfirmedProfileVersion({companyId:company,patch:{region:'77'}});
  const first=await getProfileHistoryPage(company,{limit:1});
  assert.equal(first.items.length,1);assert.ok(first.nextVersion);
  assert.ok(first.items[0]!.changes.some((c:any)=>c.field==='region'&&c.before==='78'&&c.after==='77'));
  const second=await getProfileHistoryPage(company,{beforeVersion:first.nextVersion,limit:1});
  assert.ok(second.items[0]!.profile_version<first.items[0]!.profile_version);
  assert.ok(second.items[0]!.changes.some((c:any)=>c.field==='region'&&!c.hadBefore&&c.after==='78'));
  await db.query(`INSERT INTO audit_log(company_id,actor_type,event_type,entity_type,entity_id,data)
    SELECT $1,'system','fixture.event','fixture',g::text,'{}'::jsonb FROM generate_series(1,125) g`,[company]);
  const seen=new Set<string>();let cursor:string|undefined;let pages=0;
  do {
    const page=await listAuditPage(company,{beforeId:cursor,limit:37});
    for(const event of page.items){assert.equal(event.company_id,company);assert.ok(!seen.has(event.id));seen.add(event.id);}
    cursor=page.nextCursor??undefined;pages++;
  }while(cursor&&pages<20);
  assert.ok(seen.size>=125&&pages>=4);assert.equal(cursor,undefined);
  console.log('PASS stale-write guards; profile boundary diffs; audit pagination beyond 100 without duplicates');
  console.log('0.9.19 PostgreSQL journey regression passed; no live external calls.');
}finally{
  await closePool();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();process.env.DATABASE_URL=original;
}
