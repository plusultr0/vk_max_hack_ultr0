import React,{useEffect,useMemo,useRef,useState} from 'react';
import { FactQuestionsForm } from './facts/FactQuestionsForm.js';
import { FIELD_COPY, VALUE_LABELS, formatDate, formatValue, resultCopy, readableRule, readableAction, errorMessage, plainText, auditLabel, reviewReasonText } from '../../../packages/domain/src/presentation.js';
import { makeApi, ApiError, launchData } from './ui/client.js';
import { impactKey, needsAttention, rankImpact, safeSourceUrl, newRequestId, selectedImpact, sourceLabel } from './ui/model.js';
import type { ProfileState, Impact, ImpactList, FactAnswer, Feed, BusinessCheck, CheckList, FactQuestion, AuditEvent, AuditPage, ProfileHistoryEntry, ProfileHistoryPage } from './ui/types.js';

import { INDUSTRY_VALUES,REQUIRED_PROFILE_FIELDS,OPTIONAL_PROFILE_FIELDS,profileWarnings,profileChanges } from '../../../packages/domain/src/profile-ui.js';
import { useAppRevalidation } from './ui/revalidation.js';
import { createRequestEpoch } from './ui/request-epoch.js';
import { StyledSelect } from './ui/StyledSelect.js';

declare global {
  interface Window {
    WebApp?:{initData?:string;platform?:string;version?:string;openLink?:(url:string)=>void;
      enableClosingConfirmation?:()=>void;disableClosingConfirmation?:()=>void;};
  }
}
type View='check'|'feed'|'profile'|'documents'|'detail'|'history';
type Detail={key:string;snapshot:Impact;origin:View;exact?:boolean};
type Session={token:string;companyId:string;startParam?:string|null;dev?:boolean};
type Edit={data:Record<string,unknown>;answeredFields:string[];baseProfileVersion:number};
const BASE=import.meta.env.VITE_API_URL??'';
const apiWithoutSession=makeApi(BASE);
const fields=[...REQUIRED_PROFILE_FIELDS];
const allProfileFields=[...REQUIRED_PROFILE_FIELDS,...OPTIONAL_PROFILE_FIELDS];
const profileQuestions:FactQuestion[]=allProfileFields.map(field=>({
  field,text:FIELD_COPY[field]!.question,hint:FIELD_COPY[field]!.hint,placeholder:FIELD_COPY[field]!.placeholder,
  inputType:field==='region'?'text':field==='legalForm'||field==='industry'||field==='taxRegime'?'select':field==='salesChannels'?'multi_select':'boolean',
  options:field==='legalForm'?['IP','LLC','other'].map(value=>({value,label:VALUE_LABELS[value]!})):
    field==='industry'?INDUSTRY_VALUES.map(value=>({value,label:VALUE_LABELS[value]!})):
    field==='taxRegime'?['USN','OSNO','other'].map(value=>({value,label:VALUE_LABELS[value]!})):
    field==='salesChannels'?['own_site','marketplace','social','messenger','offline','other'].map(value=>({value,label:VALUE_LABELS[value]!})):undefined
}));
let authInFlight:Promise<Session>|null=null;
async function authenticate():Promise<Session> {
  if(authInFlight)return authInFlight;
  authInFlight=(async()=>{
    const initData=launchData(location.hash,window.WebApp?.initData);
    // A signed MAX launch always supersedes a session from a previous launch.
    if(initData)return apiWithoutSession<Session>('/auth/max',{method:'POST',body:JSON.stringify({initData})});
    const stored=sessionStorage.getItem('reg.session');
    if(stored) {
      try {
        const me=await makeApi(BASE,stored)<Omit<Session,'token'>>('/auth/me');
        return {...me,token:stored};
      }catch(error){if(!(error instanceof ApiError)||error.status!==401)throw error;sessionStorage.removeItem('reg.session');}
    }
    try{return await apiWithoutSession<Session>('/auth/dev',{method:'POST',body:JSON.stringify({userId:'dev-browser'})});}
    catch(error){if(error instanceof ApiError&&error.status===404)throw new ApiError('DEV_AUTH_UNAVAILABLE');throw error;}
  })();
  try{return await authInFlight;}finally{authInFlight=null;}
}
function sources(items:{id:string;url:string;label:string}[]) {
  return items.map(item=>{
    const url=safeSourceUrl(item.url);if(!url)return null;
    return <a key={item.id} href={url} target="_blank" rel="noopener noreferrer"
      onClick={e=>{if(window.WebApp?.openLink){e.preventDefault();window.WebApp.openLink(url);}}}><span className="source-link-kicker">{sourceLabel(url)}</span><span className="source-link-title">{plainText(item.label,'Открыть источник')}</span><span className="source-link-arrow" aria-hidden="true">↗</span></a>;
  });
}
function detailBackLabel(origin:View) {
  if(origin==='feed')return '← К изменениям';
  if(origin==='documents')return '← К документам и настройкам';
  if(origin==='history')return '← К истории';
  return '← К требованиям';
}
function reasonHeading(impact:Impact) {
  if(impact.verdict==='not_applicable')return 'Почему не относится';
  if(impact.reviewState==='needs_review')return 'Что важно проверить';
  if(impact.questions.length||impact.verdict==='needs_info')return 'Что важно знать';
  return 'Почему относится';
}
function questionCountLabel(count:number) {
  const mod10=count%10,mod100=count%100;
  const word=mod10===1&&mod100!==11?'вопрос':mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?'вопроса':'вопросов';
  return `${count} ${word}`;
}
function cardMeta(impact:Impact) {
  if(impact.questions.length)return `Нужно ответить: ${questionCountLabel(impact.questions.length)}`;
  if(impact.timeState==='upcoming'&&impact.effectiveFrom)return 'Начнёт действовать '+formatDate(impact.effectiveFrom);
  if(impact.timeState==='active'&&impact.effectiveFrom)return 'Действует с '+formatDate(impact.effectiveFrom);
  return 'Рассчитано по вашим ответам';
}
function sameEdit(a:Edit,b:Edit) {
  const left=[a.data,[...a.answeredFields].sort()];
  const right=[b.data,[...b.answeredFields].sort()];
  return JSON.stringify(left)===JSON.stringify(right);
}
export default function App() {
  const [session,setSession]=useState<Session|null>(null);
  const [profile,setProfile]=useState<ProfileState|null>(null);
  const [edit,setEdit]=useState<Edit|null>(null);
  const [impacts,setImpacts]=useState<ImpactList>({profileVersion:null,impacts:[]});
  const [view,setView]=useState<View>('check');
  const [detail,setDetail]=useState<Detail|null>(null);
  const [feed,setFeed]=useState<Feed|null>(null);
  const [checks,setChecks]=useState<CheckList|null>(null);
  const [history,setHistory]=useState<Impact[]>([]);
  const [events,setEvents]=useState<AuditEvent[]>([]);
  const [auditCursor,setAuditCursor]=useState<string|null>(null);
  const [profileHistory,setProfileHistory]=useState<ProfileHistoryEntry[]>([]);
  const [profileCursor,setProfileCursor]=useState<number|null>(null);
  const [filter,setFilter]=useState('attention');
  const [feedFilter,setFeedFilter]=useState('relevant');
  const [booting,setBooting]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const mainRef=useRef<HTMLElement>(null);
  const readEpoch=useRef(createRequestEpoch());
  const [answering,setAnswering]=useState(false);
  const [syncError,setSyncError]=useState('');
  useEffect(()=>()=>readEpoch.current.invalidate(),[]);
  const api=useMemo(()=>makeApi(BASE,session?.token),[session?.token]);
  const savedProfileEdit=profile?{data:profile.draft.data,answeredFields:profile.draft.answeredFields,baseProfileVersion:profile.draft.baseProfileVersion}:null;
  const hasUnsavedChanges=!!edit&&!!savedProfileEdit&&!sameEdit(edit,savedProfileEdit);
  // A saved server draft is not confirmed yet. Retrying after a failed confirm
  // remains possible even when PUT already succeeded or the app was reopened.
  const hasUnconfirmedDraft=!!profile?.confirmed&&profileChanges(profile.confirmed,profile.draft.data).length>0;
  type RefreshOptions={feed?:{filter:string;offset?:number};checks?:boolean;verify?:Detail|null};
  async function refreshData(activeApi=api,options:RefreshOptions={}) {
    const ticket=readEpoch.current.begin();
    // Checklist import/secondary reads finish first; main results then reflect
    // the same or newer action state rather than retaining an older snapshot.
    const [nextFeed,nextChecks]=await Promise.all([
      options.feed?activeApi<Feed>(`/regulatory/feed?filter=${encodeURIComponent(options.feed.filter)}&offset=${options.feed.offset??0}`):null,
      options.checks?activeApi<CheckList>('/company/checks'):null
    ]);
    const [p,list,verified]=await Promise.all([
      activeApi<ProfileState>('/company/profile'),activeApi<ImpactList>('/impacts'),
      options.verify&&!options.verify.exact?activeApi<Impact>('/impacts/'+encodeURIComponent(options.verify.snapshot.id)):null
    ]);
    if(!readEpoch.current.isCurrent(ticket))return {profile:p,impacts:list,accepted:false};
    setProfile(p);setImpacts(list);setSyncError('');
    if(nextFeed){
      setFeed(old=>options.feed?.offset&&old?{...nextFeed,items:[...old.items,...nextFeed.items.filter(i=>!old.items.some(o=>impactKey(o.impact)===impactKey(i.impact)))]}:nextFeed);
      setFeedFilter(options.feed!.filter);
    }
    if(nextChecks)setChecks(nextChecks);
    setDetail(old=>{
      if(!old||old.exact)return old;
      const next=list.impacts.find(i=>impactKey(i)===old.key);
      if(next)return {...old,snapshot:next,exact:false};
      return verified&&verified.id===old.snapshot.id?{...old,snapshot:verified,exact:!verified.isCurrent}:old;
    });
    return {profile:p,impacts:list,accepted:true};
  }
  async function revalidateVisible() {
    try{await refreshData(api,{feed:view==='feed'?{filter:feedFilter}:undefined,checks:view==='documents',verify:view==='detail'?detail:null});}
    catch{setSyncError('Не удалось получить свежие данные. Показан последний загруженный результат. Повторите обновление.');}
  }
  useAppRevalidation(!!session&&!booting,revalidateVisible,busy||answering);
  useEffect(()=>{
    let live=true;
    void(async()=>{
      try {
        const s=await authenticate();
        sessionStorage.setItem('reg.session',s.token);
        const client=makeApi(BASE,s.token);
        const [p,list]=await Promise.all([client<ProfileState>('/company/profile'),client<ImpactList>('/impacts')]);
        if(!live)return;
        setSession(s);setProfile(p);setImpacts(list);setView(p.confirmed?'check':'profile');
        const draft=sessionStorage.getItem('reg.draft.'+s.companyId);
        if(draft)try{const saved=JSON.parse(draft);if(saved.baseProfileVersion===p.draft.baseProfileVersion)setEdit({...saved.edit,baseProfileVersion:saved.baseProfileVersion});}catch{/* Ignore a malformed local draft. */}
        // Bot open_app buttons use start_param as a small navigation contract.
        // An unfinished profile always wins because personalized views are not valid yet.
        if(!p.confirmed) {
          setView('profile');
        } else if(s.startParam?.startsWith('assessment_')) {
          const card=await client<Impact>('/impacts/'+encodeURIComponent(s.startParam.slice(11)));
          if(live){setDetail({key:impactKey(card),snapshot:card,origin:'check',exact:!card.isCurrent});setView('detail');}
        } else if(s.startParam?.startsWith('impact_')) {
          const card=list.impacts.find(i=>i.ruleId===s.startParam!.slice(7));
          if(card){setDetail({key:impactKey(card),snapshot:card,origin:'check'});setView('detail');}
        } else if(s.startParam==='profile') {
          setView('profile');
        } else if(s.startParam==='feed') {
          const data=await client<Feed>('/regulatory/feed?filter=relevant&offset=0');
          const latest=await client<ImpactList>('/impacts');
          if(live){setImpacts(latest);setFeed(data);setFeedFilter('relevant');setView('feed');}
        } else if(s.startParam==='documents') {
          const data=await client<CheckList>('/company/checks');
          const latest=await client<ImpactList>('/impacts');
          if(live){setImpacts(latest);setChecks(data);setView('documents');}
        } else if(s.startParam==='history') {
          const [data,a,h]=await Promise.all([client<ImpactList>('/impacts/history'),client<AuditPage>('/audit'),client<ProfileHistoryPage>('/company/profile/history')]);
          if(live){setHistory(data.impacts.filter(i=>!i.isCurrent));setEvents(a.items);setAuditCursor(a.nextCursor??null);
            setProfileHistory(h.items);setProfileCursor(h.nextVersion??null);setView('history');}
        } else if(['home','check','actions'].includes(s.startParam??'')) {
          setView('check');
        }
      }catch(e){if(live)setError(errorMessage(e));}
      finally{if(live)setBooting(false);}
    })();
    return()=>{live=false;};
  },[]);
  useEffect(()=>{
    if(!session||!profile)return;
    if(!edit||!hasUnsavedChanges){sessionStorage.removeItem('reg.draft.'+session.companyId);window.WebApp?.disableClosingConfirmation?.();return;}
    sessionStorage.setItem('reg.draft.'+session.companyId,JSON.stringify({baseProfileVersion:edit.baseProfileVersion,edit}));
    window.WebApp?.enableClosingConfirmation?.();
    const before=(e:BeforeUnloadEvent)=>{e.preventDefault();};
    window.addEventListener('beforeunload',before);
    return()=>window.removeEventListener('beforeunload',before);
  },[edit,hasUnsavedChanges,session?.companyId,profile?.draft.baseProfileVersion]);
  useEffect(()=>{
    if(!impacts.refreshPending||impacts.refreshFailures||!session||busy||answering)return;
    let live=true,attempts=0;
    const timer=setInterval(()=>{
      if(++attempts>12){clearInterval(timer);if(live)setError('Пересчёт занял больше времени, чем обычно. Попробуйте обновить требования ещё раз.');return;}
      if(live)void revalidateVisible();
    },5000);
    return()=>{live=false;clearInterval(timer);};
  },[impacts.refreshPending,impacts.refreshFailures,session?.token,busy,answering,view,feedFilter,detail?.key]);
  function navigate(next:View) {
    if(busy||answering)return;
    setError('');setNotice('');setView(next);
    requestAnimationFrame(()=>mainRef.current?.focus());
    if(next==='feed')void loadFeed(feedFilter);
    if(next==='documents')void loadChecks();
    if(next==='check'||next==='profile')void refreshData().catch(()=>setSyncError('Не удалось обновить данные. Повторите обновление.'));
  }
  async function loadFeed(next=feedFilter,offset=0) {
    setBusy(true);
    try{await refreshData(api,{feed:{filter:next,offset}});}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function loadChecks() {
    setBusy(true);
    try{await refreshData(api,{checks:true});}catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function refreshResults() {
    readEpoch.current.invalidate();setBusy(true);setError('');
    try {
      await api('/company/compliance/refresh',{method:'POST',body:'{}'});
      const next=await refreshData(api,{checks:view==='documents',feed:view==='feed'?{filter:feedFilter}:undefined,verify:view==='detail'?detail:null});
      setNotice(next.impacts.refreshFailures?'Часть требований пока не удалось пересчитать. Повторите попытку позже.':next.impacts.refreshPending?'Ответы сохранены. Пересчёт ещё продолжается.':'Результаты обновлены.');
    } catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  function openImpact(impact:Impact,origin:View=view) {
    const opened:Detail={key:impactKey(impact),snapshot:impact,origin:origin==='detail'?'check':origin,exact:!impact.isCurrent};
    setDetail(opened);
    setView('detail');setNotice('');setError('');
    if(impact.isCurrent){
      setBusy(true);
      void refreshData(api,{verify:opened}).catch(()=>setSyncError('Не удалось проверить актуальность карточки. Обновите данные перед внесением отметок.')).finally(()=>setBusy(false));
    }
    requestAnimationFrame(()=>mainRef.current?.focus());
  }
  async function openCheckImpact(check:BusinessCheck) {
    const local=impacts.impacts.find(i=>i.id===check.impactId);
    if(local){openImpact(local,'documents');return;}
    setBusy(true);
    try{const card=await api<Impact>('/impacts/'+encodeURIComponent(check.impactId));setBusy(false);openImpact(card,'documents');}
    catch(e){setError(errorMessage(e));setBusy(false);}
  }
  async function answerQuestions(impact:Impact,answers:FactAnswer[],requestId:string,editAnswers=false) {
    readEpoch.current.invalidate();setAnswering(true);
    try {
    const result=await api<{impacts:ImpactList}>(`/impacts/${impact.id}/answers`,{method:'POST',body:JSON.stringify({requestId,answers,...(editAnswers?{edit:true}:{})})});
    setImpacts(result.impacts);
    const next=result.impacts.impacts.find(i=>impactKey(i)===impactKey(impact));
    if(next)setDetail(old=>old?.key===impactKey(impact)?{...old,snapshot:next,exact:false}:old);
    setNotice(next?.questions.length?'Ответы сохранены. Оставшиеся вопросы можно уточнить позже.':'Ответы сохранены. Результат обновлён.');
    requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelector('.impact-detail .page-heading')?.scrollIntoView({behavior:'smooth',block:'start'})));
    // A failed secondary refresh must not turn a committed answer into an error.
    try{await refreshData();}catch{setSyncError('Ответы сохранены. Не удалось обновить остальные данные; повторите обновление.');}
    setChecks(null);setFeed(null);
    }finally{setAnswering(false);}
  }
  async function updateAction(actionId:string,status:string) {
    readEpoch.current.invalidate();setBusy(true);setError('');
    try {
      await api(`/actions/${actionId}`,{method:'PATCH',body:JSON.stringify({status})});
      setNotice(status==='completed'?'Вы отметили действие как выполненное.':'Отметка о выполнении отменена.');
      try{await refreshData();}catch{setSyncError('Отметка сохранена, но свежий результат пока не загрузился. Обновите данные перед следующей отметкой.');}
      setChecks(null);setFeed(null);
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function saveProfile() {
    if(!profile||busy)return;
    const current=edit??{data:profile.draft.data,answeredFields:profile.draft.answeredFields,baseProfileVersion:profile.draft.baseProfileVersion};
    if(!fields.every(f=>current.answeredFields.includes(f))) {setError(errorMessage('PROFILE_INCOMPLETE'));return;}
    readEpoch.current.invalidate();setBusy(true);setError('');
    try {
      const p=await api<ProfileState>('/company/profile',{method:'PUT',body:JSON.stringify({
        patch:{...current.data,region:typeof current.data.region==='string'?current.data.region.trim()||null:current.data.region},answeredFields:current.answeredFields,baseProfileVersion:current.baseProfileVersion})});
      setProfile(p);
      const result=await api<{profile:Record<string,unknown>;impacts:ImpactList}>('/company/profile/confirm',{method:'POST',body:'{}'});
      setImpacts(result.impacts);setEdit(null);
      sessionStorage.removeItem('reg.draft.'+session!.companyId);window.WebApp?.disableClosingConfirmation?.();
      const {profileVersion,confirmedAt,...confirmedData}=result.profile;
      setProfile({...p,confirmed:result.profile,draft:{data:confirmedData,answeredFields:p.draft.answeredFields,baseProfileVersion:Number(profileVersion)}});
      setChecks(null);setFeed(null);
      setFilter('attention');setView('check');setNotice('Информация сохранена. Вот требования, которые могут относиться к вашему бизнесу.');
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function openHistory() {
    readEpoch.current.invalidate();setBusy(true);setError('');
    try {
      const [list,a,h]=await Promise.all([api<ImpactList>('/impacts/history'),api<AuditPage>('/audit'),api<ProfileHistoryPage>('/company/profile/history')]);
      setHistory(list.impacts.filter(i=>!i.isCurrent));setEvents(a.items);setAuditCursor(a.nextCursor??null);
      setProfileHistory(h.items);setProfileCursor(h.nextVersion??null);setView('history');
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function loadMoreHistory(kind:'audit'|'profile') {
    setBusy(true);setError('');
    try {
      if(kind==='audit'&&auditCursor){
        const page=await api<AuditPage>('/audit?beforeId='+encodeURIComponent(auditCursor));
        setEvents(old=>[...old,...page.items.filter(i=>!old.some(o=>o.id===i.id))]);setAuditCursor(page.nextCursor??null);
      }
      if(kind==='profile'&&profileCursor){
        const page=await api<ProfileHistoryPage>('/company/profile/history?beforeVersion='+profileCursor);
        setProfileHistory(old=>[...old,...page.items.filter(i=>!old.some(o=>o.id===i.id))]);setProfileCursor(page.nextVersion??null);
      }
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const visible=useMemo(()=>impacts.impacts.filter(i=>filter==='all'||filter==='attention'&&needsAttention(i)||
    filter==='upcoming'&&i.timeState==='upcoming'&&i.verdict!=='not_applicable'||filter==='not_applicable'&&i.verdict==='not_applicable')
    .sort((a,b)=>rankImpact(a)-rankImpact(b)||a.rule.userTitle.localeCompare(b.rule.userTitle,'ru')),[impacts,filter]);
  const attention=impacts.impacts.filter(needsAttention).length;
  const selected=selectedImpact(detail,impacts.impacts);
  const activeNav=view==='feed'||view==='detail'&&detail?.origin==='feed'?'feed':view==='profile'||view==='history'?'profile':'check';
  const currentEdit=edit??savedProfileEdit;
  if(booting)return <main className="launch-screen"><div className="spinner" aria-hidden="true"/><h1>Подбираем требования для бизнеса</h1><p role="status">Загружаем ваши данные…</p></main>;
  if(!profile)return <main className="launch-screen"><h1>Не удалось открыть приложение</h1><p role="alert">{error}</p><button className="primary" onClick={()=>location.reload()}>Попробовать ещё раз</button></main>;
  const navigation=<>{([['check','Требования'],['feed','Изменения'],['profile','Мой бизнес']] as const).map(([id,label])=><button key={id} disabled={busy||answering} aria-current={activeNav===id?'page':undefined} className={activeNav===id?'active':''} onClick={()=>navigate(id)}><span>{label}</span>{id==='check'&&attention>0&&<small>{attention}</small>}</button>)}</>;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('check');}}><span className="brand-mark" aria-hidden="true">✓</span><span>Check Право</span></a>
      {session?.dev&&<span className="dev-label">Тестовый режим</span>}</header>
    <div className={view==='detail'?'layout layout-detail':'layout'}><aside className="sidebar"><nav aria-label="Основные разделы">{navigation}</nav></aside>
      <main ref={mainRef} tabIndex={-1} className="content">
        {notice&&<div className="notice" role="status"><span>{notice}</span><button aria-label="Скрыть сообщение" onClick={()=>setNotice('')}>×</button></div>}
        {error&&<div className="error-note" role="alert"><p>{error}</p><button className="message-close" aria-label="Скрыть сообщение" onClick={()=>setError('')}>×</button></div>}
        {syncError&&<div className="error-note" role="alert"><p>{syncError}</p><button disabled={busy||answering} onClick={()=>void revalidateVisible()}>Обновить данные</button></div>}
        {!!impacts.refreshFailures&&<div className="error-note" role="alert"><p><b>Не удалось пересчитать часть требований.</b> Ваши ответы сохранены. Не считайте список окончательным, пока пересчёт не завершится.</p><button disabled={busy||answering} onClick={()=>void refreshResults()}>Повторить пересчёт</button></div>}
        {impacts.refreshPending&&!impacts.refreshFailures&&<div className="pending" role="status"><span><b>Обновляем требования после ваших изменений.</b> Ответы уже сохранены; обычно пересчёт занимает несколько секунд.</span><button className="text-button" disabled={busy} onClick={()=>void refreshResults()}>Обновить сейчас</button></div>}
        {view==='check'&&<>
          <div className="page-heading"><h1>{profile.confirmed?'Что проверить в вашем бизнесе':'Начнём с вашего бизнеса'}</h1>
            <p>{profile.confirmed?'Сервис подобрал требования законодательства, которые могут относиться к вашему бизнесу по сохранённым данным. Сначала откройте карточки, где нужны ответы или действия. В каждой карточке есть понятное объяснение и ссылка на источник.':'Ответьте на 6 коротких вопросов о бизнесе. Отрасль поможет сразу убрать требования, которые к вам не относятся.'}</p></div>
          {!profile.confirmed?<Empty title="Расскажите, как работает бизнес" text="Нужны 6 коротких ответов. Если чего-то не знаете, выберите «Не знаю» — система не будет заставлять вас угадывать."><button className="primary" onClick={()=>navigate('profile')}>Ответить на вопросы</button></Empty>:<>
            <p className="scope-note catalogue-note">Каталог сервиса не охватывает всё законодательство. Результат зависит от ваших ответов.</p>
            <button className="document-entry" onClick={()=>navigate('documents')}><span><b>Документы и важные настройки</b><span>Быстрая самопроверка: что уже готово, что нужно сделать и что пока неясно</span></span><span aria-hidden="true">→</span></button>
            <div className="list-heading"><h2>Требования <span className="count">{filter==='all'?impacts.impacts.length:`${visible.length} из ${impacts.impacts.length}`}</span></h2>
              <div className="filter-select"><span>Показать</span><StyledSelect testId="requirements-filter" ariaLabel="Показать требования" value={filter} onChange={setFilter} options={[
                {value:'attention',label:'Требуют внимания'},{value:'all',label:'Все требования'},{value:'upcoming',label:'Начнут действовать позже'},{value:'not_applicable',label:'Не относятся к вам'}
              ]}/></div></div>
            {!visible.length?<Empty
              title={!impacts.impacts.length?'Результаты ещё не готовы':filter==='attention'?'Сейчас ничего не требует вашего внимания':'По этому фильтру ничего нет'}
              text={!impacts.impacts.length?'Обновите требования по сохранённым данным бизнеса.':filter==='attention'?'Сейчас нет карточек, где нужны дополнительные ответы или действия.':'Выберите другой вариант в поле «Показать». Пустой список означает только, что под этот фильтр ничего не попало.'}>
              {!impacts.impacts.length&&<button className="primary" disabled={busy} onClick={()=>void refreshResults()}>Обновить требования</button>}
            </Empty>:<div className="card-list">{visible.map(i=><SummaryCard key={impactKey(i)} impact={i} onOpen={()=>openImpact(i)}/>)}</div>}
          </>}
        </>}
        {view==='detail'&&selected&&<>
          <button className="back-link" onClick={()=>navigate(detail?.origin??'check')}>{detailBackLabel(detail?.origin??'check')}</button>
          <ImpactDetail impact={selected} onAnswers={answerQuestions} onAction={updateAction} busy={busy||answering||!!syncError}/>
          {!selected.isCurrent&&<div className="panel"><p>Это предыдущая версия результата. Отметки в ней сохранены в истории.</p>
            {impacts.impacts.find(i=>i.ruleId===selected.ruleId)&&<button className="primary" onClick={()=>openImpact(impacts.impacts.find(i=>i.ruleId===selected.ruleId)!,'check')}>Открыть актуальное требование</button>}
          </div>}
        </>}
        {view==='feed'&&<>
          <div className="page-heading"><h1>Изменения для бизнеса</h1><p>Новые правила, сроки и требования, которые стоит проверить с учётом данных вашего бизнеса.</p></div>
          {!profile.confirmed?<Empty title="Нужна информация о бизнесе" text="После 6 коротких ответов мы сможем отобрать изменения, которые могут относиться к вашему бизнесу."><button className="primary" onClick={()=>navigate('profile')}>Заполнить данные</button></Empty>:<>
            <div className="list-heading feed-filter-row"><h2>Лента изменений</h2><div className="filter-select"><span>Показать</span><StyledSelect testId="feed-filter" ariaLabel="Показать изменения" disabled={busy} value={feedFilter} onChange={value=>void loadFeed(value)} options={[
              {value:'relevant',label:'Могут относиться к моему бизнесу'},{value:'new',label:'Добавлены в сервис за последние 90 дней'},{value:'upcoming',label:'Начнут действовать позже'}
            ]}/></div></div>
            {busy&&<p role="status">Обновляем список…</p>}
            {feed?.items.map(item=><div className="feed-item" key={impactKey(item.impact)}>
              <p className="caption">{item.addedAt?`Добавлено в сервис ${formatDate(item.addedAt)}`:item.discoveredAt?`Обнаружено ${formatDate(item.discoveredAt)}`:'Дата добавления не указана'}{item.publishedAt&&<span> · опубликовано {formatDate(item.publishedAt)}</span>}</p>
              <SummaryCard impact={item.impact} onOpen={()=>openImpact(item.impact,'feed')}/>
            </div>)}
            {!busy&&!feed?.items.length&&<Empty title="В этом списке пока нет изменений" text="Это не означает отсутствия требований к бизнесу. Текущие требования находятся в разделе «Требования»."><button onClick={()=>void loadFeed()}>Обновить ленту</button></Empty>}
            {feed?.nextOffset!=null&&<button className="load-more" disabled={busy} onClick={()=>void loadFeed(feedFilter,feed.nextOffset!)}>Показать ещё</button>}
          </>}
        </>}
        {view==='documents'&&<>
          <button className="back-link" onClick={()=>navigate('check')}>← К требованиям</button>
          <div className="page-heading"><p className="eyebrow">САМОПРОВЕРКА</p><h1>Документы и важные настройки</h1><p>Файлы загружать не нужно. Откройте пункт, проверьте его у себя и отметьте результат. Сервис запомнит только вашу отметку — содержимое документов и настройки он автоматически не проверяет.</p></div>
          <p className="scope-note">{checks?.coverage.warning??'Это рабочий список по требованиям, которые уже есть в сервисе. Он зависит от ваших ответов и не является полным перечнем документов для любой компании.'}</p>
          {checks&&<div className="check-summary" aria-label="Итог по документам и настройкам"><div><b>{checks.summary.present}</b><span>Отмечено готовым</span></div><div><b>{checks.summary.missing}</b><span>Нужно сделать</span></div><div><b>{(checks.summary.clarify??0)+(checks.summary.unknown??0)}</b><span>Нужно уточнить</span></div><div><b>{checks.summary.unchecked??0}</b><span>Ещё не проверено</span></div><div><b>{checks.summary.upcoming??0}</b><span>Понадобится позже</span></div></div>}
          {busy&&!checks&&<p role="status">Собираем список…</p>}
          <div className="card-list">{checks?.items.map(item=><CheckCard key={item.checkKey+':'+item.ruleVersion} check={item} busy={busy||answering||!!syncError} onClarify={()=>void openCheckImpact(item)}
            onAnswer={async(answer,requestId)=>{
              readEpoch.current.invalidate();setAnswering(true);
              try {
              await api('/company/checks/answer',{method:'POST',body:JSON.stringify({requestId,checkKey:item.checkKey,impactId:item.impactId,basisHash:item.basisHash,answer})});
              setNotice('Отметка сохранена. Сервис не открывал документ и не проверял настройку автоматически.');
              try{await refreshData(api,{checks:true});setFeed(null);}catch{setSyncError('Отметка сохранена. Обновите список, чтобы увидеть результат.');}
              }finally{setAnswering(false);}
            }}/>)}</div>
          {!busy&&!checks?.items.length&&<Empty title="Здесь пока нечего отмечать" text="Сначала откройте требования и ответьте на недостающие вопросы. После этого здесь появятся подходящие документы и настройки."><button onClick={()=>navigate('check')}>К требованиям</button></Empty>}
        </>}
        {view==='profile'&&currentEdit&&<>
          <div className="page-heading profile-heading"><h1>{profile.confirmed?'Информация о вашем бизнесе':'Расскажите о своём бизнесе'}</h1><p>{profile.confirmed?'Проверьте ответы и измените только то, что поменялось.':'Всего 6 коротких вопросов о том, как бизнес работает сейчас.'}</p></div>
          {edit&&edit.baseProfileVersion!==profile.draft.baseProfileVersion&&<div className="error-note" role="alert"><p>Данные бизнеса изменились в другом окне или через бота. Ваш несохранённый ввод оставлен на экране. Перед новой отправкой загрузите актуальные ответы и внесите нужные изменения.</p><button onClick={()=>setEdit(null)}>Загрузить сохранённые ответы</button></div>}
          <ProfileForm data={currentEdit} onChange={next=>setEdit(next)} onSubmit={()=>void saveProfile()} busy={busy||!!edit&&edit.baseProfileVersion!==profile.draft.baseProfileVersion} confirmed={!!profile.confirmed} dirty={hasUnsavedChanges||hasUnconfirmedDraft}/>
          {profile.confirmed&&<button className="text-button history-link" disabled={busy} onClick={()=>void openHistory()}>Посмотреть историю изменений</button>}
        </>}
        {view==='history'&&<>
          <button className="back-link" onClick={()=>navigate('profile')}>← К информации о бизнесе</button>
          <div className="page-heading"><p className="eyebrow">ИСТОРИЯ</p><h1>Что менялось</h1><p>Здесь хранятся предыдущие результаты и ваши отметки. Можно посмотреть, как менялся результат после новых ответов или обновления правила.</p></div>
          <section className="panel profile-history"><h2>Как менялись данные бизнеса</h2>
            {profileHistory.length?profileHistory.map(entry=><details key={entry.id} className="conditions">
              <summary>Версия {entry.profile_version} · {formatDate(entry.confirmed_at)}</summary>
              {entry.changes.length?<dl className="profile-diff">{entry.changes.map(c=><div key={c.field}><dt>{FIELD_COPY[c.field]?.title??'Дополнительные данные'}</dt><dd><span>Было: {c.hadBefore?formatValue(c.before):'Не указано'}</span><span>Стало: {c.hasAfter?formatValue(c.after):'Не указано'}</span></dd></div>)}</dl>:<p>Состав ответов не изменился.</p>}
            </details>):<p className="field-help">Сохранённых версий пока нет.</p>}
            {profileCursor!=null&&<button disabled={busy} onClick={()=>void loadMoreHistory('profile')}>Показать более ранние ответы</button>}
          </section>
          <div className="section-heading"><h2>Предыдущие результаты</h2><span className="count">{history.length}</span></div>
          {history.length?<div className="card-list">{history.map(i=><SummaryCard key={i.id} impact={i} onOpen={()=>openImpact(i,'history')}/>)}</div>:<Empty title="Предыдущих результатов пока нет" text="Они появятся, когда результат какого-либо требования пересчитается после новых данных или обновления требования."/>}
          <details className="panel history-events"><summary>Изменения и действия</summary>{events.length?events.map(e=><p key={e.id}><b>{auditLabel(e.event_type)}</b><span className="caption"> {formatDate(e.created_at)}</span></p>):<p className="field-help">Записей пока нет.</p>}{auditCursor&&<button disabled={busy} onClick={()=>void loadMoreHistory('audit')}>Показать ещё события</button>}</details>
        </>}
      </main>
    </div>{view!=='detail'&&<nav className="bottom-nav" aria-label="Разделы приложения">{navigation}</nav>}
  </div>;
}
function Empty({title,text,children}:{title:string;text:string;children?:React.ReactNode}) {
  return <section className="empty-card"><h2>{title}</h2><p>{text}</p>{children}</section>;
}
function SummaryCard({impact,onOpen}:{impact:Impact;onOpen:()=>void}) {
  const status=resultCopy(impact);
  return <button className="summary-card" onClick={onOpen}><span className={'status '+status.tone}>{status.label}</span>
    <h3>{readableRule(impact).title}</h3>
    <p>{readableRule(impact).summary}</p>
    <span className="card-footer"><span>{cardMeta(impact)}</span><b>{status.cta} →</b></span>
  </button>;
}
function ImpactDetail({impact,onAnswers,onAction,busy}:{impact:Impact;onAnswers:(i:Impact,a:FactAnswer[],id:string,edit?:boolean)=>Promise<void>;onAction:(id:string,status:string)=>Promise<void>;busy:boolean}) {
  const status=resultCopy(impact);
  const requiredActions=impact.actions.filter(a=>!a.reviewRequired);
  const completedActions=requiredActions.filter(a=>a.executionStatus==='completed').length;
  const requirementsCompleted=requiredActions.length>0&&completedActions===requiredActions.length;
  return <article className="impact-detail" data-testid="impact-detail" data-rule-id={impact.ruleId}>
    <div className="page-heading"><span className={'status '+status.tone}>{status.label}</span><h1>{readableRule(impact).title}</h1><p>{status.summary}</p></div>
    {impact.isCurrent&&impact.questions.length>0&&<section className="panel question-panel"><h2>{impact.clarificationState==='needs_confirmation'?'Проверьте сохранённые ответы':'Ответьте на несколько вопросов'}</h2>
      <FactQuestionsForm disabled={busy} questions={impact.questions} onSubmit={(a,id)=>onAnswers(impact,a,id)}/>
    </section>}
    {impact.reviewState==='needs_review'&&<section className="review-note"><h2>Что сделать сейчас</h2>{impact.reviewReasons.length?impact.reviewReasons.map((r,i)=><p key={i}>{reviewReasonText(r)}</p>):<p>Откройте источник ниже и проверьте условия, которые сервис не смог определить автоматически. Если от ответа зависят деньги, договоры или сроки, лучше уточнить его у специалиста.</p>}</section>}
    {impact.actions.length>0&&<section className="panel"><h2>{impact.timeState==='upcoming'?'Что можно подготовить заранее':'Что нужно сделать'}</h2><p className="field-help">Выполните подходящие шаги и отмечайте их как выполненные. Сервис сохраняет вашу отметку, но не проверяет выполнение автоматически.</p>
      {impact.actions.map(a=><div className="action-item" key={a.id}><div><h3>{readableAction(impact,a).title}</h3><p>{readableAction(impact,a).description}</p>
        {a.deadline&&<p className="caption">Срок: {formatDate(a.deadline)}</p>}{a.reviewRequired&&<p className="caption">Условия требования изменились. Этот шаг сохранён только для истории.</p>}</div>
        {impact.isCurrent&&impact.timeState==='active'&&impact.verdict==='applies'&&impact.reviewState!=='needs_review'&&!impact.questions.length&&!a.reviewRequired?<button disabled={busy} aria-pressed={a.executionStatus==='completed'} title={a.executionStatus==='completed'?'Нажмите, чтобы снять отметку о выполнении':undefined} className={a.executionStatus==='completed'?'completion selected':'completion'} onClick={()=>void onAction(a.id,a.executionStatus==='completed'?'open':'completed')}>
          {a.executionStatus==='completed'?'✓ Выполнено':'Отметить выполненным'}</button>:a.executionStatus==='completed'?<span className="status success">Было отмечено выполненным</span>:null}
      </div>)}
      {impact.isCurrent&&impact.timeState==='active'&&requiredActions.length>0&&<div className={'requirement-completion '+(requirementsCompleted?'done':'open')}>
        <span className="requirement-completion-kicker">Статус выполнения</span>
        <strong>{requirementsCompleted?'Требования выполнены':'Требования ещё не выполнены'}</strong>
        <p>{requirementsCompleted
          ?'По вашей отметке выполнены все обязательные шаги в этой карточке. Сервис сохраняет вашу отметку, но не подтверждает юридическое соответствие автоматически.'
          :`Вы отметили ${completedActions} из ${requiredActions.length} обязательных шагов. Статус станет «Требования выполнены», когда вы сами отметите каждый шаг.`}</p>
        <span className="requirement-ready">Как понять, что готово: все обязательные шаги выше выполнены и отмечены вами в приложении.</span>
      </div>}
    </section>}
    <section className="panel"><h2>{reasonHeading(impact)}</h2>
      <p>{impact.verdict==='not_applicable'?status.summary:readableRule(impact).summary}</p>
      {impact.isCurrent&&!!impact.editableQuestions?.length&&<details className="conditions">
        <summary>Исправить ответы</summary><p className="field-help">Исправьте только неверные данные. Остальные сохранённые ответы останутся как есть.</p>
        <FactQuestionsForm disabled={busy} questions={impact.editableQuestions} onSubmit={(a,id)=>onAnswers(impact,a,id,true)}/>
      </details>}
    </section>
    <details className="panel source-panel"><summary>Источники и даты</summary>
      {impact.effectiveFrom&&<p>Требование действует с: <b>{formatDate(impact.effectiveFrom)}</b></p>}
      <p>Дата проверки источника: <b>{formatDate(impact.rule.checkedAt)}</b></p>
      <div className="source-links">{sources(impact.rule.evidenceRefs)}</div>
    </details>
  </article>;
}
function ProfileForm({data,onChange,onSubmit,busy,confirmed,dirty}:{data:Edit;onChange:(e:Edit)=>void;onSubmit:()=>void;busy:boolean;confirmed:boolean;dirty:boolean}) {
  function set(field:string,value:unknown,answered=true){const answeredFields=answered?[...new Set([...data.answeredFields,field])]:data.answeredFields.filter(item=>item!==field);onChange({baseProfileVersion:data.baseProfileVersion,data:{...data.data,[field]:value},answeredFields});}
  const complete=fields.filter(f=>data.answeredFields.includes(f)).length;
  const regionPresets=[{value:'Россия',label:'По всей России'},{value:'Россия и СНГ',label:'Россия и СНГ'}] as const;
  const renderQuestion=(q:FactQuestion,index:number,optional=false)=>{
    const value=data.data[q.field],answered=data.answeredFields.includes(q.field),id='profile-'+q.field;
    const isRegion=q.field==='region';
    const customRegion=typeof value==='string'&&!regionPresets.some(item=>item.value===value)?value:'';
    return <fieldset key={q.field} disabled={busy}>
      <legend><span className="question-number">{optional?'Необязательно':`Вопрос ${index+1} из ${fields.length}`}</span><span>{q.text}</span></legend><p className="field-help">{q.hint}</p>
      {isRegion&&<><div className="choices region-presets">{regionPresets.map(item=><button key={item.value} type="button" aria-pressed={answered&&value===item.value} className={answered&&value===item.value?'selected':''} onClick={()=>set(q.field,item.value)}>{item.label}</button>)}</div>
        <label className="region-custom" htmlFor={id}><span>Или укажите конкретный регион / другой охват</span><input id={id} aria-label={q.text} maxLength={200} value={customRegion} placeholder={q.placeholder} onChange={e=>set(q.field,e.target.value,e.target.value.trim().length>0)}/></label>
        <div className="question-actions"><button type="button" className={'secondary-choice '+(answered&&value===null?'selected':'')} onClick={()=>set(q.field,null)}>Не знаю</button></div></>}
      {!isRegion&&q.inputType==='text'&&<input id={id} aria-label={q.text} maxLength={200} value={typeof value==='string'?value:''} placeholder={q.placeholder} onChange={e=>set(q.field,e.target.value,e.target.value.trim().length>0)}/>} 
      {q.inputType==='select'&&<StyledSelect id={id} ariaLabel={q.text} value={answered&&value==null?'__unknown':typeof value==='string'?value:''} onChange={next=>set(q.field,next==='__unknown'?null:next)}
        options={[...(q.options??[]).map(o=>({value:String(o.value),label:o.label})),{value:'__unknown',label:'Не знаю'}]}/>} 
      {q.inputType==='boolean'&&<div className="choices">{[[true,'Да'],[false,'Нет'],[null,'Не знаю']].map(([v,label])=><button key={String(v)} type="button" aria-pressed={answered&&value===v} className={answered&&value===v?'selected':''} onClick={()=>set(q.field,v)}>{label}</button>)}</div>}
      {q.inputType==='multi_select'&&<><div className="option-list">{q.options?.map(o=><label key={o.value}><input type="checkbox" checked={Array.isArray(value)&&value.includes(o.value)} onChange={e=>set(q.field,e.target.checked?[...(Array.isArray(value)?value:[]),o.value]:(Array.isArray(value)?value:[]).filter(v=>v!==o.value))}/>{o.label}</label>)}</div>
        <div className="choices compact"><button type="button" className={Array.isArray(value)&&value.length===0?'selected':''} onClick={()=>set(q.field,[])}>Заказы пока не принимаем</button><button type="button" className={answered&&value===null?'selected':''} onClick={()=>set(q.field,null)}>Не знаю</button></div></>}
      {!isRegion&&q.inputType==='text'&&<div className="question-actions"><button type="button" className={'secondary-choice '+(answered&&value===null?'selected':'')} onClick={()=>set(q.field,null)}>Не знаю</button></div>}
    </fieldset>;
  };
  return <form onSubmit={e=>{e.preventDefault();onSubmit();}} className="profile-form">
    <div className="profile-purpose">Эти ответы нужны, чтобы подобрать требования именно для вашего бизнеса.</div>
    <div className="profile-grid">{profileQuestions.filter(q=>fields.includes(q.field as typeof fields[number])).map((q,index)=>renderQuestion(q,index))}</div>
    <details className="optional-profile"><summary>Дополнительные сведения · необязательно</summary><p className="field-help">Дополнительные сведения можно пропустить. Если они понадобятся для конкретного требования, сервис задаст уточняющий вопрос.</p><div className="profile-grid">{profileQuestions.filter(q=>!fields.includes(q.field as typeof fields[number])).map((q,index)=>renderQuestion(q,index,true))}</div></details>
    {profileWarnings(data.data).map(message=><p key={message} className="review-note" role="status">{message}</p>)}
    <div className="save-bar"><span>{complete<fields.length?`Осталось ${questionCountLabel(fields.length-complete)}`:confirmed&&!dirty?'Данные сохранены. Измените ответ, если что-то поменялось.':confirmed?'Есть несохранённые изменения':'Все 6 ответов заполнены'}</span><button className="primary" disabled={busy||complete<fields.length||(confirmed&&!dirty)} type="submit">{busy?'Сохраняем и обновляем…':confirmed&&!dirty?'Изменений нет':confirmed?'Сохранить и обновить требования':'Сохранить и показать требования'}</button></div>
  </form>;
}

function CheckCard({check,busy,onClarify,onAnswer}:{check:BusinessCheck;busy:boolean;onClarify:()=>void;onAnswer:(value:string,id:string)=>Promise<void>}) {
  const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const request=useRef<{answer:string;id:string}|null>(null);
  const missingState=check.kind==='document'?'Нужно доработать':check.kind==='setting'?'Нужно настроить':'Нужно выполнить';
  const label=({present:'Отмечено готовым',missing:missingState,unknown:'Нужно уточнить',unchecked:'Ещё не проверено',clarify:check.clarification==='upcoming'?'Понадобится позже':check.clarification==='review'?'Проверить вручную':'Сначала нужны ответы'} as Record<string,string>)[check.state]??'Ещё не проверено';
  const presentLabel=check.kind==='document'?'Проверил, всё готово':check.kind==='setting'?'Проверил, всё настроено':'Проверил, выполнено';
  const missingLabel=check.kind==='document'?'Нужно подготовить или исправить':check.kind==='setting'?'Нужно настроить':'Нужно выполнить';
  const kindLabel=check.kind==='document'?'Документ / сведения':check.kind==='setting'?'Настройка':'Действие';
  const clarifyAction=check.clarification==='unavailable'?'Открыть требование':check.clarification==='upcoming'?'Посмотреть, когда понадобится':check.clarification==='review'?'Посмотреть, что проверить':'Ответить на вопросы';
  const tone=check.state==='present'?'success':check.state==='missing'?'warning':check.state==='clarify'?'info':'muted';
  async function save(answer:string) {
    if(saving)return;setSaving(true);setError('');
    try {
      if(request.current?.answer!==answer)request.current={answer,id:newRequestId()};
      await onAnswer(answer,request.current.id);request.current=null;
    }catch(e){setError(errorMessage(e));}finally{setSaving(false);}
  }
  return <section className="check-card">
    <button type="button" className="check-heading" onClick={()=>setOpen(!open)} aria-expanded={open}><span><span className="check-meta"><span className={'status '+tone}>{label}</span><span className="check-kind">{kindLabel}</span></span><h3>{plainText(check.title,'Пункт проверки')}</h3></span><span aria-hidden="true">{open?'−':'+'}</span></button>
    {open&&<div className="check-body"><p>{plainText(check.help,'Посмотрите источник и отметьте свою готовность.')}</p>
      {check.kind==='action'&&<p className="field-help">Эта отметка общая с карточкой требования и ботом. Если пока не знаете, выполнено ли действие, откройте полное требование и уточните шаги.</p>}
      {check.needsRecheck&&<p className="review-note">После вашей прошлой отметки изменились данные бизнеса или условия проверки. Проверьте этот пункт ещё раз.</p>}
      {check.canAnswer?<div className="choices">{(check.kind==='action'?[['present',presentLabel],['missing',missingLabel]]:[['present',presentLabel],['missing',missingLabel],['unknown','Не знаю']]).map(([value,text])=><button key={value} disabled={busy||saving} aria-pressed={check.state===value} className={check.state===value?'selected':''} onClick={()=>void save(value!)}>{text}</button>)}</div>
        :<button disabled={busy||saving} onClick={onClarify}>{clarifyAction}</button>}
      {saving&&<p role="status">Сохраняем отметку…</p>}{error&&<p role="alert" className="error-note">{error}</p>}
      <details className="conditions"><summary>Почему этот пункт здесь</summary><p className="field-help">Пункт появился из одного из требований для вашего бизнеса. В полной карточке видно, почему требование относится к вам, что нужно сделать и где находится источник.</p><div className="source-links">{sources(check.sources)}</div><button className="text-button" onClick={onClarify}>Открыть полное требование</button></details>
    </div>}
  </section>;
}
