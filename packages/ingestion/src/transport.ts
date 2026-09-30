/** Bounded transport: the timeout covers headers AND the complete decoded body. */
export type FetchOptions = {
  fetchImpl?: typeof fetch; timeoutMs?: number; userAgent?: string; retries?: number; maxResponseBytes?: number;
};
export function trustedOfficialUrl(value:string):boolean {
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&
      ['pravo.gov.ru','government.ru','nalog.gov.ru','cbr.ru','rospotrebnadzor.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  } catch{return false;}
}
async function boundedBody(response:Response,limit:number):Promise<Uint8Array> {
  const announced=Number(response.headers.get('content-length'));
  if(announced>limit){await response.body?.cancel();throw new Error('SOURCE_RESPONSE_TOO_LARGE');}
  const reader=response.body?.getReader();
  if(!reader)return new Uint8Array();
  const parts:Uint8Array[]=[];let length=0;
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;
      if(length>limit){await reader.cancel();throw new Error('SOURCE_RESPONSE_TOO_LARGE');}
      parts.push(value);
    }
    const result=new Uint8Array(length);let offset=0;
    for(const part of parts){result.set(part,offset);offset+=part.byteLength;}
    return result;
  }finally{reader.releaseLock();}
}
export async function fetchWithRetry(url:string,options:FetchOptions={}):Promise<Response> {
  const attempts=Math.max(1,Math.min(5,Math.floor(options.retries??1)+1));
  const limit=options.maxResponseBytes??20*1024*1024;
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('INVALID_SOURCE_SIZE_LIMIT');
  let lastError:unknown;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let terminal=false;
    try{
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('SOURCE_TIMEOUT'));},options.timeoutMs??20000);});
      const work=async()=>{
        const protectedSource=trustedOfficialUrl(url);let current=url;
        for(let redirects=0;;redirects++){
          const response=await (options.fetchImpl??fetch)(current,{
            headers:{'User-Agent':options.userAgent??'max-regulatory-control/0.9.10'},signal:controller.signal,
            ...(protectedSource?{redirect:'manual' as const}:{})
          });
          if(protectedSource&&response.redirected&&response.url&&!trustedOfficialUrl(response.url)){
            terminal=true;await response.body?.cancel();throw new Error('UNTRUSTED_SOURCE_REDIRECT');
          }
          if(protectedSource&&[301,302,303,307,308].includes(response.status)){
            const location=response.headers.get('location');await response.body?.cancel();
            if(!location||redirects>=5){terminal=true;throw new Error('SOURCE_REDIRECT_LIMIT');}
            const next=new URL(location,current).toString();
            if(!trustedOfficialUrl(next)){terminal=true;throw new Error('UNTRUSTED_SOURCE_REDIRECT');}
            current=next;continue;
          }
          if(!response.ok){terminal=response.status<500&&response.status!==429;await response.body?.cancel();throw new Error('SOURCE_HTTP_'+response.status);}
          const bytes=await boundedBody(response,limit);
          const headers=new Headers(response.headers);
          // fetch() already decoded transport compression. Do not describe the
          // new in-memory body as compressed a second time.
          headers.delete('content-encoding');headers.delete('content-length');
          return new Response([204,205].includes(response.status)?null:bytes,{status:response.status,headers});
        }
      };
      return await Promise.race([work(),timeout]);
    }catch(error){
      lastError=controller.signal.aborted?new Error('SOURCE_TIMEOUT'):error;
      if(terminal||(error instanceof Error&&error.message==='SOURCE_RESPONSE_TOO_LARGE'))break;
    }finally{clearTimeout(timer);}
    if(attempt<attempts)await new Promise(resolve=>setTimeout(resolve,Math.min(1500,250*attempt)));
  }
  throw lastError instanceof Error?lastError:new Error('SOURCE_FETCH_FAILED');
}
export async function responseText(response:Response):Promise<string> {
  const bytes=await response.arrayBuffer();
  const type=response.headers.get('content-type')??'';
  const declared=/charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(type)?.[1]??'utf-8';
  const charset=declared.toLowerCase();
  if(!['utf-8','utf8','windows-1251','cp1251','koi8-r','utf-16le','utf-16be'].includes(charset))throw new Error('SOURCE_ENCODING_UNSUPPORTED');
  return new TextDecoder(charset,{fatal:true}).decode(bytes);
}
export function extractionErrorCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  // Only known categories are persisted, never source URLs, provider responses,
  // tokens or arbitrary stack traces.
  for(const code of ['SOURCE_TIMEOUT','SOURCE_RESPONSE_TOO_LARGE','SOURCE_TEXT_TOO_LONG','SOURCE_TEXT_REQUIRED',
    'UNTRUSTED_SOURCE_REDIRECT','SOURCE_REDIRECT_LIMIT','SOURCE_ENCODING_UNSUPPORTED','SOURCE_HTTP_401','SOURCE_HTTP_403','SOURCE_HTTP_404','SOURCE_HTTP_429',
    'SOURCE_PDF_TOOL_MISSING','SOURCE_PDF_TEXT_UNAVAILABLE','SOURCE_PDF_PARSE_FAILED','SOURCE_UNSUPPORTED_CONTENT_TYPE',
    'EXTRACTION_QUALITY_GATE_FAILED','EXTRACTION_SCHEMA_INVALID']){
    if(message===code||message.startsWith(code+':'))return code;
  }
  return 'EXTRACTION_FAILED';
}
