import React, { useEffect, useRef, useState } from 'react';
import type { Candidate, Field, HistoryItem, Preview, Review, ReviewDocument } from './types.js';
import { TextField, ValueInput } from './Fields.js';
import { documentChanges, newPhase } from './model.js';
import PhaseEditor from './PhaseEditor.js';
import './review.css';

type Session = { actor: string; csrf: string; expiresAt: number };
class ApiError extends Error { constructor(public status: number, public code: string, public details?: Array<{path?: string | Array<string|number>;message?: string}>) { super(code); } }
const errorLabels: Record<string,string> = { INVALID_ADMIN_TOKEN:'Неверный административный ключ.', REVIEW_LOGIN_RATE_LIMIT:'Слишком много попыток входа. Повторите через минуту.',
  REVIEW_ORIGIN_REQUIRED:'Адрес редактора не разрешён сервером. Проверьте REVIEW_UI_ORIGIN.', REVIEW_CSRF_REQUIRED:'Сессия не прошла проверку. Выйдите и войдите снова.',
  REVIEW_REVISION_CONFLICT:'На сервере уже есть другая ревизия. Ваши правки сохранены на экране; сравните их с новой версией перед повторным сохранением.',
  REVIEW_ALREADY_EXISTS:'Черновик уже создан. Обновите карточку.', CANDIDATE_ALREADY_REVIEWED:'Кандидат уже рассмотрен. Обновите карточку.',
  REVIEW_NOT_READY:'Есть незавершённые проверки. Исправьте замечания и сохраните черновик.', REVIEW_IDENTITY_CHANGED:'Нельзя удалять исходные элементы. Используйте «Исключить» с обоснованием.',
  INVALID_REVIEW_INPUT:'Проверьте заполнение полей: текст, даты и значения должны иметь правильный формат.' };
const decisionLabels: Record<string,string> = { unresolved:'Нужно проверить', include:'Включён', exclude:'Исключён' };
const date = (v:string) => new Date(v).toLocaleString('ru-RU');

export default function ReviewApp() {
  const [session,setSession]=useState<Session|null>(null), [initializing,setInitializing]=useState(true), [key,setKey]=useState('');
  const [error,setError]=useState(''), [detailErrors,setDetailErrors]=useState<string[]>([]), [notice,setNotice]=useState(''), [busy,setBusy]=useState(false);
  const [candidates,setCandidates]=useState<Candidate[]>([]), [fields,setFields]=useState<Field[]>([]), [filter,setFilter]=useState('pending'), [search,setSearch]=useState('');
  const [candidate,setCandidate]=useState<Candidate|null>(null), [head,setHead]=useState<Review|null>(null), [review,setReview]=useState<Review|null>(null);
  const [document,setDocument]=useState<ReviewDocument|null>(null), [history,setHistory]=useState<HistoryItem[]>([]), [phaseId,setPhaseId]=useState('');
  const [activeSegment,setActiveSegment]=useState<number|null>(null), [reason,setReason]=useState(''), [pendingNavigation,setPendingNavigation]=useState<(()=>Promise<void>)|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null), [asOf,setAsOf]=useState(new Date().toISOString().slice(0,10)), [testProfile,setTestProfile]=useState<Record<string,unknown>>({profileVersion:1}), [outlet,setOutlet]=useState('');
  const [serverConflict,setServerConflict]=useState<Review|null>(null);
  const lock=useRef(false);
  const dirty=!!document && !!review && JSON.stringify(document)!==JSON.stringify(review.document);
  const historical=!!review && !!head && review.revision!==head.revision;
  const readOnly=historical || candidate?.review_state!=='pending';
  const phase=document?.phases.find(p=>p.id===phaseId) ?? document?.phases[0];
  const segments=candidate?.source_snapshot?.segments ?? [];
  const previewFields=[...new Set(review?.compilation.rules.flatMap(r=>r.rule.applicability.requiredFields) ?? [])];
  const changes=document && review ? documentChanges(historical ? document : review.document, historical ? head!.document : document) : [];

  async function request<T>(path:string, init:RequestInit={}):Promise<T> {
    const response=await fetch(path,{...init,credentials:'same-origin',headers:{'Content-Type':'application/json',...(session?{'X-Review-CSRF':session.csrf}:{}),...init.headers}});
    const body=await response.json().catch(()=>({error:'SERVER_RESPONSE_INVALID'}));
    if(!response.ok) {
      if((response.status===401 || body.error==='REVIEW_LOGIN_REQUIRED') && path!=='/admin/session') { setSession(null); setKey(''); }
      throw new ApiError(response.status,body.error ?? `HTTP_${response.status}`,Array.isArray(body.details)?body.details:body.issues);
    }
    return body as T;
  }
  async function run(action:()=>Promise<void>) {
    if(lock.current)return;
    lock.current=true; setBusy(true); setError(''); setDetailErrors([]); setNotice('');
    try { await action(); } catch(e) {
      if(e instanceof ApiError){setError(errorLabels[e.code] ?? (e.code==='REVIEW_LOGIN_REQUIRED'?'Сессия истекла. Войдите снова; правки остаются на экране.':e.code));setDetailErrors(e.details?.map(i=>`${Array.isArray(i.path)?i.path.join('.'):i.path ?? ''}: ${i.message ?? ''}`) ?? []);}
      else setError(e instanceof Error?e.message:'Не удалось выполнить запрос. Повторите попытку.');
    } finally {lock.current=false;setBusy(false);}
  }
  useEffect(()=>{let active=true; fetch('/admin/session',{credentials:'same-origin'}).then(async r=>{if(r.ok){const s=await r.json();if(active)setSession(s);}}).catch(()=>{if(active)setError('Сервер недоступен. Проверьте запуск API.');}).finally(()=>{if(active)setInitializing(false);});return()=>{active=false;};},[]);
  useEffect(()=>{if(!session)return;void run(async()=>{
    const [list,catalog]=await Promise.all([request<{items:Candidate[]}>(`/admin/candidates?state=${filter}`),request<{items:Field[]}>('/admin/review-fields')]);setCandidates(list.items);setFields(catalog.items);
  });},[session,filter]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  function installReview(next:Review|null) {setReview(next);setDocument(next?structuredClone(next.document):null);setPhaseId(previous=>next?.document.phases.some(p=>p.id===previous)?previous:next?.document.phases[0]?.id ?? '');setPreview(null);setReason('');setServerConflict(null);}
  async function loadCandidate(id:string) {
    const next=await request<Candidate>(`/admin/candidates/${id}`);
    let stored:Review|null=null, revisions:HistoryItem[]=[];
    try {stored=await request<Review>(`/admin/candidates/${id}/review`);revisions=(await request<{items:HistoryItem[]}>(`/admin/candidates/${id}/review/history`)).items;}
    catch(e){if(!(e instanceof ApiError && e.status===404))throw e;}
    setCandidate(next);setHead(stored);setHistory(revisions);installReview(stored);setActiveSegment(null);setTestProfile({profileVersion:1});
  }
  function navigate(action:()=>Promise<void>) {if(dirty){setPendingNavigation(()=>action);return;}void run(action);}
  async function create() {const next=await request<Review>(`/admin/candidates/${candidate!.id}/review`,{method:'POST',body:'{}'});setHead(next);installReview(next);setHistory((await request<{items:HistoryItem[]}>(`/admin/candidates/${candidate!.id}/review/history`)).items);setNotice('Создана отдельная ревизия проверки. Исходное извлечение сохранено.');}
  async function save(state:'draft'|'ready') {
    const next=await request<Review>(`/admin/candidates/${candidate!.id}/review`,{method:'PUT',body:JSON.stringify({baseRevision:head!.revision,state,reason,document})});
    setHead(next);installReview(next);setHistory((await request<{items:HistoryItem[]}>(`/admin/candidates/${candidate!.id}/review/history`)).items);
    setNotice(state==='ready'?`Ревизия ${next.revision} готова к следующему этапу. Публикации не было.`:`Ревизия ${next.revision} сохранена. Замечаний: ${next.compilation.issues.length}.`);
  }
  const cite=(index:number)=>{setActiveSegment(index);window.document.getElementById(`source-${index}`)?.scrollIntoView({behavior:'smooth',block:'center'});};
  const changeDocument=(next:ReviewDocument)=>{setDocument(next);setPreview(null);};
  const showIssues=(issues:Review['compilation']['issues'])=><ul className="rv-issues">{issues.map((issue,i)=><li key={`${issue.path}-${i}`}><button type="button" onClick={()=>{const match=issue.path.match(/^phases\.(\d+)/);if(match&&document?.phases[Number(match[1])])setPhaseId(document.phases[Number(match[1])]!.id);window.document.getElementById('review-phase')?.scrollIntoView({block:'start'});}}><b>{issue.message}</b><small>{issue.path}</small></button></li>)}</ul>;

  if(initializing)return <div className="rv-loading">Загрузка редактора…</div>;
  if(!session)return <main className="rv-root rv-login"><section><span className="rv-brand">RC / ПРОВЕРКА ИСТОЧНИКОВ</span><h1>Вход для проверяющего</h1><p>Проверяйте извлечение по источнику, уточняйте условия и сохраняйте историю решений.</p>
    <form onSubmit={e=>{e.preventDefault();void run(async()=>{try {setSession(await request<Session>('/admin/session',{method:'POST',body:JSON.stringify({adminToken:key})}));} finally {setKey('');}});}}>
      <label className="rv-field"><span>Административный ключ</span><input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} required /></label>
      {error&&<div role="alert" className="rv-alert">{error}</div>}<button className="rv-primary" disabled={busy||!key.trim()}>Войти в редактор</button>
    </form><p className="rv-help">Ключ не сохраняется в браузерном хранилище. Сессия действует 45 минут. Доступ общий: действия записываются от имени admin-token.</p>{dirty&&<p>Несохранённые правки остаются на экране и будут доступны после входа.</p>}<a href="/">К кабинету компании</a></section></main>;

  return <div className="rv-root"><header className="rv-top"><a className="rv-brand" href="/">RC <span>Регуляторный контроль</span></a><span className="rv-workspace">Проверка источников</span><div><span className="rv-help">Общий администратор</span><button disabled={busy} onClick={()=>navigate(async()=>{await request('/admin/session',{method:'DELETE'});setSession(null);setCandidate(null);setHead(null);installReview(null);})}>Выйти</button></div></header>
    {error&&<div className="rv-global-alert" role="alert"><b>{error}</b>{detailErrors.length>0&&<ul>{detailErrors.map((text,i)=><li key={i}>{text}</li>)}</ul>}
      {error.includes('другая ревизия')&&candidate&&<button disabled={busy} onClick={()=>void run(async()=>{setServerConflict(await request<Review>(`/admin/candidates/${candidate.id}/review`));})}>Сравнить с сервером</button>}</div>}
    {notice&&<div className="rv-notice" role="status">{notice}</div>}
    {pendingNavigation&&<div className="rv-modal" role="dialog" aria-modal="true" aria-label="Несохранённые изменения"><section><h2>Есть несохранённые правки</h2><p>Сохраните ревизию или отмените правки перед переходом.</p><button onClick={()=>setPendingNavigation(null)}>Продолжить редактирование</button><button onClick={()=>{const action=pendingNavigation;setPendingNavigation(null);void run(action);}}>Отменить правки и перейти</button></section></div>}
    {serverConflict&&<div className="rv-conflict"><h2>Сервер: ревизия {serverConflict.revision}; ваша основа: {head?.revision}</h2><p>Автоматического объединения нет. Ваши поля не изменены.</p><Changes items={documentChanges(serverConflict.document,document)} /><button onClick={()=>setServerConflict(null)}>Вернуться к своим правкам</button><button onClick={()=>navigate(()=>loadCandidate(candidate!.id))}>Загрузить серверную ревизию</button></div>}
    <div className="rv-layout"><aside className="rv-queue"><div className="rv-queue-head"><h1>На проверке</h1><button aria-label="Обновить список" disabled={busy} onClick={()=>void run(async()=>setCandidates((await request<{items:Candidate[]}>(`/admin/candidates?state=${filter}`)).items))}>↻</button></div>
      <label className="rv-field"><span>Статус кандидатов</span><select value={filter} disabled={busy} onChange={e=>setFilter(e.target.value)}><option value="pending">Ожидают проверки</option><option value="approved">Утверждены</option><option value="rejected">Отклонены</option></select></label>
      <label className="rv-field"><span>Поиск по названию</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Документ или тема" /></label>
      <div className="rv-candidate-list">{candidates.filter(c=>c.source_title.toLowerCase().includes(search.toLowerCase())).map(c=><button key={c.id} className={candidate?.id===c.id?'selected':''} disabled={busy} onClick={()=>navigate(()=>loadCandidate(c.id))}>
        <span>{c.provider}</span><strong>{c.source_title}</strong><small>{date(c.created_at)}</small></button>)}{!candidates.length&&<p className="rv-help">Кандидатов с этим статусом пока нет.</p>}</div>
    </aside>
    {!candidate?<section className="rv-welcome"><span className="rv-eyebrow">ПРОВЕРКА ЧЕЛОВЕКОМ</span><h2>От источника к проверенному правилу</h2><p>Выберите документ слева. Сопоставьте условия, исключения и сроки с цитатами, затем проверьте результат на примере компании.</p><ol><li>Прочитайте неизменяемый снимок источника.</li><li>Зафиксируйте решения и основания правок.</li><li>Сохраните ревизию и выполните предпросмотр.</li></ol><p className="rv-help">Готовая ревизия сама по себе не публикует нормы и не отправляет уведомления.</p></section>:<>
    <aside className="rv-source"><div className="rv-source-head"><span className="rv-eyebrow">ИСХОДНЫЙ ДОКУМЕНТ</span><h2>{candidate.source_title}</h2>
      {candidate.source_snapshot?.officialUrl.startsWith('https://')&&<a href={candidate.source_snapshot.officialUrl} target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>}
      {candidate.source_snapshot&&<details><summary>Снимок и происхождение</summary><p>Сохранён {date(candidate.source_snapshot.capturedAt)}</p><p>{candidate.source_snapshot.origin}</p><p className="rv-mono">SHA-256: {candidate.source_snapshot.textHash}</p><p>Снимок текста после разбора страницы. Не изменяется при редактировании.</p></details>}
    </div><div className="rv-source-scroll">{!segments.length&&<p>У этого кандидата нет сохранённого снимка. Нужно повторное извлечение.</p>}{segments.map(segment=><article key={segment.sourceSegmentIndex} id={`source-${segment.sourceSegmentIndex}`} className={activeSegment===segment.sourceSegmentIndex?'highlight':''}>
      <span className="rv-segment-number">§ {segment.sourceSegmentIndex+1}</span><p>{segment.text}</p></article>)}</div></aside>
    <main className="rv-editor">{!review?<section className="rv-section"><h2>Начать проверку</h2><p>Будет создана отдельная ревизия. Исходное извлечение останется неизменным.</p><button className="rv-primary" disabled={busy||!candidate.source_snapshot||candidate.review_state!=='pending'} onClick={()=>void run(create)}>Создать черновик проверки</button></section>:document&&<>
      <div className="rv-review-head"><span className="rv-eyebrow">{historical?'ИСТОРИЧЕСКАЯ РЕВИЗИЯ':'РАБОЧАЯ РЕВИЗИЯ'} · {review.revision}</span><h1>{document.title}</h1><div className="rv-badges"><span>{review.state==='ready'?'Готова к следующему этапу':'Черновик'}</span>{dirty&&<span className="rv-unsaved">Есть несохранённые правки</span>}{readOnly&&<span>Только чтение</span>}</div><p className="rv-help">{date(review.createdAt)} · {review.actorId}. {review.reason}</p></div>
      <section className="rv-section"><details><summary>История ревизий ({history.length})</summary><div className="rv-history">{history.map(item=><button key={item.revision} disabled={busy||item.revision===review.revision} onClick={()=>navigate(async()=>installReview(await request<Review>(`/admin/candidates/${candidate.id}/review?revision=${item.revision}`)))}>
        <b>Ревизия {item.revision} · {item.state==='ready'?'готова':'черновик'}</b><span>{date(item.created_at)} · {item.actor_id}</span><small>{item.reason}</small></button>)}</div></details>
        {historical&&<button disabled={busy} onClick={()=>navigate(()=>loadCandidate(candidate.id))}>Вернуться к текущей ревизии</button>}
        {changes.length>0&&<details><summary>{historical?'Отличия от текущей ревизии':'Ваши изменения'} ({changes.length})</summary><Changes items={changes}/></details>}
        <details><summary>Исходное извлечение модели</summary><pre className="rv-raw">{JSON.stringify(candidate.draft,null,2)}</pre></details>
      </section>
      <section className={`rv-section ${review.compilation.ready?'rv-valid':'rv-needs-work'}`}><h2>{review.compilation.ready?'Структура прошла проверки':`Замечания к сохранённой ревизии: ${review.compilation.issues.length}`}</h2>
        <p className="rv-help">{dirty?'Правки ещё не проверены. Сохраните черновик для обновления замечаний.':'Точность цитат не подтверждает правильность смысла. Проверку источника завершает человек.'}</p>
        {review.compilation.issues.length>0&&<details open={review.compilation.issues.length<=5}><summary>Показать замечания</summary>{showIssues(review.compilation.issues)}</details>}</section>
      <fieldset disabled={readOnly||busy} className="rv-editable"><section className="rv-section"><h2>Проверка документа</h2><TextField label="Название документа проверки" value={document.title} onChange={title=>changeDocument({...document,title})}/>
        <label className="rv-check"><input type="checkbox" checked={document.sourceReview.confirmed} onChange={e=>changeDocument({...document,sourceReview:{...document.sourceReview,confirmed:e.target.checked}})}/>Проверены полнота источника и правовое основание</label>
        <TextField label="Результат проверки источника" value={document.sourceReview.note} onChange={note=>changeDocument({...document,sourceReview:{...document.sourceReview,note:note||null}})} area />
        {document.resolutions.map((item,i)=><div className="rv-resolution" key={item.key}><p>{candidate.review_requirements?.find(r=>r.key===item.key)?.message ?? item.key}</p><label className="rv-check"><input type="checkbox" checked={item.resolved} onChange={e=>changeDocument({...document,resolutions:document.resolutions.map((r,j)=>i===j?{...r,resolved:e.target.checked}:r)})}/>Вопрос разобран</label>
          <TextField label="Решение по замечанию" value={item.note} onChange={note=>changeDocument({...document,resolutions:document.resolutions.map((r,j)=>i===j?{...r,note:note||null}:r)})}/></div>)}</section>
      </fieldset>
      <nav className="rv-phases" aria-label="Этапы документа">{document.phases.map((p,i)=><button key={p.id} className={phase?.id===p.id?'selected':''} onClick={()=>setPhaseId(p.id)}><b>Этап {i+1}</b><span>{p.validFrom.date ?? 'Дата не определена'}</span><small>{decisionLabels[p.decision]}</small></button>)}</nav>
      <fieldset disabled={readOnly||busy} className="rv-editable"><div className="rv-phase-tools"><button type="button" disabled={document.phases.length>=50} onClick={()=>{const p=newPhase();changeDocument({...document,phases:[...document.phases,p]});setPhaseId(p.id);}}>+ Добавить этап</button>
        {phase&&<button type="button" disabled={document.phases[0]?.id===phase.id} onClick={()=>{const list=[...document.phases],i=list.findIndex(p=>p.id===phase.id);[list[i-1],list[i]]=[list[i]!,list[i-1]!];changeDocument({...document,phases:list});}}>Переместить этап выше</button>}</div>
        {phase&&<PhaseEditor key={phase.id} phase={phase} onChange={p=>changeDocument({...document,phases:document.phases.map(v=>v.id===p.id?p:v)})} fields={fields} segments={segments} onCite={cite}/>} </fieldset>
      <section className="rv-section rv-preview"><h2>Предпросмотр для компании</h2><p className="rv-help">Гипотетический расчёт сохранённой ревизии. Профиль компании, действия и уведомления не изменяются.</p>
        {!review.compilation.ready&&<p>Сначала устраните замечания к структуре и сохраните ревизию.</p>}
        <fieldset disabled={!review.compilation.ready||dirty||historical||busy} className="rv-editable"><TextField label="Дата расчёта" value={asOf} type="date" onChange={v=>{setAsOf(v);setPreview(null);}}/>
          {review.compilation.rules.some(r=>r.scope==='trade_object')&&<TextField label="Обозначение тестовой торговой точки" value={outlet} onChange={v=>{setOutlet(v);setPreview(null);}}/>}
          <div className="rv-form-grid">{previewFields.map(name=>{const field=fields.find(f=>f.name===name);return <ValueInput key={name} field={field} label={field?.label ?? name} value={testProfile[name] as never ?? null} multiple={field?.type==='array'} onChange={value=>{setTestProfile({...testProfile,[name]:value});setPreview(null);}}/>;})}</div>
          <button onClick={()=>void run(async()=>setPreview(await request<Preview>(`/admin/candidates/${candidate.id}/review/preview`,{method:'POST',body:JSON.stringify({revision:review.revision,contentHash:review.contentHash,asOf,profile:testProfile,...(outlet?{tradeObjectId:outlet}:{})})})))}>Выполнить предпросмотр</button>
        </fieldset>
        {preview&&<div className="rv-preview-results" role="status"><p>Ревизия {preview.revision} · на {preview.asOf}</p>{preview.items.map(item=><article key={item.phaseId}><h3>{document.phases.find(p=>p.id===item.phaseId)?.userTitle ?? item.ruleId}</h3><span>{{active:'Действует',upcoming:'Предстоящий этап',ended:'Действие завершено'}[item.timeState]}</span>
          <b>{item.contextRequired?'Укажите тестовую торговую точку':item.evaluation?({applies:'Относится к профилю',not_applicable:'Не относится',needs_info:'Нужно уточнить'}[item.evaluation.verdict]):'На эту дату расчёт не выполняется'}</b>
          {!!item.evaluation?.missingFields.length&&<p>Не хватает: {item.evaluation.missingFields.map(f=>fields.find(x=>x.name===f)?.label??f).join(', ')}</p>}
          {item.evaluation?.actions.map(action=><p key={action.actionKey}>{action.title} · {action.deadline??'Без установленного срока'}</p>)}<details><summary>Объяснение расчёта</summary>{item.evaluation?.reasons.map((reason,i)=><p key={i}>{reason}</p>)}</details></article>)}</div>}
      </section>
      {!readOnly&&<section className="rv-save"><TextField label="Причина сохранения новой ревизии" value={reason} onChange={setReason}/><div><button className="rv-primary" disabled={busy||!reason.trim()} onClick={()=>void run(()=>save('draft'))}>Сохранить и проверить</button>
        <button disabled={busy||dirty||!review.compilation.ready||!reason.trim()||review.state==='ready'} onClick={()=>void run(()=>save('ready'))}>Отметить готовой</button></div><small>Сохранение и статус «готова» не публикуют нормы.</small></section>}
    </>}</main></>}
    </div>{busy&&<div className="rv-busy" role="status">Выполняется запрос…</div>}
  </div>;
}
function Changes({items}:{items:ReturnType<typeof documentChanges>}) {return <ul className="rv-changes">{items.slice(0,80).map((item,i)=><li key={i}><b>{item.path}</b><del>{JSON.stringify(item.before)?.slice(0,350)??'Не было'}</del><ins>{JSON.stringify(item.after)?.slice(0,350)??'Удалено'}</ins></li>)}{items.length>80&&<li>Показаны первые 80 изменений из {items.length}.</li>}</ul>;}
