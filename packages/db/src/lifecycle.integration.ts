import assert from 'node:assert/strict';
import { randomUUID,createHmac } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { makeManualOfficialDocument,scorePilotRelevance } from '@reg/ingestion';
import { testExtraction,completeTestReview } from '../../review/test/fixture.js';
import { closePool,getPool } from './client.js';
import { createCandidateReview,saveCandidateReview } from './review.js';
import { saveRuleCandidate,stageSourceDocuments } from './ingestion.js';
import { publishReadyReviewRevision } from './publication.js';
import { processPublicationDelivery,expandPublicationOutbox,processRecalculationJob,publicationDeliveryStatus,retryPublicationDelivery } from './outbox.js';
import { recalculateCompanyAtomic,utcDay } from './runtime.js';
import { listImpacts,updateActionStatus,getImpactById } from './impacts.js';
import { claimDueNotification,notificationStillRelevant,markNotificationSent,recoverStaleNotifications } from './notifications.js';
import { enqueueExtraction,claimExtractionJob,completeExtractionJob,failExtractionJob } from './extraction-jobs.js';
import { acceptBotEvent } from './webhook.js';
import { ensureDevIdentity } from './auth.js';
import { dispatchNotifications } from '../../../apps/worker/src/jobs.js';

if(process.env.ALLOW_INTEGRATION_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('ISOLATED_INTEGRATION_OPT_IN_REQUIRED');
const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
const schema='s978_test_'+randomUUID().replaceAll('-','');assert.match(schema,/^s978_test_[a-f0-9]{32}$/);
const children:ChildProcess[]=[];
let mock:ReturnType<typeof createServer>|undefined;
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.toString();process.env.NODE_ENV='test';
  const db=getPool();
  const dir=new URL('../migrations/',import.meta.url), migrations=(await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort();
  for(let i=0;i<2;i++)for(const file of migrations)await db.query(await readFile(new URL(file,dir),'utf8'));
  const extraction=testExtraction();
  const sourceId=(await stageSourceDocuments({documents:[makeManualOfficialDocument({title:extraction.title,
    officialUrl:extraction.sourceSnapshot.officialUrl,sourceText:extraction.sourceSnapshot.sourceText})],relevance:scorePilotRelevance})).documentIds[0]!;
  const userId='97801',companyId='company-max-'+userId, other='company-max-97802';
  const event={update_type:'bot_started',timestamp:100,chat_id:123,user:{user_id:userId,first_name:'Synthetic'}};
  assert.equal((await acceptBotEvent(event)).duplicate,false);
  assert.equal((await acceptBotEvent(event)).duplicate,true);
  await acceptBotEvent({...event,user:{user_id:'97802'},timestamp:101});
  const profile={profileVersion:1,revenuePreviousYear:121,hasEpaymentAcceptanceAgreementAsOf2026_01_01:true,isExcludedProduct:false};
  async function putProfile(company:string,version:number) {
    await db.query('INSERT INTO company_profiles(id,company_id,profile_version,data) VALUES($1,$2,$3,$4)',
      [randomUUID(),company,version,JSON.stringify({...profile,profileVersion:version})]);
  }
  await putProfile(companyId,1);await putProfile(other,1);
  await db.query("INSERT INTO companies(id,owner_max_user_id) VALUES('legacy-dev-company','dev-ui-test')");
  const devIdentities=await Promise.all([ensureDevIdentity('dev-ui-test'),ensureDevIdentity('dev-ui-test')]);
  assert.ok(devIdentities.every(identity=>identity.companyId==='legacy-dev-company'));
  async function ready(previous?:any,version=1,changed=false) {
    const candidateId=await saveRuleCandidate({sourceDocumentId:sourceId,provider:'synthetic',draft:extraction});
    const draft=await createCandidateReview(candidateId,'test-reviewer');
    const document=completeTestReview(draft.document);
    document.phases.slice(1).forEach(p=>{p.decision='exclude';p.reason='Only one synthetic phase for lifecycle tests';});
    if(previous) {document.actId=previous.document.actId;document.phases[0]!.ruleId=previous.document.phases[0].ruleId;}
    document.phases[0]!.version=version;
    // Future fixed deadline allows an actual reminder without time travel.
    document.phases[0]!.actions[0]!.deadline={kind:'fixed',date:'2029-09-01',sourceSegmentIndexes:[0]};
    if(changed)document.phases[0]!.actions[0]!.description='Changed obligation in synthetic version';
    return saveCandidateReview(candidateId,{baseRevision:1,state:'ready',reason:'Synthetic integration only',document},'test-reviewer');
  }
  const first=await ready();
  const publish=(r:typeof first,relation?:any)=>publishReadyReviewRevision({candidateId:r.candidateId,revision:r.revision,contentHash:r.contentHash,actorId:'test-reviewer',relation});
  const published=await publish(first);
  const ruleId=published.rules[0]!.ruleId;
  assert.equal((await db.query('SELECT count(*) AS n FROM impact_assessments')).rows[0].n,'0');
  await expandPublicationOutbox();
  // A notification failure must roll back the assessment/actions as well. Other companies continue.
  await db.query(`CREATE FUNCTION fail_one_company() RETURNS trigger AS $$ BEGIN
    IF NEW.company_id='${companyId}' THEN RAISE EXCEPTION 'SYNTHETIC_FAILURE'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_one_company BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_one_company()`);
  await processPublicationDelivery();
  assert.equal((await listImpacts(companyId)).impacts.length,0);
  assert.equal((await listImpacts(other)).impacts.length,1);
  assert.equal((await db.query('SELECT count(*) AS n FROM action_items a JOIN impact_assessments i ON i.id=a.impact_id WHERE i.company_id=$1',[companyId])).rows[0].n,'0');
  assert.equal((await publicationDeliveryStatus(first.candidateId)).status,'processing');
  assert.ok((await publicationDeliveryStatus(first.candidateId)).failed>0);
  await db.query('DROP TRIGGER fail_one_company ON notifications');
  await retryPublicationDelivery(first.candidateId,'test-reviewer');
  await db.query("UPDATE company_recalculation_jobs SET available_at=now() WHERE company_id=$1",[companyId]);
  await Promise.all([processPublicationDelivery(),processPublicationDelivery()]);
  assert.equal((await publicationDeliveryStatus(first.candidateId)).status,'processed');
  const firstImpact=(await listImpacts(companyId)).impacts[0]!;
  assert.equal(firstImpact.timeState,'active');assert.equal(firstImpact.actions.length,1);
  const counts=async()=> (await db.query(`SELECT (SELECT count(*) FROM impact_assessments) AS impacts,
    (SELECT count(*) FROM action_items) AS actions,(SELECT count(*) FROM notifications) AS notifications`)).rows[0];
  const once=await counts();await processPublicationDelivery();await recalculateCompanyAtomic(companyId);assert.deepEqual(await counts(),once);
  await db.query("DELETE FROM notifications WHERE company_id=$1 AND type='regulatory_update'",[companyId]);
  await recalculateCompanyAtomic(companyId);assert.deepEqual(await counts(),once,'retry repairs missing notification intent for an existing assessment');
  await updateActionStatus({companyId,actionId:firstImpact.actions[0]!.id,status:'completed',actorId:userId});
  await db.query('UPDATE action_items SET semantic_hash=NULL WHERE id=$1',[firstImpact.actions[0]!.id]);
  await putProfile(companyId,2);await processPublicationDelivery();
  const secondProfile=(await listImpacts(companyId)).impacts[0]!;
  assert.equal(secondProfile.actions[0]!.executionStatus,'completed');
  assert.equal(secondProfile.actions[0]!.carriedFromActionId,firstImpact.actions[0]!.id);
  assert.equal((await listImpacts(companyId,true)).impacts.length,2);
  await assert.rejects(updateActionStatus({companyId,actionId:firstImpact.actions[0]!.id,status:'open'}),/STALE_ACTION/);
  assert.equal(await getImpactById(other,firstImpact.id),null);
  const same=await ready(first,2);await publish(same,{type:'amends',effectiveFrom:utcDay()});await processPublicationDelivery();
  const versionTwo=(await listImpacts(companyId)).impacts[0]!;
  assert.equal(versionTwo.ruleVersion,2);assert.equal(versionTwo.actions[0]!.executionStatus,'completed');
  const changed=await ready(first,3,true);await publish(changed,{type:'amends',effectiveFrom:utcDay()});await processPublicationDelivery();
  const versionThree=(await listImpacts(companyId)).impacts[0]!;
  assert.equal(versionThree.ruleVersion,3);assert.equal(versionThree.actions[0]!.executionStatus,'open');
  assert.equal(versionThree.actions[0]!.carriedFromActionId,null);
  // Persisted stale reminders are rechecked immediately before sending.
  await db.query("UPDATE notifications SET state='pending',scheduled_at=now() WHERE type='deadline_reminder' AND company_id=$1",[companyId]);
  let staleSeen=false;
  for(let i=0;i<30;i++){
    const n=await claimDueNotification();if(!n)break;
    if(n.type==='deadline_reminder'&&n.company_id===companyId&&n.payload.impactId!==versionThree.id){
      assert.equal(await notificationStillRelevant(n),false);staleSeen=true;
    }else await markNotificationSent(n.id,n.claim_token);
  }
  assert.ok(staleSeen);
  // A stopped process releases its row lock/transaction; the job remains durable.
  await putProfile(companyId,3);
  const locked=new pg.Client({connectionString:process.env.DATABASE_URL});
  await locked.connect();
  await locked.query('BEGIN');
  await locked.query("SELECT id FROM company_recalculation_jobs WHERE status='pending' AND company_id=$1 FOR UPDATE",[companyId]);
  await processRecalculationJob(); // SKIP LOCKED must return rather than hang.
  // Terminate the actual PostgreSQL backend, rather than issuing a graceful rollback.
  const pid=(await locked.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  locked.on('error',()=>{});
  await admin.query('SELECT pg_terminate_backend($1)',[pid]);
  await locked.end().catch(()=>undefined);
  await processPublicationDelivery();
  assert.equal((await listImpacts(companyId)).impacts[0]!.profileVersion,3);
  // Extraction claim fencing, retry and atomic candidate/result linkage.
  const job=await enqueueExtraction(sourceId,{sourceText:extraction.sourceSnapshot.sourceText});
  assert.equal((await enqueueExtraction(sourceId,{sourceText:extraction.sourceSnapshot.sourceText})).id,job.id);
  const claimed=await claimExtractionJob();assert.equal(claimed.id,job.id);
  await failExtractionJob(claimed);
  await db.query('UPDATE extraction_jobs SET available_at=now() WHERE id=$1',[job.id]);
  const reclaimed=await claimExtractionJob();
  assert.equal(await completeExtractionJob(claimed,extraction,{name:'mock'}),null);
  const extracted=await completeExtractionJob(reclaimed,extraction,{name:'mock'});assert.ok(extracted);
  assert.equal(await completeExtractionJob(reclaimed,extraction,{name:'mock'}),null);
  assert.equal((await db.query('SELECT status,attempts FROM extraction_jobs WHERE id=$1',[job.id])).rows[0].status,'processed');
  const abandoned=await enqueueExtraction(sourceId,{sourceText:extraction.sourceSnapshot.sourceText+'\nSynthetic abandoned attempt'});
  await db.query("UPDATE extraction_jobs SET status='processing',attempts=3,lease_until=now()-interval '1 minute' WHERE id=$1",[abandoned.id]);
  assert.equal(await claimExtractionJob(),null);
  assert.equal((await db.query('SELECT status FROM extraction_jobs WHERE id=$1',[abandoned.id])).rows[0].status,'failed');

  // Actual worker notification path against a local fake MAX transport.
  let calls=0,lastMessage:any,failTransport=true;
  mock=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls++;lastMessage=JSON.parse(body);
    res.writeHead(failTransport?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:!failTransport}));});
  await new Promise<void>(resolve=>mock!.listen(0,'127.0.0.1',resolve));
  process.env.MAX_API_BASE_URL='http://127.0.0.1:'+(mock.address() as any).port;
  process.env.MAX_BOT_TOKEN='synthetic-token';process.env.MAX_BOT_USERNAME='synthetic-bot';
  const currentForSend=(await listImpacts(companyId)).impacts[0]!;
  await db.query(`UPDATE notifications SET state='pending',scheduled_at=now(),attempts=0,
    payload=jsonb_set(payload,'{impactId}',to_jsonb($2::text))
    WHERE company_id=$1 AND type='regulatory_update' AND payload->>'ruleVersion'='3'`,[companyId,currentForSend.id]);
  assert.equal((await dispatchNotifications(10)).failed,1);
  failTransport=false;await db.query("UPDATE notifications SET scheduled_at=now() WHERE state='retry'");
  assert.equal((await dispatchNotifications(10)).sent,1);
  assert.match(lastMessage.attachments[0].payload.buttons[0][0].url,/startapp=assessment_/);
  const afterSend=calls;await dispatchNotifications();assert.equal(calls,afterSend);
  // Notification acknowledgement from an expired claim cannot mark the new claim sent.
  await db.query("UPDATE notifications SET state='pending',scheduled_at=now() WHERE company_id=$1 AND type='bot_welcome'",[companyId]);
  const oldClaim=await claimDueNotification();assert.ok(oldClaim);
  await db.query("UPDATE notifications SET claimed_at=now()-interval '11 minutes' WHERE id=$1",[oldClaim.id]);
  await recoverStaleNotifications();const newClaim=await claimDueNotification();assert.ok(newClaim);
  await markNotificationSent(oldClaim.id,oldClaim.claim_token);
  assert.equal((await db.query('SELECT state FROM notifications WHERE id=$1',[oldClaim.id])).rows[0].state,'sending');
  await markNotificationSent(newClaim.id,newClaim.claim_token);

  async function launch(relative:string,env:Record<string,string>) {
    const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;
    await new Promise<void>(r=>probe.close(()=>r()));
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL(relative,import.meta.url))],{
      env:{...process.env,API_HOST:'127.0.0.1',BOT_HOST:'127.0.0.1',API_PORT:String(port),BOT_PORT:String(port),...env},
      stdio:'ignore',windowsHide:true});children.push(child);
    const base='http://127.0.0.1:'+port;let ok=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ok=true;break;}}catch{}await delay(100);}
    assert.ok(ok,'test HTTP process must start');return base;
  }
  const sessionSecret=randomUUID(),adminToken=randomUUID();
  const api=await launch('../../../apps/api/src/index.ts',{SESSION_SECRET:sessionSecret,ADMIN_TOKEN:adminToken,ALLOW_DEV_AUTH:'false'});
  function initData(id:string,start:string,age=0) {
    const pairs=[['auth_date',String(Math.floor(Date.now()/1000)-age)],['start_param',start],['user',JSON.stringify({user_id:id})]];
    const secret=createHmac('sha256','WebAppData').update('synthetic-token').digest();
    const hash=createHmac('sha256',secret).update(pairs.map(([k,v])=>k+'='+v).sort().join('\n')).digest('hex');
    return pairs.map(([k,v])=>k+'='+encodeURIComponent(v!)).join('&')+'&hash='+hash;
  }
  const auth=await fetch(api+'/auth/max',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:initData(userId,'assessment_'+versionThree.id)})});
  assert.equal(auth.status,200);const identity=await auth.json() as any;
  assert.equal(identity.startParam,'assessment_'+versionThree.id);
  const headers={Authorization:'Bearer '+identity.token,'Content-Type':'application/json'};
  assert.equal((await fetch(api+'/impacts/'+firstImpact.id,{headers})).status,200);
  assert.equal((await fetch(api+'/impacts/history',{headers})).status,200);
  assert.equal((await fetch(api+'/impacts/'+firstImpact.id)).status,401);
  assert.equal((await fetch(api+'/auth/max',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:initData(userId,'home',7200)})})).status,401);
  const foreign=(await (await fetch(api+'/auth/max',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:initData('97802','home')})})).json()) as any;
  assert.equal((await fetch(api+'/impacts/'+firstImpact.id,{headers:{Authorization:'Bearer '+foreign.token}})).status,404);
  const current=(await listImpacts(companyId)).impacts[0]!;
  assert.equal((await fetch(api+'/actions/'+current.actions[0]!.id,{method:'PATCH',headers,body:JSON.stringify({status:'completed'})})).status,200);
  assert.equal((await fetch(api+'/actions/'+firstImpact.actions[0]!.id,{method:'PATCH',headers,body:JSON.stringify({status:'open'})})).status,409);
  assert.equal((await fetch(api+'/admin/candidates/'+first.candidateId+'/publication')).status,403);
  assert.equal((await fetch(api+'/admin/candidates/'+first.candidateId+'/publication',{headers:{'X-Admin-Token':adminToken}})).status,200);
  assert.equal((await fetch(api+'/admin/source-documents/'+sourceId+'/extract',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':adminToken},body:'{}'})).status,202);
  const bot=await launch('../../../apps/bot/src/index.ts',{MAX_WEBHOOK_SECRET:'test-webhook-only'});
  assert.equal((await fetch(bot+'/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)})).status,401);
  const replay=await fetch(bot+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Max-Bot-Api-Secret':'test-webhook-only'},body:JSON.stringify(event)});
  assert.equal(replay.status,200);assert.equal((await replay.json() as any).duplicate,true);
  // Future revision and cancellation do not resurrect active V1.
  const future=await ready(first,4);await publish(future,{type:'amends',effectiveFrom:'2028-09-01'});
  await processPublicationDelivery();
  const split=(await listImpacts(companyId)).impacts;
  assert.equal(split.find(i=>i.ruleVersion===4)!.timeState,'upcoming');
  assert.equal(split.find(i=>i.ruleVersion===4)!.actions.length,0);
  assert.ok(split.some(i=>i.ruleVersion===3));
  const cancelled=await ready(first,5);await publish(cancelled,{type:'cancels',effectiveFrom:utcDay()});
  await processPublicationDelivery();
  const tombstone=(await listImpacts(companyId)).impacts.filter(i=>i.ruleId===ruleId);
  assert.equal(tombstone.length,1);assert.equal(tombstone[0]!.timeState,'cancelled');assert.equal(tombstone[0]!.actions.length,0);
  // Start the real pg-boss entrypoint twice; durable profile work survives restart.
  // No provider, official site or MAX connection is permitted in this test.
  await db.query("UPDATE extraction_jobs SET status='failed',attempts=3 WHERE status<>'processed'");
  const startWorker=()=>{
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../../apps/worker/src/index.ts',import.meta.url))],{
      env:{...process.env,MAX_BOT_TOKEN:'',MAX_BOT_USERNAME:'',NOTIFICATION_POLL_SECONDS:'1',
        INGESTION_ENABLE_PRAVO:'false',INGESTION_ENABLE_GOVERNMENT:'false',INGESTION_ENABLE_FNS:'false',
        INGESTION_ENABLE_CBR:'false',INGESTION_ENABLE_ROSPOTREBNADZOR:'false'},
      stdio:'ignore',windowsHide:true});children.push(child);return child;
  };
  for(const version of [4,5]) {
    await putProfile(companyId,version);
    const worker=startWorker();let processed=false;
    for(let i=0;i<160;i++){
      const status=(await db.query('SELECT status FROM company_recalculation_jobs WHERE request_key=$1',[`profile:${companyId}:${version}`])).rows[0]?.status;
      if(status==='processed'){processed=true;break;}
      assert.equal(worker.exitCode,null,'worker must remain running');await delay(500);
    }
    assert.ok(processed,'real worker consumes persisted profile job after startup/restart');
    const stopped=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
    worker.kill('SIGKILL');await stopped;
  }
  console.log(JSON.stringify({status:'ok',suite:'S9 delivery lifecycle MAX mock',checks:[
    'durable fanout and profile triggers','notification rollback and per-company retry','parallel idempotency',
    'V1 completion/profile change/V2 carry/V3 changed duty','history and stale action rejection',
    'future/cancelled revision selection','extraction retry fencing','MAX HTTP retry and exact deep link',
    'claim fencing','signed MAX auth expiry and ownership','webhook secret and duplicate event',
    'admin delivery status and background extraction','real pg-boss worker start and hard restart']}));
}finally{
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise<void>(r=>child.once('exit',()=>r()));child.kill();await Promise.race([stopped,delay(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await stopped;}}}
  if(mock)await new Promise<void>(r=>mock!.close(()=>r()));
  await closePool();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
}
