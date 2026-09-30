/** Runs real pure production modules; does NOT replace Zod, PostgreSQL or React. */
import { createRequire } from 'node:module';
import { readFile,writeFile,mkdir,mkdtemp,rm,cp } from 'node:fs/promises';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync,spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let ts;
try{ts=require('typescript');}catch{
  const globalPath=process.env.REG_TYPESCRIPT_PATH??join(execSync('npm root -g',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),'typescript');
  ts=require(globalPath);
}
const modules=[
  'packages/domain/src/condition.ts','packages/domain/src/effective-date.ts','packages/domain/src/evaluator.ts',
  'packages/domain/src/lifecycle.ts','packages/domain/src/fact-logic.ts','packages/domain/src/targeting-logic.ts',
  'packages/domain/src/presentation.ts','packages/domain/src/business-checks.ts',
  'packages/domain/src/check-state.ts','packages/domain/src/profile-ui.ts','apps/web/src/ui/request-epoch.ts',
  'packages/db/src/canonical.ts','packages/db/src/feed-logic.ts',
  'packages/llm/src/source-segments.ts',
  'packages/ingestion/src/transport.ts','packages/ingestion/src/pdf-text.ts','packages/ingestion/src/text.ts',
  'apps/web/src/ui/types.ts','apps/web/src/ui/model.ts','apps/web/src/ui/client.ts',
];
const out=await mkdtemp(join(tmpdir(),'reg-pure-tests-'));let exit=1;
try{
  await writeFile(join(out,'package.json'),' {"type":"module"} ');
  for(const file of modules){
    const input=await readFile(join(root,file),'utf8');
    const built=ts.transpileModule(input,{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
    if(built.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw new Error('Syntax errors in '+file);
    const dest=join(out,file.replace(/\.ts$/,'.js'));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,built.outputText);
  }
  await cp(join(root,'tests/offline/core.test.mjs'),join(out,'core.test.mjs'));
  await cp(join(root,'tests/offline/journey.test.mjs'),join(out,'journey.test.mjs'));
  console.log('Pure production logic only. TypeScript '+ts.version+'. No database, live APIs, Zod or React runtime asserted.');
  const result=spawnSync(process.execPath,['--test',join(out,'core.test.mjs'),join(out,'journey.test.mjs')],{stdio:'inherit',env:{...process.env,REG_PROJECT_ROOT:root}});
  exit=result.status??1;
}finally{await rm(out,{recursive:true,force:true});}
process.exitCode=exit;
