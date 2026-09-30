export function createRequestEpoch() {
  let value=0;
  return {begin:()=>++value,invalidate:()=>{value++;},isCurrent:(token:number)=>token===value};
}

