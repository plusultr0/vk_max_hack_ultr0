/** Isolated PostgreSQL regression for 0.9.10. No network APIs or real secrets. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
import { getPool,closePool } from './client.js';
import { recalculateCompanyAtomic } from './runtime.js';
import { listImpacts,updateActionStatus } from './impacts.js';
import { answerImpactFacts } from './fact-answers.js';
import { answerBusinessCheck,listBusinessChecks } from './business-checks.js';
import { createConfirmedProfileVersion,getLatestConfirmedProfile,saveProfileDraft } from './profile.js';
import { failExtractionJob,retryExtractionJob,enqueueExtraction,claimExtractionJob } from './extraction-jobs.js';
import { stageSourceDocuments } from './ingestion.js';
import { makeManualOfficialDocument,scorePilotRelevance } from '@reg/ingestion';
if(process.env.ALLOW_INTEGRATION_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('ISOLATED_INTEGRATION_OPT_IN_REQUIRED');
const original=process.env.DATABASE_URL,schema='ui_test_'+randomUUID().replaceAll('-','');
assert.match(schema,/^ui_test_[a-f0-9]{32}$/);
const admin=new pg.Client({connectionString:original});await admin.connect();
try{
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const url=new URL(original);url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();process.env.NODE_ENV='test';
 const db=getPool(),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())await db.query(await readFile(new URL(file,dir),'utf8'));
 // The new additive migration must also be safe to repeat.
 await db.query(await readFile(new URL('012_business_checks.sql',dir),'utf8'));
 const rules=JSON.parse(await readFile(new URL('../../../seed/v1/legal-rules.json',import.meta.url),'utf8'));
 const acts=JSON.parse(await readFile(new URL('../../../seed/v1/legal-acts.json',import.meta.url),'utf8'));
 const names=['pd_consent_separate_v1','distance_seller_identity_v1'];
 for(const rule of rules.filter((r:any)=>names.includes(r.ruleId))){
  const act=acts.find((a:any)=>a.actId===rule.actId);
  await db.query(`INSERT INTO legal_acts(act_id,title,number,issuer,publication_date,official_url,retrieved_at,verification_status,raw_text_hash,data)
   VALUES($1,$2,$3,$4,$5,$6,now(),'reviewed',$7,$8) ON CONFLICT DO NOTHING`,
   [act.actId,act.title,act.number,act.issuer,act.publicationDate,act.officialUrl,act.rawTextHash??'synthetic',JSON.stringify(act)]);
  await db.query(`INSERT INTO legal_rules(rule_id,version,act_id,seed_hash,legal_status,review_status,valid_from,valid_to,checked_at,data)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[rule.ruleId,rule.version,rule.actId,rule.seedHash,rule.legalStatus,rule.reviewStatus,rule.validFrom,rule.validTo,rule.checkedAt,JSON.stringify(rule)]);
 }
 const company='owner',now=new Date().toISOString();
 const data={profileVersion:1,legalForm:'LLC',region:'77',taxRegime:'USN',sellsToConsumers:true,salesChannels:['own_site'],distanceSales:true,
  onlinePayment:true,collectsPersonalData:true,usesConsent:true,consentSeparate:true,sellerIdentityInfoChecked:null,sellerIdentityMissingFields:['ogrn'],confirmedAt:now};
 for(const id of [company,'other']){
  await db.query('INSERT INTO companies(id,owner_max_user_id) VALUES($1,$2)',[id,'dev-'+id]);
  await db.query('INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,$2,1,$3,$4)',[randomUUID(),id,JSON.stringify(data),now]);
 }
 await recalculateCompanyAtomic(company,'manual');
 const before=await listImpacts(company);assert.equal(before.impacts.length,2);
 const seller=before.impacts.find(i=>i.ruleId===names[1])!;assert.ok(seller.questions.some(q=>q.field==='sellerIdentityInfoChecked'));
 const body={requestId:randomUUID(),answers:[{field:'sellerIdentityInfoChecked',value:true,expectedObservationId:seller.questions.find(q=>q.field==='sellerIdentityInfoChecked')!.expectedObservationId}]};
 const saved=await answerImpactFacts(company,seller.id,body,'dev-owner');
 assert.deepEqual(await answerImpactFacts(company,seller.id,body,'dev-owner'),saved);
 const after=await listImpacts(company);assert.equal(after.impacts.length,2);assert.equal(after.profileVersion,2);
 assert.deepEqual(after.impacts.map(i=>i.ruleId).sort(),names.slice().sort());
 assert.ok(after.impacts.every(i=>i.isCurrent&&i.profileVersion===2));assert.equal(after.refreshPending,false);
 console.log('PASS: legacy answer increments profile version without losing unrelated cards');
 const currentSeller=after.impacts.find(i=>i.ruleId===names[1])!;
 assert.ok(currentSeller.editableQuestions.some(q=>q.field==='sellerIdentityInfoChecked'));
 await assert.rejects(()=>answerImpactFacts(company,currentSeller.id,{requestId:randomUUID(),edit:true,answers:[{field:'facts.not.in.this.rule',value:true}]},'dev-owner'));
 await assert.rejects(()=>answerImpactFacts('other',currentSeller.id,{requestId:randomUUID(),edit:true,answers:[{field:'sellerIdentityInfoChecked',value:false}]},'dev-other'),/IMPACT_NOT_FOUND/);
 await assert.rejects(()=>saveProfileDraft({companyId:company,patch:{region:'78'},baseProfileVersion:1}),/PROFILE_DRAFT_STALE/);
 assert.equal((await getLatestConfirmedProfile(company))!.profileVersion,2);
 console.log('PASS: stale profile draft and foreign/arbitrary fact edits rejected');
 let checks=await listBusinessChecks(company);assert.ok(checks.items.length>=4);
 const ready=checks.items.find(i=>i.ruleId===names[1]&&i.canAnswer)!;assert.ok(ready);
 const answer={requestId:randomUUID(),checkKey:ready.checkKey,impactId:ready.impactId,basisHash:ready.basisHash,answer:'present'};
 const receipt=await answerBusinessCheck(company,'dev-owner',answer);
 assert.deepEqual(await answerBusinessCheck(company,'dev-owner',answer),receipt);
 await assert.rejects(()=>answerBusinessCheck(company,'dev-owner',{...answer,answer:'missing'}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(()=>answerBusinessCheck('other','dev-other',{...answer,requestId:randomUUID()}),/IMPACT_NOT_FOUND/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM business_check_answers')).rows[0].n,1);
 checks=await listBusinessChecks(company);assert.equal(checks.items.find(i=>i.checkKey===ready.checkKey)!.state,'present');
 assert.equal((await listImpacts(company)).impacts.find(i=>i.ruleId===names[1])!.complianceState,'action_required');
 console.log('PASS: readiness is durable, idempotent and never masquerades as legal compliance');
 // Unrelated aggregate profile edits retain a readiness observation. Relevant
 // answers invalidate it, even when the rule version did not change.
 await createConfirmedProfileVersion({companyId:company,patch:{region:'78'}});await recalculateCompanyAtomic(company,'manual');
 checks=await listBusinessChecks(company);assert.equal(checks.items.find(i=>i.checkKey===ready.checkKey)!.state,'present');
 const editCard=(await listImpacts(company)).impacts.find(i=>i.ruleId===names[1])!;
 await answerImpactFacts(company,editCard.id,{requestId:randomUUID(),edit:true,answers:[{field:'sellerIdentityMissingFields',value:[]}]},'dev-owner');
 checks=await listBusinessChecks(company);const changed=checks.items.find(i=>i.checkKey===ready.checkKey)!;
 assert.equal(changed.state,'unchecked');assert.equal(changed.needsRecheck,true);
 assert.equal((await listImpacts(company)).impacts.find(i=>i.ruleId===names[1])!.complianceState,'compliant');
 await assert.rejects(()=>db.query("UPDATE business_check_answers SET answer='missing' WHERE id=$1",[receipt.id]),/BUSINESS_CHECK_HISTORY_IMMUTABLE/);
 console.log('PASS: corrected answers recalculate; old document confirmations require recheck; history immutable');
 const source=makeManualOfficialDocument({title:'Synthetic source for retry',officialUrl:'https://cbr.ru/test-only',sourceText:'Synthetic testing document only. This text is not an actual normative requirement or official published document.'});
 const sourceId=(await stageSourceDocuments({documents:[source],relevance:scorePilotRelevance})).documentIds[0]!;
 const enqueued=await enqueueExtraction(sourceId,{}),job=await claimExtractionJob();assert.equal(job.id,enqueued.id);
 await failExtractionJob(job,'SOURCE_TIMEOUT');await db.query('UPDATE extraction_jobs SET attempts=3 WHERE id=$1',[job.id]);
 const retried=await retryExtractionJob(job.id);assert.equal(retried.status,'pending');assert.equal(retried.attempts,0);
 assert.equal((await retryExtractionJob(job.id)).status,'pending');
 console.log('PASS: terminal source extraction can be retried without deleting source/history');
 console.log('0.9.10 PostgreSQL usability regression passed. No real MAX or LLM requests.');
}finally{await closePool();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();process.env.DATABASE_URL=original;}
