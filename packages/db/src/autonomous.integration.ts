/** S9.9 isolated PostgreSQL acceptance. Synthetic legal text, no external API.
 * Requires an explicitly opted-in test database. Only a random schema is dropped.
 * The production .env is never read/rewritten by this test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { builtinFactDefinitions,periodWindow,LegalRuleSchema } from '@reg/domain';
import { createSourceSnapshot,extractRegulatoryDraft } from '@reg/llm';
import { makeManualOfficialDocument,scorePilotRelevance } from '@reg/ingestion';
import { automaticFixture } from '../../review/test/automatic-fixture.js';
import { getPool,closePool } from './client.js';
import { stageSourceDocuments } from './ingestion.js';
import { enqueueExtraction,claimExtractionJob,completeExtractionJob } from './extraction-jobs.js';
import { automateCandidate } from './automation.js';
import { expandPublicationOutbox,processPublicationDelivery } from './outbox.js';
import { syncBuiltinProfileFacts,backfillBusinessFactIndex,writeFactObservation,loadFactObservations } from './facts.js';
import { listImpacts } from './impacts.js';
import { answerImpactFacts } from './fact-answers.js';
import { complianceBaseline,personalizedRegulatoryFeed } from './regulatory-feed.js';
import { seedHash } from './canonical.js';

if(process.env.ALLOW_INTEGRATION_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('ISOLATED_INTEGRATION_OPT_IN_REQUIRED');
const originalUrl=process.env.DATABASE_URL,schema='s99_test_'+randomUUID().replaceAll('-','');
assert.match(schema,/^s99_test_[a-f0-9]{32}$/);
const admin=new pg.Client({connectionString:originalUrl});await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(originalUrl);url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.toString();process.env.NODE_ENV='test';
  const db=getPool(),dir=new URL('../migrations/',import.meta.url);
  const migrations=(await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  for(const file of migrations.filter(n=>n<'011'))await db.query(await readFile(new URL(file,dir),'utf8'));
  const now=new Date().toISOString(),today=now.slice(0,10);
  const before={profileVersion:1,legalForm:'IP',taxRegime:'USN',confirmedAt:now};
  await db.query("INSERT INTO companies(id,owner_max_user_id) VALUES('upgrade-company','dev-upgrade')");
  await db.query("INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES('old-profile','upgrade-company',1,$1,$2)",[JSON.stringify(before),now]);
  for(let pass=0;pass<2;pass++)for(const file of migrations.filter(n=>n>='011'))await db.query(await readFile(new URL(file,dir),'utf8'));
  assert.deepEqual((await db.query("SELECT data FROM company_profiles WHERE id='old-profile'")).rows[0].data,before);
  const backfilled=await backfillBusinessFactIndex(200);
  assert.ok(backfilled>=1);
  console.log('S9.9: additive migration, repeat application and legacy fact backfill preserve profile data');

  const ids=['known','missing-yes','missing-no','stale','irrelevant','rollback'];
  for(const id of ids){
    await db.query('INSERT INTO companies(id,owner_max_user_id) VALUES($1,$2)',[id,'dev-'+id]);
    await db.query('INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,$2,1,$3,$4)',
      [randomUUID(),id,JSON.stringify({profileVersion:1,legalForm:id==='irrelevant'?'IP':'LLC',confirmedAt:now}),now]);
    await syncBuiltinProfileFacts(db,id);
  }
  // Ignore registration jobs here to measure targeted publication fan-out only.
  await db.query("UPDATE company_recalculation_jobs SET status='processed',processed_at=now()");
  const f=automaticFixture();
  const snapshot=createSourceSnapshot({sourceTitle:f.snapshot.sourceTitle,officialUrl:f.snapshot.officialUrl,
    sourceTextOrigin:'staged-official-page',sourceText:f.snapshot.sourceText.replace('01.01.2026','01.01.2012')});
  const draft=structuredClone(f.draft);draft.phases[0]!.validFrom.date='2012-01-01';
  const document=makeManualOfficialDocument({title:snapshot.sourceTitle,officialUrl:snapshot.officialUrl,sourceText:snapshot.sourceText});
  // This is a fixture for the official-adapter output, not a real publication.
  document.source='publication.pravo.gov.ru';document.raw={...document.raw,sourceKind:'official-html-page',syntheticTestOnly:true};
  const sourceId=(await stageSourceDocuments({documents:[document],relevance:scorePilotRelevance})).documentIds[0]!;
  const queued=await enqueueExtraction(sourceId,{});assert.ok(queued.id);
  const job=await claimExtractionJob();assert.ok(job);
  let calls=0;
  const provider={name:'gigachat',model:'synthetic-offline-only',async generateJson(){calls++;return structuredClone(draft);}};
  const extraction=await extractRegulatoryDraft(provider,{...job.input,sourceText:snapshot.sourceText},{autonomous:true,factCatalog:f.catalog});
  const candidateId=await completeExtractionJob(job,extraction,provider);
  const automated=await automateCandidate(candidateId!);assert.equal(automated.state,'published');
  assert.equal(calls,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM business_fact_definitions WHERE fact_key=$1',[f.definition.key])).rows[0].n,1);
  const ruleRow=(await db.query('SELECT data FROM legal_rules')).rows[0];
  const rule=LegalRuleSchema.parse(ruleRow.data);assert.equal(rule.factModel!.approvalMode,'machine_validated');
  console.log('S9.9: staged source -> extraction job -> new fact -> atomic automatic publication');

  async function putFact(companyId:string,value:unknown,confirmedAt=now) {
    return writeFactObservation(db,{companyId,scopeId:companyId,definition:f.definition,value,period:periodWindow({kind:'none'},today),
      confirmedAt,source:'synthetic-test',provenance:{testOnly:true}});
  }
  await putFact('known',true);await putFact('stale',false,new Date(Date.now()-40*86400_000).toISOString());
  await expandPublicationOutbox();
  const targets=(await db.query('SELECT company_id FROM company_recalculation_jobs WHERE event_id IS NOT NULL')).rows.map(r=>r.company_id);
  assert.ok(targets.includes('known'));assert.ok(targets.includes('missing-yes'));assert.ok(targets.includes('stale'));
  assert.ok(!targets.includes('irrelevant'));assert.ok(!targets.includes('upgrade-company'));
  await processPublicationDelivery();
  const one=async(id:string)=>(await listImpacts(id)).impacts.find(i=>i.ruleId===rule.ruleId)!;
  assert.equal((await one('known')).verdict,'applies');assert.equal((await one('known')).complianceState,'not_assessed');
  assert.ok((await one('known')).actions.length>0);
  assert.equal((await one('missing-yes')).verdict,'needs_info');assert.equal((await one('stale')).clarificationState,'needs_confirmation');
  assert.equal((await listImpacts('irrelevant')).impacts.length,0);
  console.log('S9.9: conservative cohort retains missing/stale facts and excludes proven unrelated companies');

  async function answer(id:string,value:boolean) {
    const impact=await one(id);const body={requestId:randomUUID(),answers:[{field:'facts.warehouse.archiveInUse',value,expectedObservationId:null}]};
    const result=await answerImpactFacts(id,impact.id,body,'dev-'+id);
    assert.deepEqual(await answerImpactFacts(id,impact.id,body,'dev-'+id),result);
    await assert.rejects(()=>answerImpactFacts(id,impact.id,{...body,answers:[{...body.answers[0]!,value:!value}]},'dev-'+id),/IDEMPOTENCY_CONFLICT/);
    return one(id);
  }
  const missing=await one('missing-yes');
  await assert.rejects(()=>answerImpactFacts('known',missing.id,{requestId:randomUUID(),answers:[{field:'facts.warehouse.archiveInUse',value:true}]},'dev-known'),/IMPACT_NOT_FOUND/);
  assert.equal((await answer('missing-yes',true)).verdict,'applies');
  assert.equal((await answer('missing-no',false)).verdict,'not_applicable');
  const stale=await one('stale'),q=stale.questions[0]!;
  await answerImpactFacts('stale',stale.id,{requestId:randomUUID(),answers:[{field:q.field,confirm:true,expectedObservationId:q.expectedObservationId}]},'dev-stale');
  assert.equal((await one('stale')).verdict,'not_applicable');assert.equal(calls,1);

  // Deliberate DB failure must not commit answers without their reassessment.
  const beforeFacts=(await loadFactObservations('rollback')).length,rollbackImpact=await one('rollback');
  await db.query(`CREATE FUNCTION synthetic_fail_assessment() RETURNS trigger AS $$ BEGIN IF NEW.company_id='rollback' THEN RAISE EXCEPTION 'TEST_FAIL'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER synthetic_fail_assessment BEFORE INSERT ON impact_assessments FOR EACH ROW EXECUTE FUNCTION synthetic_fail_assessment()`);
  await assert.rejects(()=>answerImpactFacts('rollback',rollbackImpact.id,{requestId:randomUUID(),answers:[{field:'facts.warehouse.archiveInUse',value:true}]},'dev-rollback'));
  assert.equal((await loadFactObservations('rollback')).length,beforeFacts);
  await db.query('DROP TRIGGER synthetic_fail_assessment ON impact_assessments');
  console.log('S9.9: typed answers, confirmation, ownership, idempotency and atomic rollback');

  // Same new fact is shared by another rule. No second answer or model request.
  const other={...rule,ruleId:rule.ruleId+'.shared'};other.seedHash=seedHash(other);
  await db.query('INSERT INTO legal_rules(rule_id,version,act_id,seed_hash,legal_status,review_status,valid_from,valid_to,checked_at,data) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [other.ruleId,other.actId,other.seedHash,other.legalStatus,other.reviewStatus,other.validFrom,other.validTo,other.checkedAt,JSON.stringify(other)]);
  const baseline=await complianceBaseline('missing-yes',true);
  assert.equal(baseline.items.filter(i=>i.verdict==='applies').length,2);assert.ok(baseline.items.every(i=>i.questions.length===0));
  assert.equal(baseline.coverage.completeLegislationCoverage,false);assert.equal(calls,1);
  await db.query("INSERT INTO companies(id,owner_max_user_id) VALUES('newcomer','dev-newcomer')");
  await db.query("INSERT INTO company_profiles(id,company_id,profile_version,data,confirmed_at) VALUES($1,'newcomer',1,$2,$3)",
    [randomUUID(),JSON.stringify({profileVersion:1,legalForm:'LLC',confirmedAt:now}),now]);
  const oldRules=await complianceBaseline('newcomer',true);
  assert.ok(oldRules.items.some(i=>i.ruleId===rule.ruleId&&i.rule.validFrom==='2012-01-01'));
  const feed=await personalizedRegulatoryFeed('missing-yes',{filter:'relevant'});
  assert.equal(feed.items.length,2);assert.ok(feed.items.every(i=>Object.hasOwn(i,'publishedAt')&&Object.hasOwn(i,'discoveredAt')));
  assert.equal((await personalizedRegulatoryFeed('missing-no',{filter:'not_applicable'})).items.length,1);
  await assert.rejects(()=>db.query('UPDATE business_fact_definitions SET origin=$1 WHERE fact_key=$2',['operator',f.definition.key]),/IMMUTABLE_FACT_HISTORY/);
  await assert.rejects(()=>db.query("UPDATE business_fact_observations SET value='false'::jsonb WHERE company_id='known'"),/IMMUTABLE_FACT_HISTORY/);
  console.log('S9.9: shared fact reuse, pre-registration baseline, feed and immutable fact history');
  console.log('S9.9 PostgreSQL acceptance passed. External services were NOT used.');
} finally {
  await closePool();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  process.env.DATABASE_URL=originalUrl;
}
