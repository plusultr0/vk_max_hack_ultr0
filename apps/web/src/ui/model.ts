import type { Impact, FactQuestion } from './types.js';
export function impactKey(i:Pick<Impact,'ruleId'|'ruleVersion'|'timeState'>) {
  return `${i.ruleId}:${i.ruleVersion}:${i.timeState}`;
}
export function needsAttention(i:Impact) {
  return i.isCurrent&&i.verdict!=='not_applicable'&&!['ended','cancelled'].includes(i.timeState)&&
    (i.reviewState==='needs_review'||i.questions.length>0||i.verdict==='needs_info'||
      i.timeState==='active'&&i.complianceState!=='compliant'&&
      (!i.actions.length||i.actions.some(a=>!['completed','dismissed'].includes(a.executionStatus))));
}
export function rankImpact(i:Impact) {
  if(i.questions.length||i.verdict==='needs_info')return 0;
  if(i.reviewState==='needs_review')return 1;
  if(needsAttention(i))return 2;
  if(i.timeState==='upcoming')return 3;
  if(i.verdict==='not_applicable')return 5;
  return 4;
}
export function formatNumberInput(text:string) {
  const compact=text.replace(/[\s\u00a0\u202f]/g,'');
  const match=/^(-?)(\d*)([,.]?)(\d*)$/.exec(compact);
  if(!match)return text;
  const [,sign='',integer='',separator='',fraction='']=match;
  const grouped=integer.replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  return sign+grouped+(separator?','+fraction:'');
}
export function parseNumberInput(text:string,q:Pick<FactQuestion,'min'|'max'>={}) {
  const value=text.replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
  if(!/^-?\d+(?:\.\d+)?$/.test(value))throw new Error('INVALID_FACT_VALUE');
  const number=Number(value);
  if(!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER||
    q.min!=null&&number<q.min||q.max!=null&&number>q.max)throw new Error('INVALID_FACT_VALUE');
  return number;
}
export function safeSourceUrl(value:string) {
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function questionFingerprint(q:FactQuestion) {
  return JSON.stringify([q.field,q.definitionVersion,q.period,q.expectedObservationId,q.inputType]);
}
export function newRequestId() {
  if(globalThis.crypto.randomUUID)return globalThis.crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const s=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

/** A fresh server snapshot missing in an older list is not evidence of staleness. */
export function selectedImpact(detail:{key:string;snapshot:Impact;exact?:boolean}|null,list:Impact[]) {
  return detail ? detail.exact ? detail.snapshot : list.find(i=>impactKey(i)===detail.key)??detail.snapshot : null;
}
export function sourceLabel(value:string) {
  const safe=safeSourceUrl(value);
  if(!safe)return 'Источник';
  const host=new URL(safe).hostname.toLowerCase();
  const matches=(domain:string)=>host===domain||host.endsWith('.'+domain);
  if(['pravo.gov.ru','government.ru','nalog.gov.ru','cbr.ru','rospotrebnadzor.ru','rkn.gov.ru',
    'roskomnadzor.gov.ru','minfin.gov.ru','mintrud.gov.ru','sfr.gov.ru'].some(matches))return 'Официальный источник';
  if(['consultant.ru','pravo.ppt.ru','garant.ru'].some(matches))return 'Справочная публикация';
  return 'Источник';
}
