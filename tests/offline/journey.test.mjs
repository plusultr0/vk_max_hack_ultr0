import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeBusinessChecks,actionCheckState } from './packages/domain/src/check-state.js';
import { REQUIRED_PROFILE_FIELDS,OPTIONAL_PROFILE_FIELDS,profileWarnings,profileChanges } from './packages/domain/src/profile-ui.js';
import { businessCheckTemplates,checkAnswerAllowed } from './packages/domain/src/business-checks.js';
import { sourceLabel,selectedImpact,impactKey,needsAttention } from './apps/web/src/ui/model.js';
import { createRequestEpoch } from './apps/web/src/ui/request-epoch.js';
import { feedMatchesFilter } from './packages/db/src/feed-logic.js';
const project=process.env.REG_PROJECT_ROOT;
const card=(extra={})=>({id:'i1',ruleId:'new-rule',ruleVersion:1,timeState:'active',isCurrent:true,
  verdict:'applies',reviewState:'auto',complianceState:'action_required',questions:[],
  rule:{userTitle:'Synthetic',evidenceRefs:[]},actions:[{id:'a1',actionKey:'step',title:'Step',description:'Do it',executionStatus:'open',reviewRequired:false}],...extra});

test('action checklist binds to the exact persisted action ID, not a parallel answer',()=>{
 const [item]=businessCheckTemplates([card()]);
 assert.equal(item.actionId,'a1');assert.equal(item.template.kind,'action');
 assert.equal(item.checkKey,'rule-action:new-rule:v1:step');
});
test('action identity remains stable if action order changes',()=>{
 const a=card({actions:[{id:'a1',actionKey:'one',title:'One',description:''},{id:'a2',actionKey:'two',title:'Two',description:''}]});
 const first=businessCheckTemplates([a]).map(i=>[i.checkKey,i.actionId]).sort();
 const second=businessCheckTemplates([{...a,actions:[...a.actions].reverse()}]).map(i=>[i.checkKey,i.actionId]).sort();
 assert.deepEqual(first,second);
});
test('readiness placeholder is not a fake writable action',()=>{
 const rows=businessCheckTemplates([card({verdict:'needs_info',questions:[{}],actions:[]})]);
 assert.equal(rows[0].actionId,undefined);assert.equal(checkAnswerAllowed(rows[0].impact),false);
});
for(const [status,expected] of [['completed','present'],['open','missing'],['in_progress','missing'],['dismissed','unknown']]){
 test('canonical action status '+status+' renders as '+expected,()=>assert.equal(actionCheckState(status),expected));
}
test('summary partitions all readiness states without pretending they need clarification',()=>{
 const items=[{state:'present'},{state:'missing'},{state:'unknown'},{state:'unchecked'},
 {state:'clarify',clarification:'questions'},{state:'clarify',clarification:'review'},{state:'clarify',clarification:'upcoming'}];
 const s=summarizeBusinessChecks(items);
 assert.deepEqual(s,{total:7,present:1,missing:1,unknown:1,unchecked:1,clarify:2,upcoming:1});
 assert.equal(s.total,s.present+s.missing+s.unknown+s.unchecked+s.clarify+s.upcoming);
});
test('six onboarding answers are mandatory; saved optional answers stay recognized',async()=>{
 assert.deepEqual(REQUIRED_PROFILE_FIELDS,['legalForm','industry','taxRegime','sellsToConsumers','distanceSales','collectsPersonalData']);
 assert.deepEqual(OPTIONAL_PROFILE_FIELDS,['region','salesChannels','onlinePayment']);
 assert.equal(new Set([...REQUIRED_PROFILE_FIELDS,...OPTIONAL_PROFILE_FIELDS]).size,9);
 const source=await readFile(join(project,'packages/db/src/profile.ts'),'utf8');
 assert.ok(source.includes('answeredFields: confirmed ? [...BASIC_ONBOARDING_FIELDS,...OPTIONAL_PROFILE_FIELDS].filter'));
});
test('current seed really references every mandatory field and no optional field',async()=>{
 const rules=JSON.parse(await readFile(join(project,'seed/v1/legal-rules.json'),'utf8'));
 const dependencies=new Set();
 const walk=v=>{if(!v||typeof v!=='object')return;if(typeof v.field==='string')dependencies.add(v.field);Object.values(v).forEach(walk);};
 rules.forEach(r=>{walk(r.applicability);walk(r.compliance);});
 for(const field of REQUIRED_PROFILE_FIELDS)assert.ok(dependencies.has(field),field);
 for(const field of OPTIONAL_PROFILE_FIELDS)assert.equal(dependencies.has(field),false,field);
});
test('explicitly contradictory profile gets a non-mutating warning',()=>{
 const p={salesChannels:[],sellsToConsumers:true,distanceSales:true};
 const original=JSON.stringify(p);assert.ok(profileWarnings(p).length>0);
 assert.equal(JSON.stringify(p),original);
});
test('unknown optional context does not cause a false contradiction',()=>{
 assert.deepEqual(profileWarnings({salesChannels:null,sellsToConsumers:true,distanceSales:null}),[]);
 assert.deepEqual(profileWarnings({salesChannels:[],sellsToConsumers:false,distanceSales:false,onlinePayment:false}),[]);
});
test('payment capability is not silently converted to an actual settlement',()=>{
 const p={onlinePayment:true};profileWarnings(p);assert.equal(Object.hasOwn(p,'internetSettlement'),false);
 assert.ok(profileWarnings({onlinePayment:false,internetSettlement:true}).length);
});
test('remote ordering of multi-select values does not make a fake history change',()=>{
 assert.deepEqual(profileChanges({salesChannels:['offline','own_site']},{salesChannels:['own_site','offline']}),[]);
});
test('history retains the distinction between false, unknown and not supplied',()=>{
 const c=profileChanges({a:false,b:null},{a:null,b:false,c:null});
 assert.deepEqual(c.map(v=>[v.field,v.before,v.after,v.hadBefore,v.hasAfter]),[
 ['a',false,null,true,true],['b',null,false,true,true],['c',null,null,false,true]]);
});
test('profile history ignores purely administrative version/date fields',()=>{
 assert.deepEqual(profileChanges({profileVersion:1,confirmedAt:'yesterday',taxRegime:'USN'},{profileVersion:2,confirmedAt:'today',taxRegime:'USN'}),[]);
});
test('first profile records honest initial values with no invented previous values',()=>{
 const c=profileChanges(null,{region:'Россия',sellsToConsumers:false});
 assert.equal(c.length,2);assert.ok(c.every(v=>!v.hadBefore&&v.before===null));
});
for(const url of ['https://cbr.ru/doc','https://www.nalog.gov.ru/','https://publication.pravo.gov.ru/']){
 test('official source host: '+url,()=>assert.equal(sourceLabel(url),'Официальный источник'));
}
for(const url of ['https://www.consultant.ru/document/','https://pravo.ppt.ru/doc/']){
 test('reference source host: '+url,()=>assert.equal(sourceLabel(url),'Справочная публикация'));
}
for(const url of ['https://cbr.ru.evil.example/doc','https://notcbr.ru','javascript:alert(1)','https://cbr.ru@evil.example','not a URL']){
 test('unknown or lookalike source is never labelled official: '+url,()=>assert.equal(sourceLabel(url),'Источник'));
}
test('recent irrelevant changes are omitted from bot filter but not global new feed',()=>{
 const i={state:'not_applicable',isRecent:true,impact:{timeState:'active'}};
 assert.equal(feedMatchesFilter(i,'new_relevant'),false);assert.equal(feedMatchesFilter(i,'new'),true);
});
test('bot recent-relevant filter requires BOTH predicates',()=>{
 assert.equal(feedMatchesFilter({state:'needs_info',isRecent:true,impact:{timeState:'active'}},'new_relevant'),true);
 assert.equal(feedMatchesFilter({state:'action_required',isRecent:false,impact:{timeState:'active'}},'new_relevant'),false);
});
test('fresh feed snapshot missing from older impacts is still current',()=>{
 const i=card();assert.equal(selectedImpact({key:impactKey(i),snapshot:i},[]).isCurrent,true);
});
test('detail follows a newer assessment with the same rule key',()=>{
 const i=card(),next=card({id:'i2'});
 assert.equal(selectedImpact({key:impactKey(i),snapshot:i},[next]).id,'i2');
});
test('a deliberately opened historical snapshot is not overwritten',()=>{
 const old=card({isCurrent:false}),next=card({id:'i2'});
 assert.equal(selectedImpact({key:impactKey(old),snapshot:old,exact:true},[next]).id,'i1');
 assert.equal(selectedImpact({key:impactKey(old),snapshot:old,exact:true},[next]).isCurrent,false);
});
test('no detail selection means no manufactured card',()=>assert.equal(selectedImpact(null,[card()]),null));
test('latest request wins even if an older HTTP result arrives after it',()=>{
 const epoch=createRequestEpoch(),old=epoch.begin(),next=epoch.begin();
 assert.equal(epoch.isCurrent(old),false);assert.equal(epoch.isCurrent(next),true);
});
test('a write invalidates earlier background reads before mutation is committed',()=>{
 const epoch=createRequestEpoch(),old=epoch.begin();epoch.invalidate();assert.equal(epoch.isCurrent(old),false);
 const next=epoch.begin();assert.equal(epoch.isCurrent(next),true);
});
test('completed canonical actions remove the requirement from attention',()=>{
 const i=card();assert.equal(needsAttention(i),true);
 i.actions[0].executionStatus='completed';assert.equal(needsAttention(i),false);
});
test('UI failure banner has an explicit retry and does not disguise a failed job as pending',async()=>{
 const app=await readFile(join(project,'apps/web/src/App.tsx'),'utf8');
 assert.ok(app.includes('!!impacts.refreshFailures'));
 assert.ok(app.includes('impacts.refreshPending&&!impacts.refreshFailures'));
 assert.ok(app.includes('Повторить пересчёт'));
 assert.ok(app.includes("setFilter('attention');setView('check')"));
 assert.ok(app.includes('не охватывает всё законодательство'));
 assert.equal(app.includes('self-report'),false);
 assert.equal(app.includes('какие ответы учтены'),false);
});
test('all resume listeners have corresponding cleanup and paused mutation handling',async()=>{
 const hook=await readFile(join(project,'apps/web/src/ui/revalidation.ts'),'utf8');
 for(const event of ['focus','pageshow','online','visibilitychange']){
   assert.ok(hook.includes(`addEventListener('${event}'`));assert.ok(hook.includes(`removeEventListener('${event}'`));
 }
 assert.ok(hook.includes('pausedRef.current||running'));
});

test('bot changes select only recent relevant requirements',async()=>{
 const source=await readFile(join(project,'apps/bot/src/handler.ts'),'utf8');
 assert.match(source,/filter:\s*'new_relevant'/);
});
test('a persisted but unconfirmed draft remains confirmable after a failed request',()=>{
 const confirmed={legalForm:'LLC',region:'77',profileVersion:1,confirmedAt:'2026-09-01'};
 assert.equal(profileChanges(confirmed,{legalForm:'LLC',region:'77'}).length,0);
 assert.equal(profileChanges(confirmed,{legalForm:'LLC',region:'78'}).length,1);
});
