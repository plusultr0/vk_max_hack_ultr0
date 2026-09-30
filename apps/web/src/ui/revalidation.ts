import { useEffect,useRef } from 'react';

/** Resume/focus events often arrive together. Coalesce them and never fetch over
 * an active mutation. Keep the latest callback without re-registering listeners. */
export function useAppRevalidation(enabled:boolean,run:()=>Promise<unknown>,paused:boolean) {
  const latest=useRef(run),pausedRef=useRef(paused),pending=useRef(false);
  const kick=useRef<(()=>void)|null>(null);
  latest.current=run;pausedRef.current=paused;
  useEffect(()=>{
    if(!enabled)return;
    let live=true,running=false,timer:ReturnType<typeof setTimeout>|undefined;
    const execute=async()=>{
      timer=undefined;
      if(!live||document.visibilityState==='hidden')return;
      if(pausedRef.current||running){pending.current=true;return;}
      pending.current=false;running=true;
      try{await latest.current();}finally{
        running=false;
        if(live&&pending.current)schedule();
      }
    };
    const schedule=()=>{
      if(!live)return;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>void execute(),150);
    };
    const visible=()=>{if(document.visibilityState==='visible')schedule();};
    kick.current=schedule;
    window.addEventListener('focus',schedule);
    window.addEventListener('pageshow',schedule);
    window.addEventListener('online',schedule);
    document.addEventListener('visibilitychange',visible);
    const interval=setInterval(visible,60_000);
    return()=>{
      live=false;kick.current=null;
      if(timer)clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('focus',schedule);
      window.removeEventListener('pageshow',schedule);
      window.removeEventListener('online',schedule);
      document.removeEventListener('visibilitychange',visible);
    };
  },[enabled]);
  useEffect(()=>{if(!paused&&pending.current)kick.current?.();},[paused]);
}
