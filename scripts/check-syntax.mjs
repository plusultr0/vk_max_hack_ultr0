import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const require=createRequire(import.meta.url);
let ts;
try{ts=require('typescript');}catch{
  const path=process.env.REG_TYPESCRIPT_PATH||join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript');
  ts=require(path);
}
const skip=new Set(['node_modules','.git','dist','build','.cache']);
const files=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(skip.has(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(ts|tsx)$/.test(p)&&!p.endsWith('.d.ts'))files.push(p);}}
walk(resolve('.'));
let errors=0;
for(const f of files){const r=ts.transpileModule(readFileSync(f,'utf8'),{fileName:f,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,isolatedModules:true}});for(const d of r.diagnostics||[]){if(d.category!==ts.DiagnosticCategory.Error)continue;errors++;console.error(f+': '+ts.flattenDiagnosticMessageText(d.messageText,'\n'));}}
console.log(JSON.stringify({typescript:ts.version,files:files.length,syntaxErrors:errors,scope:'Syntax/transpilation only; this does not replace typecheck or build.'},null,2));
if(errors)process.exitCode=1;
