export class ApiError extends Error {
  constructor(public code:string,public status=0){super(code);this.name='ApiError';}
}
export function makeApi(base:string,token?:string|null) {
  return async function api<T>(path:string,init:RequestInit={}):Promise<T> {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),30_000);
    try {
      const response=await fetch(base+path,{...init,signal:controller.signal,
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...init.headers}});
      let body:any;
      try{body=await response.json();}catch{throw new ApiError('SERVICE_UNAVAILABLE',response.status);}
      if(!response.ok)throw new ApiError(typeof body?.error==='string'?body.error:'SERVICE_UNAVAILABLE',response.status);
      return body as T;
    } catch(error) {
      if(error instanceof ApiError)throw error;
      throw new ApiError(controller.signal.aborted?'REQUEST_TIMEOUT':'NETWORK_ERROR');
    } finally {clearTimeout(timer);}
  };
}
export function launchData(hash:string,bridgeData?:string) {
  const params=new URLSearchParams(hash.replace(/^#/,''));
  if(params.getAll('WebAppData').length>1)throw new ApiError('MAX_AUTH_FAILED',401);
  return bridgeData?.trim()||params.get('WebAppData')||'';
}
