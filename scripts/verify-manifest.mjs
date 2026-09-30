import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lines=(await readFile(resolve(root,'SOURCE_MANIFEST.sha256'),'utf8')).trim().split('\n');
let checked=0,failed=0;
for(const line of lines){
  const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m){failed++;continue;}
  const target=resolve(root,m[2]);if(!target.startsWith(root+sep)){failed++;continue;}
  try{const hash=createHash('sha256').update(await readFile(target)).digest('hex');if(hash!==m[1]){console.error('MISMATCH '+m[2]);failed++;}else checked++;}
  catch{console.error('MISSING '+m[2]);failed++;}
}
console.log(JSON.stringify({checked,failed,env:'intentionally excluded from public hash manifest'},null,2));
process.exitCode=failed?1:0;
