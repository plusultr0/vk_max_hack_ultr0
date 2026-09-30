/** Pure chatbot copy/routing checks without PostgreSQL, MAX network or package install. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url);
let ts;
try{ts=require('typescript');}catch{
  const path=process.env.REG_TYPESCRIPT_PATH||join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript');
  ts=require(path);
}
const root=resolve('.'),out=await mkdtemp(join(tmpdir(),'reg-bot-tests-'));
try{
  let source=await readFile(join(root,'apps/bot/src/scenarios.ts'),'utf8');
  source=source.replace("from '@reg/max'","from './max-stub.js'");
  const built=ts.transpileModule(source,{fileName:'scenarios.ts',reportDiagnostics:true,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,
  }});
  if(built.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw new Error('Syntax errors in chatbot scenarios');
  await writeFile(join(out,'package.json'),'{"type":"module"}');
  await writeFile(join(out,'scenarios.js'),built.outputText);
  await writeFile(join(out,'max-stub.js'),`export const openMiniAppButton=(web_app,text,payload='home')=>({type:'open_app',text,web_app,payload});\nexport const callbackButton=(text,payload)=>({type:'callback',text,payload});\n`);
  const s=await import('file://'+join(out,'scenarios.js'));
  const checks=[];
  function check(name,fn){fn();checks.push(name);}
  check('slash start',()=>assert.equal(s.detectIntent('/start'),'start'));
  check('natural actions',()=>assert.equal(s.detectIntent('что мне нужно сделать'),'actions'));
  check('documents intent',()=>assert.equal(s.detectIntent('какие документы нужны'),'documents'));
  check('history intent',()=>assert.equal(s.detectIntent('покажи историю'),'history'));
  check('legal free text stays safe',()=>assert.equal(s.detectIntent('Можно ли мне продавать этот товар без лицензии?'),'unknown'));
  const baseline={summary:{actionRequired:2,needsInfo:1,verify:3,selfReportedCompleted:4},coverage:{activeRulesAssessed:37},items:[
    {id:'i1',ruleId:'r1',complianceState:'action_required',questions:[],rule:{userTitle:'Проверить сведения на сайте'},actions:[{id:'a1',title:'Разместить сведения',deadline:'2026-10-10',executionStatus:'open',reviewRequired:false}]},
    {id:'i2',ruleId:'r2',complianceState:'unknown',verdict:'needs_info',questions:[{field:'x'}],rule:{userTitle:'Уточнить обработку данных'},actions:[]},
    {id:'i3',ruleId:'r3',complianceState:'unknown',questions:[],rule:{userTitle:'Уведомление Роскомнадзора об обработке персональных данных',summary:'Персональные данные клиентов'},actions:[]},
  ]};
  check('status disclaimer',()=>assert.match(s.statusMessage(baseline),/не полная юридическая экспертиза/));
  check('topic search',()=>assert.equal(s.searchRequirements(baseline,'что у меня по персональным данным?')[0].id,'i3'));
  check('completion callback',()=>assert.deepEqual(s.actionButtons('bot',baseline)[0][0],{type:'callback',text:'Готово 1',payload:'action:ask:a1'}));
  check('native open app',()=>assert.equal(s.mainMenuButtons('bot')[0][0].type,'open_app'));
  check('readiness buckets remain separate',()=>{
    const text=s.documentsMessage({items:[],summary:{total:21,present:1,missing:2,clarify:3,unknown:4,unchecked:5,upcoming:6}});
    assert.match(text,/нужно уточнить: 7/);
    assert.match(text,/ещё не проверено: 5/);
    assert.match(text,/понадобится позже: 6/);
    assert.equal(/undefined|NaN/.test(text),false);
  });
  console.log(JSON.stringify({typescript:ts.version,checks:checks.length,status:'ok',scope:'Pure chatbot routing/copy only; no PostgreSQL or live MAX API.'},null,2));
} finally {await rm(out,{recursive:true,force:true});}
