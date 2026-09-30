import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateCondition } from './packages/domain/src/condition.js';
import { INDUSTRY_VALUES } from './packages/domain/src/profile-ui.js';
import { assessRule } from './packages/domain/src/evaluator.js';
import { firstDayNextMonth,evaluateEffectiveFrom } from './packages/domain/src/effective-date.js';
import { selectRuleVersions,assessSelectedRule,mergeProfileContext } from './packages/domain/src/lifecycle.js';
import { periodWindow,resolveFact,validateFactValue,setFactPath,getFactPath,calendarDate } from './packages/domain/src/fact-logic.js';
import { compileTargeting } from './packages/domain/src/targeting-logic.js';
import { plainText,formatDate,formatValue,periodLabel,resultCopy,errorMessage,describeRequirement,FIELD_COPY,readableRule,readableAction,reviewReasonText } from './packages/domain/src/presentation.js';
import { businessCheckTemplates,checkAnswerAllowed,PILOT_BUSINESS_CHECKS } from './packages/domain/src/business-checks.js';
import { canonicalJson,seedHash } from './packages/db/src/canonical.js';
import { feedState,recentlyAdded,feedMatchesFilter } from './packages/db/src/feed-logic.js';
import { segmentSourceText,sourceTextHash,datesInText } from './packages/llm/src/source-segments.js';
import { fetchWithRetry,responseText,extractionErrorCode } from './packages/ingestion/src/transport.js';
import { pdfText } from './packages/ingestion/src/pdf-text.js';
import { htmlToText,parseCsv,normalizeDate } from './packages/ingestion/src/text.js';
import { impactKey,needsAttention,formatNumberInput,parseNumberInput,safeSourceUrl,questionFingerprint } from './apps/web/src/ui/model.js';
import { makeApi,launchData,ApiError } from './apps/web/src/ui/client.js';
const project=process.env.REG_PROJECT_ROOT;
const rules=JSON.parse(await readFile(join(project,'seed/v1/legal-rules.json'),'utf8'));
const profiles=JSON.parse(await readFile(join(project,'seed/v1/profile-fixtures.json'),'utf8'));
const expected=JSON.parse(await readFile(join(project,'seed/v1/expected-assessments.json'),'utf8'));
const ruleScenarios=JSON.parse(await readFile(join(project,'seed/v1/rule-scenarios.json'),'utf8'));
const date='2026-09-25T12:00:00.000Z';
const base=rules[0];
const fact={key:'warehouse.archiveInUse',version:1,semanticKey:'warehouse.archiveInUse',title:'Archive',description:'Synthetic fixture',question:'Archive?',
 type:'boolean',scope:'company',options:[],freshness:{kind:'periodic',maxAgeDays:30},periodic:false,unit:'none',min:null,max:null,origin:'model'};
const req={field:'facts.warehouse.archiveInUse',key:fact.key,definitionVersion:1,period:{kind:'none'},maxAgeDays:null,purposes:['applicability']};
const observation=(value,confirmedAt=date,scopeId='company-a')=>({id:'obs-1',key:fact.key,definitionVersion:1,scopeId,value,confirmedAt,source:'user',period:periodWindow(req.period,date.slice(0,10))});
const impact=(patch={})=>({id:'assessment-1',isCurrent:true,timeState:'active',ruleId:base.ruleId,ruleVersion:1,verdict:'applies',reviewState:'auto',complianceState:'not_assessed',questions:[],actions:[],rule:{userTitle:base.userTitle,evidenceRefs:base.evidenceRefs},...patch});
for(const row of expected)test('seed fixture: '+row.fixtureKey,()=>{
 const actual=assessRule({rule:rules.find(r=>r.ruleId===row.ruleId),profile:profiles.find(p=>p.fixtureId===row.profileFixture),now:date});
 for(const [key,value] of Object.entries(row.expected))assert.deepEqual(actual[key],value);
});
test('expanded seed contains the 0.9.20 sector catalogue without duplicate revisions',()=>{
 assert.equal(rules.length,90);assert.equal(ruleScenarios.length,30);
 assert.equal(new Set(rules.map(r=>r.ruleId+'@'+r.version)).size,90);
 const sector=rules.filter(r=>r.tags?.some(t=>t.startsWith('industry:')));
 const explicit=INDUSTRY_VALUES.filter(v=>v!=='industry_other');
 assert.equal(sector.length,explicit.length*2);
 for(const industry of explicit)assert.equal(sector.filter(r=>r.tags.includes('industry:'+industry)).length,2,industry);
});
for(const row of ruleScenarios){
 const rule=rules.find(r=>r.ruleId===row.ruleId);
 test('expanded seed applies fixture: '+row.ruleId,()=>assert.equal(assessRule({rule,profile:row.applies,now:date}).verdict,'applies'));
 test('expanded seed not-applicable fixture: '+row.ruleId,()=>assert.equal(assessRule({rule,profile:row.notApplicable,now:date}).verdict,'not_applicable'));
 test('expanded seed needs-info fixture: '+row.ruleId,()=>assert.equal(assessRule({rule,profile:row.needsInfo,now:date}).verdict,'needs_info'));
}
test('sector rules stay silent until industry is known and only match their own industry',()=>{
 const rule=rules.find(r=>r.ruleId==='industry_retail_non_food_1_v1');
 assert.equal(assessRule({rule,profile:{profileVersion:1},now:date}).verdict,'not_applicable');
 assert.equal(assessRule({rule,profile:{profileVersion:1,industry:'retail_non_food'},now:date}).verdict,'applies');
 assert.equal(assessRule({rule,profile:{profileVersion:1,industry:'it_software'},now:date}).verdict,'not_applicable');
});
test('toy marking revision is hidden outside childrens goods and asks details only inside that industry',()=>{
 const rule=rules.find(r=>r.ruleId==='child_goods_marking_v1'&&r.version===3);
 assert.equal(assessRule({rule,profile:{profileVersion:1},now:date}).verdict,'not_applicable');
 assert.equal(assessRule({rule,profile:{profileVersion:1,industry:'it_software'},now:date}).verdict,'not_applicable');
 const inside=assessRule({rule,profile:{profileVersion:1,industry:'childrens_goods'},now:date});
 assert.equal(inside.verdict,'needs_info');
 assert.ok(inside.missingFields.includes('productCodes'));
});
test('2026 VAT start rule distinguishes pre-2026 and newly registered businesses',()=>{
 const rule=rules.find(r=>r.ruleId==='usn_vat_start_2026_v1');
 const common={profileVersion:1,taxRegime:'USN',hasCombinedTaxRegimes:false,income2025Usn:350000000};
 assert.equal(assessRule({rule,profile:{...common,registrationDate:'2024-09-09'},now:date}).verdict,'applies');
 assert.equal(assessRule({rule,profile:{...common,registrationDate:'2026-09-09'},now:date}).verdict,'not_applicable');
});
test('expanded seed uses official evidence and concrete actions',()=>{
 const allowed=new Set(['mintrud.gov.ru','publication.pravo.gov.ru','zpp.rospotrebnadzor.ru','www.nalog.gov.ru','xn--c1anggbdpdf.xn--p1ai']);
 for(const row of ruleScenarios){
  const rule=rules.find(r=>r.ruleId===row.ruleId);assert.ok(rule.actions.length>0,row.ruleId+' has no action');
  assert.ok(rule.evidenceRefs.length>0,row.ruleId+' has no evidence');
  for(const ref of rule.evidenceRefs)assert.ok(allowed.has(new URL(ref.url).hostname),row.ruleId+' non-official evidence '+ref.url);
 }
});
test('0.9.20 keeps onboarding flat and removes redundant card metadata',async()=>{
 const app=await readFile(join(project,'apps/web/src/App.tsx'),'utf8');
 const styles=await readFile(join(project,'apps/web/src/styles.css'),'utf8');
 const facts=await readFile(join(project,'apps/web/src/facts/FactQuestionsForm.tsx'),'utf8');
 assert.equal(app.includes('МОЙ БИЗНЕС'),false);
 assert.equal(app.includes('ПРОВЕРКА БИЗНЕСА'),false);
 assert.equal(app.includes('Сервис показывает только проверки, которые уже загружены'),false);
 assert.equal(app.includes("title:'О бизнесе'"),false);
 assert.equal(app.includes('profile-progress-track'),false);
 assert.ok(app.includes('Эти ответы нужны, чтобы подобрать требования именно для вашего бизнеса.'));
 assert.ok(app.includes('Вопрос ${index+1} из ${fields.length}'));
 assert.ok(app.includes('По всей России'));
 assert.ok(app.includes('Россия и СНГ'));
 assert.equal(facts.includes("padStart(2,'0')"),false);
 assert.equal(facts.includes('Ответьте на то, что знаете сейчас'),false);
 assert.ok(app.includes('Требования выполнены'));
 assert.ok(app.includes('Требования ещё не выполнены'));
 assert.equal(app.includes('Ваши ответы, которые повлияли на результат:'),false);
 assert.equal(app.includes('facts-used'),false);
 assert.ok(styles.includes('.requirement-completion'));
 assert.ok(styles.includes('.profile-grid fieldset:not(:last-child){border-bottom:1px solid'));
});
test('not-applicable customer copy talks about a requirement rather than an internal check',()=>{
 const copy=resultCopy(impact({verdict:'not_applicable'}));
 assert.match(copy.summary,/требован/i);
 assert.doesNotMatch(copy.summary,/проверк/i);
});
for(const [name,value,tri] of [['missing',undefined,'unknown'],['unknown',null,'unknown'],['false',false,'false'],['true',true,'true']])
 test('tri-state boolean: '+name,()=>assert.equal(evaluateCondition({op:'eq',field:'x',value:true},{x:value}).value,tri));
test('zero and explicit empty lists remain known',()=>{
 assert.equal(evaluateCondition({op:'eq',field:'x',value:0},{x:0}).value,'true');
 assert.equal(evaluateCondition({op:'is_empty',field:'x'},{x:[]}).value,'true');
 assert.equal(evaluateCondition({op:'known',field:'x'},{x:[]}).value,'true');
});
test('irrelevant branch suppresses unnecessary questions',()=>{
 const c={op:'and',conditions:[{op:'eq',field:'missing',value:1},{op:'eq',field:'b2c',value:true}]};
 assert.deepEqual(evaluateCondition(c,{b2c:false}).missingFields,[]);
});
test('nested dynamic fact yields a question, then exact decision without LLM',()=>{
 const c={op:'eq',field:req.field,value:true},input={};
 assert.deepEqual(evaluateCondition(c,input).missingFields,[req.field]);
 setFactPath(input,req.field,false);assert.equal(getFactPath(input,req.field),false);
 assert.equal(evaluateCondition(c,input).value,'false');setFactPath(input,req.field,true);assert.equal(evaluateCondition(c,input).value,'true');
});
test('prototype properties cannot be read as business facts',()=>assert.equal(evaluateCondition({op:'known',field:'constructor'},{}).value,'unknown'));
test('missing, stale, current answers are distinct',()=>{
 assert.equal(resolveFact(fact,req,[],'company-a',date).status,'missing');
 assert.equal(resolveFact(fact,req,[observation(false)],'company-a',date).status,'fresh');
 assert.equal(resolveFact(fact,req,[observation(true,'2026-08-01T00:00:00Z')],'company-a',date).status,'stale');
 assert.equal(resolveFact(fact,req,[observation(null)],'company-a',date).status,'missing');
});
test('one answer is reusable by another rule with the same binding',()=>{
 const obs=[observation(true)];
 assert.deepEqual(resolveFact(fact,req,obs,'company-a',date),resolveFact(fact,{...req},obs,'company-a',date));
});
test('other company or other fact version is never reused',()=>{
 assert.equal(resolveFact(fact,req,[observation(true)],'company-b',date).status,'missing');
 assert.equal(resolveFact(fact,req,[{...observation(true),definitionVersion:2}],'company-a',date).status,'missing');
});
test('calendar periods do not silently reuse last year',()=>{
 assert.deepEqual(periodWindow({kind:'previous_calendar_year'},'2026-09-25'),{start:'2025-01-01',end:'2026-01-01',asOf:null,key:'2025-01-01/2026-01-01'});
 const r={...req,period:{kind:'previous_calendar_year'}};
 const obs={...observation(true),period:periodWindow(r.period,'2025-09-25')};
 assert.equal(resolveFact(fact,r,[obs],'company-a',date).status,'missing');
});
test('freshness expires at exact boundary',()=>assert.equal(resolveFact(fact,req,[observation(true,'2026-08-26T12:00:00.000Z')],'company-a',date).status,'stale'));
test('numeric field rejects strings, infinity and forbidden negative numbers',()=>{
 const d={...fact,type:'number',min:0,max:100};
 for(const value of ['3',Infinity,NaN,-1,101])assert.equal(validateFactValue(d,value),false);
 for(const value of [0,100,null])assert.equal(validateFactValue(d,value),true);
});
test('all seven dynamic field types are validated',()=>{
 const values={boolean:true,enum:'a',multi_enum:['a'],number:5,date:'2024-02-29',text:'hello',string_list:['a']};
 for(const [type,value] of Object.entries(values))assert.equal(validateFactValue({...fact,type,options:[{value:'a',label:'A'}]},value),true);
 assert.equal(validateFactValue({...fact,type:'date'},'2025-02-29'),false);
});
test('periodic YTD cannot masquerade as prior year total',()=>{
 const r={...req,period:{kind:'current_ytd'}},d={...fact,type:'number',periodic:true};
 const o={...observation(10),period:periodWindow({kind:'current_ytd'},'2025-09-25')};
 assert.equal(resolveFact(d,r,[o],'company-a',date).status,'missing');
});
test('dynamic fact can drive a relative deadline',()=>{
 const r={...base,effectiveFrom:{type:'first_day_next_month',sourceField:'facts.tax.crossingDate'}};
 assert.equal(evaluateEffectiveFrom(r,{facts:{tax:{crossingDate:'2026-12-10'}}}),'2027-01-01');
 assert.equal(evaluateEffectiveFrom(r,{facts:{}}),null);
});
test('date rollover and impossible dates',()=>{
 assert.equal(firstDayNextMonth('2024-02-29'),'2024-03-01');assert.equal(firstDayNextMonth('2026-12-31'),'2027-01-01');
 assert.throws(()=>firstDayNextMonth('2026-02-30'));assert.equal(calendarDate('2026-13-01'),false);
});
test('future revision never creates current actions',()=>{
 const selected={rule:base,scope:'company',effectiveOn:'2027-01-01',cancelled:false,timeState:'upcoming'};
 const result=assessSelectedRule(selected,profiles[0],'2026-09-25');
 assert.equal(result.complianceState,'not_assessed');assert.deepEqual(result.actions,[]);
});
test('cancelled latest version never revives an older obligation',()=>{
 const rows=[{rule:base,scope:'company',effectiveOn:'2025-01-01',cancelled:false},{rule:{...base,version:2},scope:'company',effectiveOn:'2026-01-01',cancelled:true}];
 const result=selectRuleVersions(rows,'2026-09-25');assert.equal(result.length,1);assert.equal(result[0].timeState,'cancelled');
});
test('trade-object switch clears old point facts only',()=>{
 const p=mergeProfileContext({tradeObjectId:'a',tradeObjectRevenuePreviousYear:100,paymentLocationHasInternet:true,region:'x'},{tradeObjectId:'b'});
 assert.equal(p.tradeObjectRevenuePreviousYear,null);assert.equal(p.paymentLocationHasInternet,null);assert.equal(p.region,'x');
});
test('targeting keeps missing values and uses bind parameters',()=>{
 const d={...fact,type:'text'},condition={op:'eq',field:req.field,value:"x' OR 1=1--"};
 const result=compileTargeting(condition,[req],[d],date);
 assert.ok(result.sql.includes('NOT EXISTS'));assert.ok(!result.sql.includes(condition.value));assert.ok(result.values.some(v=>String(v).includes(condition.value)));
});
test('unsupported targeting broadens, never excludes companies',()=>{
 const plan=compileTargeting({op:'not',condition:{op:'eq',field:req.field,value:true}},[req],[fact],date);
 assert.equal(plan.sql,'TRUE');assert.ok(plan.broadReasons.length);
});
test('canonical hashing ignores key ordering but not values',()=>{
 assert.equal(seedHash({a:1,b:false}),seedHash({b:false,a:1}));assert.notEqual(seedHash({a:1}),seedHash({a:2}));assert.equal(canonicalJson({z:1,seedHash:'old',a:2}),'{"a":2,"z":1}');
});
for(const value of ['facts.warehouse.a is unknown','legalForm eq "LLC" = true','STALE_IMPACT','NOT (x)','{"a":1}'])
 test('technical display trace is hidden: '+value,()=>assert.equal(plainText(value,'safe'),'safe'));
test('user-facing markdown does not print asterisks',()=>assert.equal(plainText('**Heading**'),'Heading'));
test('false, zero and empty list have readable values',()=>{
 assert.notEqual(formatValue(false),formatValue(null));assert.ok(formatValue(0,'','RUB').includes('0'));assert.notEqual(formatValue([]),formatValue(null));
});
test('half-open year is shown with an inclusive human label',()=>assert.ok(periodLabel({start:'2025-01-01',end:'2026-01-01',asOf:null}).includes('2025')));
test('invalid date does not print Invalid Date or a shifted date',()=>assert.equal(formatDate('2026-02-30'),formatDate(null)));
test('applies is not called a violation',()=>{
 const copy=resultCopy(impact());assert.notEqual(copy.label,resultCopy(impact({complianceState:'action_required'})).label);
 assert.notEqual(copy.label,resultCopy(impact({actions:[{executionStatus:'completed'}]})).label);
});
test('arbitrary backend text never enters customer error copy',()=>assert.ok(!errorMessage(new Error('postgresql://user:secret@host')).includes('secret')));
test('manual review reasons never expose technical fact names',()=>{
 const text=reviewReasonText('Unsupported business fact definition: facts.internalFlag');
 assert.ok(!/unsupported|definition|facts\./i.test(text));assert.ok(/источник|специалист/i.test(text));
});
test('known manual review gate is explained in ordinary Russian',()=>{
 const text=reviewReasonText('Нужно отдельно проверить обязанность применять ККТ для этого расчёта');
 assert.ok(/онлайн-касс/i.test(text));assert.ok(!/facts\.|eq|gte/i.test(text));
});
test('all onboarding labels are human-facing',()=>{
 for(const name of ['legalForm','region','taxRegime','sellsToConsumers','salesChannels','distanceSales','onlinePayment','collectsPersonalData']){
 assert.ok(FIELD_COPY[name]?.question);assert.notEqual(plainText(FIELD_COPY[name].question,'invalid'),'invalid');
 }
});
test('customer-facing field and checklist copy contains no internal machine vocabulary',()=>{
 const internal=/(facts\.|reviewState|complianceState|impactId|ruleId|source_snapshot|contains_any|is_empty|\{\s*\"|[a-z]+_[a-z]+_[a-z]+)/i;
 for(const copy of Object.values(FIELD_COPY)){assert.ok(copy.question.trim());assert.ok(copy.hint.trim());assert.equal(internal.test(copy.question+' '+copy.hint),false);}
 for(const check of PILOT_BUSINESS_CHECKS){assert.ok(check.title.trim());assert.ok(check.help.trim());assert.equal(internal.test(check.title+' '+check.help),false);}
});
test('every main result state has a readable status, explanation and next action',()=>{
 const states=[impact({verdict:'not_applicable'}),impact({reviewState:'needs_review'}),impact({verdict:'needs_info',questions:[{}]}),impact({timeState:'upcoming'}),impact({actions:[{executionStatus:'completed'}]}),impact({complianceState:'compliant'}),impact({complianceState:'action_required'}),impact()];
 for(const state of states){const copy=resultCopy(state);assert.ok(copy.label.trim());assert.ok(copy.summary.trim());assert.ok(copy.cta.trim());assert.equal(/needs_info|not_applicable|action_required|reviewState|compliance/i.test(copy.label+' '+copy.summary+' '+copy.cta),false);}
});
test('readable expression does not expose machine operators',()=>{
 const text=describeRequirement({op:'gt',field:'money',value:10},[{field:'money',title:'Income',unit:'RUB'}]);
 assert.ok(!text.includes(' gt '));assert.ok(text.includes('10'));
});
test('logical card identity survives answer-created assessment UUID',()=>assert.equal(impactKey(impact()),impactKey(impact({id:'assessment-2'}))));
test('answers can remove list attention without changing open card key',()=>{
 const before=impact({questions:[{}],verdict:'needs_info'}),after=impact({id:'new',verdict:'not_applicable'});
 assert.equal(needsAttention(before),true);assert.equal(needsAttention(after),false);assert.equal(impactKey(before),impactKey(after));
});
test('Russian numeric input accepts spaces and comma',()=>assert.equal(parseNumberInput('1\u202f234 567,50'),1234567.5));
test('RUB input is grouped with spaces while typing',()=>{assert.equal(formatNumberInput('35000000'),'35 000 000');assert.equal(formatNumberInput('1234567,50'),'1 234 567,50');});
for(const value of ['', ' ', '1e9', 'NaN', 'Infinity', '10 USD', '1,2,3', '99999999999999999'])
 test('invalid number is rejected: '+JSON.stringify(value),()=>assert.throws(()=>parseNumberInput(value)));
test('numeric range is enforced',()=>{assert.throws(()=>parseNumberInput('-1',{min:0}));assert.throws(()=>parseNumberInput('11',{max:10}));assert.equal(parseNumberInput('0',{min:0}),0);});
test('question fingerprint changes when evidence-period/version changes',()=>{
 const q={field:req.field,definitionVersion:1,inputType:'boolean',period:{start:null,end:null,asOf:null}};
 assert.notEqual(questionFingerprint(q),questionFingerprint({...q,definitionVersion:2}));
});
test('dangerous source link is not clickable',()=>{assert.equal(safeSourceUrl('javascript:alert(1)'),null);assert.equal(safeSourceUrl('https://user:password@cbr.ru'),null);assert.equal(safeSourceUrl('https://cbr.ru'),'https://cbr.ru/');});
test('signed MAX launch is decoded once and duplicate launch data rejected',()=>{
 assert.equal(launchData('#WebAppData=a%3Db%26c%3Dd'),'a=b&c=d');assert.throws(()=>launchData('#WebAppData=a&WebAppData=b'));
});
test('API rejects HTML error pages without leaking their text',async()=>{
 const old=globalThis.fetch;try{globalThis.fetch=async()=>new Response('<html>private stack</html>',{status:502});await assert.rejects(makeApi('')('/x'),e=>e instanceof ApiError&&e.code==='SERVICE_UNAVAILABLE'&&!e.message.includes('private'));}finally{globalThis.fetch=old;}
});
test('API sends authorization and preserves successful payload',async()=>{
 const old=globalThis.fetch;try{globalThis.fetch=async(url,init)=>{assert.equal(init.headers.Authorization,'Bearer test-only');return Response.json({saved:true});};assert.deepEqual(await makeApi('', 'test-only')('/x'),{saved:true});}finally{globalThis.fetch=old;}
});
test('baseline contains 12 supported pilot document/setting checks',()=>{assert.equal(PILOT_BUSINESS_CHECKS.length,12);assert.equal(new Set(PILOT_BUSINESS_CHECKS.map(t=>t.key)).size,12);});
test('irrelevant requirements create no checklist entries',()=>assert.equal(businessCheckTemplates([impact({verdict:'not_applicable'})]).length,0));
test('a missing fact blocks readiness answers',()=>assert.equal(checkAnswerAllowed(impact({verdict:'needs_info',questions:[{}]})),false));
test('upcoming/history/specialist review cannot be marked ready',()=>{
 for(const patch of [{timeState:'upcoming'},{isCurrent:false},{reviewState:'needs_review'}])assert.equal(checkAnswerAllowed(impact(patch)),false);
});
test('a newly approved rule contributes its own actions',()=>{
 const rows=businessCheckTemplates([impact({ruleId:'new-rule',actions:[{actionKey:'new',title:'New action',description:'Explain'}]})]);
 assert.equal(rows.length,1);assert.equal(rows[0].template.title,'New action');assert.equal(rows[0].template.kind,'action');
});
test('amendment uses its own actions instead of old hard-coded checklist',()=>{
 const rows=businessCheckTemplates([impact({ruleVersion:2,actions:[{actionKey:'changed',title:'Changed requirement',description:'New meaning'}]})]);
 assert.equal(rows.length,1);assert.equal(rows[0].template.title,'Changed requirement');
});
test('simultaneous current and future revisions keep unique check keys',()=>{
 const rows=businessCheckTemplates([impact({ruleId:'new',ruleVersion:2,actions:[{actionKey:'x',title:'A',description:'a'}]}),impact({ruleId:'new',ruleVersion:3,timeState:'upcoming',actions:[{actionKey:'x',title:'B',description:'b'}]})]);
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.checkKey)).size,2);
});
test('irrelevant future law is not classified as personalized upcoming',()=>assert.equal(feedState(impact({timeState:'upcoming',verdict:'not_applicable'})),'not_applicable'));
test('last 90 days uses service-added timestamp and excludes undated/future items',()=>{const now=Date.parse(date);assert.equal(recentlyAdded(null,now),false);assert.equal(recentlyAdded('2027-01-01',now),false);assert.equal(recentlyAdded('2026-09-01T12:00:00.000Z',now),true);});
test('feed catalog filters show recent and future rules even when they are not applicable to this company',()=>{const item={state:'not_applicable',isRecent:true,impact:{timeState:'upcoming'}};assert.equal(feedMatchesFilter(item,'new'),true);assert.equal(feedMatchesFilter(item,'upcoming'),true);assert.equal(feedMatchesFilter(item,'relevant'),false);});
test('segmentation is exact, deterministic, contiguous and lossless',()=>{
 const text=('Sentence with spaces.\n\t\u0417\u0430\u043a\u043e\u043d \ud83d\ude42 2027-09-01. ').repeat(130);
 const segments=segmentSourceText(text);assert.ok(segments.length>1);assert.equal(segments.map(s=>s.text).join(''),text);
 assert.deepEqual(segmentSourceText(text),segments);
 for(let i=0;i<segments.length;i++){
  const s=segments[i];assert.equal(s.sourceSegmentIndex,i);assert.equal(s.text,text.slice(s.start,s.end));
  assert.equal(s.start,i?segments[i-1].end:0);assert.ok(!/[\uD800-\uDBFF]$/.test(s.text));
 }
 assert.equal(sourceTextHash(text),sourceTextHash(segments.map(s=>s.text).join('')));
});
test('oversized text is rejected rather than silently truncated',()=>assert.throws(()=>segmentSourceText('x'.repeat(120001))));
test('all three phase years remain available to extraction',()=>assert.deepEqual(datesInText('2026-09-01, 01.09.2027, 1 \u0441\u0435\u043d\u0442\u044f\u0431\u0440\u044f 2028'),['2026-09-01','2027-09-01','2028-09-01']));
test('CSV quoting and separator detection',()=>assert.deepEqual(parseCsv('id;title;url\n1;"a;b";https://cbr.ru\n'),[{id:'1',title:'a;b',url:'https://cbr.ru'}]));
test('HTML scripts and invalid numeric entities do not break parsing',()=>{
 assert.equal(htmlToText('<style>x</style><p>Hello&nbsp;world</p><script>steal()</script>'),'Hello world');
 assert.doesNotThrow(()=>htmlToText('&#999999999;'));assert.equal(htmlToText('&#x1F642;'),'\ud83d\ude42');
});
test('publication dates reject impossible day/month combinations',()=>{assert.equal(normalizeDate('29.02.2024'),'2024-02-29');assert.equal(normalizeDate('30.02.2026'),null);});
test('official redirects cannot leave the allowlist',async()=>{
 await assert.rejects(fetchWithRetry('https://cbr.ru/a',{retries:0,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}})}),/UNTRUSTED_SOURCE_REDIRECT/);
});
test('official redirects may remain within trusted HTTPS',async()=>{
 let n=0;const result=await fetchWithRetry('https://cbr.ru/a',{retries:0,fetchImpl:async()=>++n===1?new Response(null,{status:301,headers:{location:'/b'}}):new Response('source')});
 assert.equal(await result.text(),'source');assert.equal(n,2);
});
test('source body size is bounded even without content-length',async()=>{
 await assert.rejects(fetchWithRetry('https://cbr.ru/a',{retries:0,maxResponseBytes:3,fetchImpl:async()=>new Response('too large')}),/SOURCE_RESPONSE_TOO_LARGE/);
});
test('source timeout covers a stalled body, not only response headers',async()=>{
 await assert.rejects(fetchWithRetry('https://cbr.ru/a',{retries:0,timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))}),/SOURCE_TIMEOUT/);
});
test('source timeout also covers a stalled request',async()=>{
 await assert.rejects(fetchWithRetry('https://cbr.ru/a',{retries:0,timeoutMs:20,fetchImpl:()=>new Promise(()=>{})}),/SOURCE_TIMEOUT/);
});
test('transient source failure is retried and a permanent one is not',async()=>{
 let n=0;await fetchWithRetry('https://cbr.ru/a',{retries:1,fetchImpl:async()=>++n===1?new Response('',{status:503}):new Response('ok')});assert.equal(n,2);
 n=0;await assert.rejects(fetchWithRetry('https://cbr.ru/a',{retries:2,fetchImpl:async()=>{n++;return new Response('',{status:404});}}),/SOURCE_HTTP_404/);assert.equal(n,1);
});
test('declared Russian encoding is decoded correctly',async()=>{
 const r=new Response(new Uint8Array([0xc0,0xc1]),{headers:{'content-type':'text/plain; charset=windows-1251'}});
 assert.equal(await responseText(r),'\u0410\u0411');
});
test('only safe extraction error categories are persisted',()=>{
 assert.equal(extractionErrorCode(new Error('SOURCE_TIMEOUT')),'SOURCE_TIMEOUT');
 assert.equal(extractionErrorCode(new Error('secret-token-and-url')),'EXTRACTION_FAILED');
});
function minimalPdf(text) {
 const contents=text?`BT /F1 12 Tf 30 780 Td (${text.replace(/[()\\]/g,'\\$&')}) Tj ET`:'';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`];
 let output='%PDF-1.4\n',offsets=[0];
 objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
 const xref=Buffer.byteLength(output);output+=`xref\n0 6\n0000000000 65535 f \n`;
 output+=offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
 output+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(output);
}
let hasPdfTool=true;try{execFileSync('pdftotext',['-v'],{stdio:'ignore'});}catch{hasPdfTool=false;}
test('native PDF text extraction reads the actual PDF text layer',{skip:!hasPdfTool},async()=>{
 // Multiple lines keep text inside the page rather than relying on clipping.
 const text='SYNTHETIC TEST ONLY. A business must check its source document before taking action. This is not a real legal rule.';
 const actual=await pdfText(minimalPdf(text));assert.ok(actual.includes('SYNTHETIC TEST ONLY'));assert.ok(actual.includes('business'));
});
test('PDF without a text layer fails closed instead of inventing content',{skip:!hasPdfTool},async()=>await assert.rejects(pdfText(minimalPdf('')),/SOURCE_PDF_TEXT_UNAVAILABLE/));
test('invalid PDF magic is rejected',async()=>await assert.rejects(pdfText(Buffer.from('not a pdf')),/SOURCE_PDF_PARSE_FAILED/));

test('readable core copy exists for every seed rule and never overwrites later versions',()=>{
 for(const rule of rules) {
   const current=impact({ruleId:rule.ruleId,ruleVersion:1,rule});
   const copy=readableRule(current);
   assert.ok(copy.title.length>5);
   assert.ok(!/MVP|B2C|facts\\./.test(copy.title+' '+copy.summary));
   assert.equal(readableRule({...current,ruleVersion:2,rule:{...rule,userTitle:'Future revision title',summary:'Future revision summary'}}).title,'Future revision title');
   for(const action of rule.actions) {
     const result=readableAction(current,action);
     assert.ok(result.title.length>0);
     assert.ok(!/MVP|B2C/.test(result.title+' '+result.description));
   }
 }
});
