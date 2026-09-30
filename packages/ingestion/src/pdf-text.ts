import { execFile } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Text layer only. Scans go to a human; OCR is deliberately not guessed. */
export async function pdfText(bytes:Uint8Array):Promise<string>{
  if(bytes.length>20*1024*1024)throw new Error('SOURCE_RESPONSE_TOO_LARGE');
  if(Buffer.from(bytes.subarray(0,5)).toString('ascii')!=='%PDF-')throw new Error('SOURCE_PDF_PARSE_FAILED');
  const directory=await mkdtemp(join(tmpdir(),'reg-source-'));
  try{
    const file=join(directory,'source.pdf');await writeFile(file,bytes,{mode:0o600});
    const text=await new Promise<string>((resolve,reject)=>{
      execFile('pdftotext',['-enc','UTF-8','-nopgbrk',file,'-'],{timeout:20000,maxBuffer:2*1024*1024,encoding:'utf8',windowsHide:true},(error,stdout)=>{
        if(error){reject(new Error((error as NodeJS.ErrnoException).code==='ENOENT'?'SOURCE_PDF_TOOL_MISSING':'SOURCE_PDF_PARSE_FAILED'));return;}
        resolve(stdout);
      });
    });
    if(text.trim().length<80)throw new Error('SOURCE_PDF_TEXT_UNAVAILABLE');
    if(text.length>120000)throw new Error('SOURCE_TEXT_TOO_LONG');
    return text;
  }finally{await rm(directory,{recursive:true,force:true});}
}
