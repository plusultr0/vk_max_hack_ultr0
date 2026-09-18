import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
const ReviewApp = React.lazy(() => import('./review/ReviewApp.js'));

declare global {
  interface Window {
    WebApp?: {
      initData?: string;
      platform?: string;
      version?: string;
      getViewportSize?: () => Promise<{ width: string; height: string }>;
      enableClosingConfirmation?: () => void;
      disableClosingConfirmation?: () => void;
      openLink?: (url: string) => void;
    };
  }
}

type ProfileState = {
  confirmed: any | null;
  draft: { data: Record<string, any>; answeredFields: string[]; baseProfileVersion: number };
  progress: { answered: number; total: number; percent: number; canConfirm: boolean; missing: string[] };
};

type ImpactQuestion = {
  field: string;
  text: string;
  inputType: 'boolean'|'select'|'multi_select'|'number'|'date'|'text'|'string_list';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
};

type Impact = {
  id: string;
  isCurrent: boolean;
  timeState: 'active'|'upcoming'|'ended'|'cancelled';
  profileVersion: number;
  ruleId: string;
  ruleVersion: number;
  verdict: 'applies'|'not_applicable'|'needs_info';
  reviewState: 'auto'|'reviewed'|'needs_review';
  complianceState: 'unknown'|'compliant'|'action_required'|'not_assessed';
  effectiveFrom: string | null;
  reviewReasons: string[];
  reasons: string[];
  questions: ImpactQuestion[];
  rule: { userTitle: string; summary: string; category: string; legalStatus: string; checkedAt: string; evidenceRefs: Array<{ id:string; url:string; label:string }> };
  actions: Array<{ id:string; title:string; description:string; deadline:string|null; executionStatus:string; reviewRequired:boolean }>;
};

type ImpactList = { profileVersion: number | null; impacts: Impact[] };

type AuthResponse = { token: string; companyId: string; startParam?: string | null; dev?: boolean };

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const onboardingFields = [
  { key: 'legalForm', label: 'Форма бизнеса', type: 'select', options: [['IP','ИП'],['LLC','ООО'],['other','Другое']] },
  { key: 'region', label: 'Регион', type: 'text' },
  { key: 'taxRegime', label: 'Налоговый режим', type: 'select', options: [['USN','УСН'],['OSNO','ОСНО'],['other','Другой']] },
  { key: 'sellsToConsumers', label: 'Продаёте физлицам-потребителям?', type: 'bool' },
  { key: 'salesChannels', label: 'Каналы продаж', type: 'multiselect', options: [['own_site','Свой сайт'],['marketplace','Маркетплейс'],['social','Соцсети'],['messenger','Мессенджеры'],['offline','Офлайн'],['other','Другое']] },
  { key: 'distanceSales', label: 'Есть дистанционные продажи?', type: 'bool' },
  { key: 'onlinePayment', label: 'Принимаете онлайн-оплату?', type: 'bool' },
  { key: 'collectsPersonalData', label: 'Собираете персональные данные клиентов?', type: 'bool' },
] as const;

function statusLabel(impact: Impact) {
  if (!impact.isCurrent) return ['Историческая карточка','muted'];
  if (impact.timeState === 'upcoming') return ['Предстоящее изменение','info'];
  if (impact.timeState === 'ended' || impact.timeState === 'cancelled') return ['Действие завершено','muted'];
  if (impact.reviewState === 'needs_review') return ['Требует проверки','warning'];
  if (impact.verdict === 'needs_info' || impact.questions.length > 0) return ['Нужно уточнить','info'];
  if (impact.verdict === 'not_applicable') return ['Не относится','muted'];
  if (impact.actions.length && impact.actions.every(a=>a.executionStatus==='completed')) return ['Действия отмечены выполненными','success'];
  if (impact.complianceState === 'action_required') return ['Нужно действие','danger'];
  if (impact.complianceState === 'compliant') return ['Соответствует','success'];
  return ['Относится','accent'];
}

function App() {
  const [linkedImpact,setLinkedImpact]=useState<Impact|null>(null);
  const [impactHistory,setImpactHistory]=useState<Impact[]>([]);
  const [token, setToken] = useState<string | null>(sessionStorage.getItem('reg.session'));
  const [authMeta, setAuthMeta] = useState<{ startParam?: string|null; dev?: boolean; platform?: string } | null>(null);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [impacts, setImpacts] = useState<ImpactList | null>(null);
  const [view, setView] = useState<'dashboard'|'profile'|'history'>('dashboard');
  const [filter, setFilter] = useState<'attention'|'all'|'applies'|'needs_info'|'not_applicable'>('attention');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(body?.message ?? body?.error ?? `API ${response.status}`);
    return body as T;
  }

  async function authenticate() {
    const initData = window.WebApp?.initData?.trim();
    const result = initData
      ? await fetch(`${API_URL}/auth/max`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ initData }) }).then(async r => { const b=await r.json(); if(!r.ok) throw new Error(b.message ?? b.error); return b as AuthResponse; })
      : await fetch(`${API_URL}/auth/dev`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ userId:'dev-browser' }) }).then(async r => { const b=await r.json(); if(!r.ok) throw new Error(b.message ?? b.error); return b as AuthResponse; });
    sessionStorage.setItem('reg.session', result.token);
    setToken(result.token);
    setAuthMeta({ startParam: result.startParam, dev: result.dev, platform: window.WebApp?.platform ?? 'browser' });
    return result;
  }

  async function loadAll(activeToken = token) {
    if (!activeToken) return;
    setLoading(true); setError(null);
    try {
      const headers = { Authorization: `Bearer ${activeToken}` };
      const [p, i] = await Promise.all([
        fetch(`${API_URL}/company/profile`, { headers }).then(async r => {if(!r.ok)throw new Error('Ошибка загрузки профиля');return r.json();}) as Promise<ProfileState>,
        fetch(`${API_URL}/impacts`, { headers }).then(async r => {if(!r.ok)throw new Error('Ошибка загрузки карточек');return r.json();}) as Promise<ImpactList>,
      ]);
      setProfile(p); setImpacts(i);
      if (p.confirmed) setView('dashboard'); else setView('profile');
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка загрузки'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    void (async () => {
      try {
        let active = token;
        // A new MAX launch can contain a different signed deep link or user,
        // even when this webview still holds a valid session from a prior launch.
        if (!active || window.WebApp?.initData?.trim()) active = (await authenticate()).token;
        else {
          const me = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${active}` } }).then(async (r) => {
            if(r.status===401){sessionStorage.removeItem('reg.session');const renewed=await authenticate();active=renewed.token;return renewed;}
            const b = await r.json(); if (!r.ok) throw new Error(b.message ?? b.error); return b as any;
          });
          setAuthMeta({ startParam: me.startParam ?? null, dev: me.dev, platform: window.WebApp?.platform ?? 'browser' });
        }
        await loadAll(active);
      } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка авторизации'); setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    const start = authMeta?.startParam;
    if(start?.startsWith('assessment_')){setView('dashboard');void api<Impact>(`/impacts/${encodeURIComponent(start.slice(11))}`).then(setLinkedImpact).catch(()=>setError('Карточка недоступна для вашей компании.'));return;}
    if (!start?.startsWith('impact_') || !impacts) return;
    const ruleId = start.slice('impact_'.length);
    setView('dashboard');
    setTimeout(() => document.getElementById(`impact-${ruleId}`)?.scrollIntoView({ behavior:'smooth', block:'start' }), 150);
  }, [authMeta?.startParam, impacts]);

  async function saveField(key: string, value: unknown) {
    if (!profile) return;
    window.WebApp?.enableClosingConfirmation?.();
    const next = await api<ProfileState>('/company/profile', { method:'PUT', body:JSON.stringify({ patch:{ [key]:value }, answeredFields:[key] }) });
    setProfile(next);
  }

  async function confirmProfile() {
    setLoading(true);
    try {
      await api('/company/profile/confirm', { method:'POST', body:'{}' });
      window.WebApp?.disableClosingConfirmation?.();
      await loadAll();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подтвердить профиль'); setLoading(false); }
  }

  async function answerQuestion(impact: Impact, field: string, value: unknown) {
    setError(null);
    try {
      await api(`/impacts/${impact.id}/answer`, { method:'POST', body:JSON.stringify({ field, value }) });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить уточнение');
      throw e;
    }
  }

  async function setAction(id: string, status: string) {
    setError(null);
    try {
      await api(`/actions/${id}`, { method:'PATCH', body:JSON.stringify({ status }) });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось обновить действие');
    }
  }

  async function openHistory() {
    setView('history');
    try {
      const [a,h,i] = await Promise.all([api<{items:any[]}>('/audit'), api<{items:any[]}>('/company/profile/history'),api<ImpactList>('/impacts/history')]);
      setAudit(a.items); setHistory(h.items);setImpactHistory(i.impacts);
    } catch(e) {setError(e instanceof Error ? e.message : 'Не удалось загрузить историю');}
  }

  const visibleImpacts = useMemo(() => {
    const list = impacts?.impacts ?? [];
    if (filter === 'all') return list;
    if (filter === 'applies') return list.filter(x => x.verdict === 'applies');
    if (filter === 'needs_info') return list.filter(x => x.verdict === 'needs_info');
    if (filter === 'not_applicable') return list.filter(x => x.verdict === 'not_applicable');
    return list.filter(x => x.reviewState === 'needs_review' || x.verdict === 'needs_info' || x.complianceState === 'action_required' || x.actions.some(a => a.executionStatus !== 'completed' && !a.reviewRequired));
  }, [impacts, filter]);

  if (loading) return <main className="app-shell"><div className="loading-card">Загрузка регуляторного профиля…</div></main>;
  if (error && !profile) return <main className="app-shell"><div className="error-card"><b>Ошибка</b><p>{error}</p><button onClick={() => location.reload()}>Повторить</button></div></main>;

  return <main className="app-shell">
    <header className="topbar">
      <div><span className="brand-mark">RC</span><strong>Регуляторный контроль</strong></div>
      <span className="platform">{authMeta?.platform ?? window.WebApp?.platform ?? 'web'}</span>
    </header>

    <div className="layout">
      <aside className="sidebar">
        <button className={view==='dashboard'?'active':''} onClick={() => setView('dashboard')}>Изменения</button>
        <button className={view==='profile'?'active':''} onClick={() => setView('profile')}>Профиль</button>
        <button className={view==='history'?'active':''} onClick={() => void openHistory()}>История</button>
      </aside>

      <section className="content">
        {error && <div className="inline-error">{error}<button onClick={() => setError(null)}>×</button></div>}

        {view === 'profile' && profile && <>
          <div className="section-head"><div><span className="eyebrow">ПРОФИЛЬ КОМПАНИИ</span><h1>{profile.confirmed ? 'Уточните признаки бизнеса' : 'Настройте регуляторный профиль'}</h1></div><div className="progress"><b>{profile.progress.percent}%</b><span>{profile.progress.answered}/{profile.progress.total}</span></div></div>
          <div className="profile-grid">
            {onboardingFields.map((field:any) => <ProfileField key={field.key} field={field} value={profile.draft.data[field.key]} answered={profile.draft.answeredFields.includes(field.key)} onChange={(value) => void saveField(field.key,value)} />)}
          </div>
          <div className="sticky-cta"><div><b>{profile.progress.canConfirm ? 'Можно запускать проверку' : `Осталось ответить: ${profile.progress.missing.length}`}</b><span>Неизвестный ответ можно сохранить как «не знаю» — это не считается «нет».</span></div><button disabled={!profile.progress.canConfirm} onClick={() => void confirmProfile()}>{profile.confirmed ? 'Сохранить новую версию' : 'Проверить изменения'}</button></div>
        </>}

        {view === 'dashboard' && <>
          <div className="section-head"><div><span className="eyebrow">АКТУАЛЬНО ДЛЯ ВАС</span><h1>Изменения и действия</h1></div><button className="ghost" onClick={() => setView('profile')}>Изменить профиль</button></div>
          {linkedImpact&&<section><h2>Карточка из уведомления</h2><ImpactCard impact={linkedImpact} onAnswer={answerQuestion} onAction={setAction}/><button onClick={()=>setLinkedImpact(null)}>Закрыть карточку</button></section>}
          {!profile?.confirmed && <div className="empty-card"><h2>Сначала заполните профиль</h2><p>Без него система не может определить применимость требований.</p><button onClick={() => setView('profile')}>Перейти к профилю</button></div>}
          {profile?.confirmed && <>
            <div className="filters">{(['attention','all','applies','needs_info','not_applicable'] as const).map(f => <button className={filter===f?'active':''} key={f} onClick={() => setFilter(f)}>{{attention:'Требуют внимания',all:'Все',applies:'Относятся',needs_info:'Нужно уточнить',not_applicable:'Не относятся'}[f]}</button>)}</div>
            <div className="impact-list">
              {visibleImpacts.length === 0 && <div className="empty-card"><h2>Здесь пока пусто</h2><p>Для выбранного фильтра нет карточек.</p></div>}
              {visibleImpacts.map(impact => <ImpactCard key={impact.id} impact={impact} onAnswer={answerQuestion} onAction={setAction} />)}
            </div>
          </>}
        </>}

        {view === 'history' && <>
          <div className="section-head"><div><span className="eyebrow">АУДИТ</span><h1>История изменений</h1></div></div>
          {impactHistory.map(impact=><ImpactCard key={impact.id} impact={impact} onAnswer={answerQuestion} onAction={setAction}/>)}
          <div className="history-grid">
            <div className="panel"><h2>Версии профиля</h2>{history.map((item:any) => <div className="timeline" key={item.id}><b>Версия {item.profile_version}</b><span>{new Date(item.created_at).toLocaleString('ru-RU')}</span></div>)}</div>
            <div className="panel"><h2>События</h2>{audit.map((item:any) => <div className="timeline" key={item.id}><b>{item.event_type}</b><span>{new Date(item.created_at).toLocaleString('ru-RU')}</span></div>)}</div>
          </div>
        </>}
      </section>
    </div>

    <nav className="bottom-nav">
      <button className={view==='dashboard'?'active':''} onClick={() => setView('dashboard')}>Изменения</button>
      <button className={view==='profile'?'active':''} onClick={() => setView('profile')}>Профиль</button>
      <button className={view==='history'?'active':''} onClick={() => void openHistory()}>История</button>
    </nav>
  </main>;
}

function ProfileField({field,value,answered,onChange}:{field:any;value:any;answered:boolean;onChange:(value:any)=>void}) {
  return <div className={`profile-field ${answered?'answered':''}`}><label>{field.label}</label>
    {field.type==='text' && <input value={value ?? ''} placeholder="Например, Москва" onChange={e => onChange(e.target.value || null)} />}
    {field.type==='select' && <select value={value ?? ''} onChange={e => onChange(e.target.value || null)}><option value="">Не выбрано</option>{field.options.map(([v,l]:string[]) => <option key={v} value={v}>{l}</option>)}</select>}
    {field.type==='bool' && <div className="choice-row"><button className={value===true?'selected':''} onClick={() => onChange(true)}>Да</button><button className={value===false?'selected':''} onClick={() => onChange(false)}>Нет</button><button className={answered&&value==null?'selected':''} onClick={() => onChange(null)}>Не знаю</button></div>}
    {field.type==='multiselect' && <div className="chips">{field.options.map(([v,l]:string[]) => { const arr=Array.isArray(value)?value:[]; const selected=arr.includes(v); return <button key={v} className={selected?'selected':''} onClick={() => onChange(selected?arr.filter((x:string)=>x!==v):[...arr,v])}>{l}</button>; })}</div>}
  </div>;
}

function ImpactCard({impact,onAnswer,onAction}:{impact:Impact;onAnswer:(i:Impact,f:string,v:unknown)=>Promise<void>;onAction:(id:string,s:string)=>Promise<void>}) {
  const [label,tone]=statusLabel(impact);
  const [expanded,setExpanded]=useState(impact.verdict!=='not_applicable');
  return <article id={`impact-${impact.ruleId}`} className={`impact-card tone-${tone}`}>
    <button className="impact-head" onClick={() => setExpanded(!expanded)}><div><span className={`status ${tone}`}>{label}</span><h2>{impact.rule.userTitle}</h2><p>{impact.rule.summary}</p></div><span className="chevron">{expanded?'−':'+'}</span></button>
    {expanded && <div className="impact-body">
      <div className="meta-grid"><div><span>Действует с</span><b>{impact.effectiveFrom ?? 'Уточняется по условиям'}</b></div><div><span>Проверено</span><b>{impact.rule.checkedAt}</b></div><div><span>Версия правила</span><b>v{impact.ruleVersion} · профиль {impact.profileVersion}</b></div></div>
      {impact.reasons?.length>0&&<div className="callout"><b>Почему получен результат</b>{impact.reasons.map((reason,index)=><p key={index}>{reason}</p>)}</div>}
      {impact.reviewReasons.length>0 && <div className="callout warning"><b>Нужна ручная проверка</b>{impact.reviewReasons.map(x => <p key={x}>{x}</p>)}</div>}
      {impact.isCurrent&&impact.questions.length>0 && <div className="callout info"><b>Нужно уточнить</b>{impact.questions.map(q => <QuestionInput key={q.field} q={q} onSubmit={(value)=>onAnswer(impact,q.field,value)} />)}</div>}
      {impact.actions.length>0 && <div className="actions"><h3>Что сделать</h3>{impact.actions.map(a => <div className={`action ${a.reviewRequired?'review-required':''}`} key={a.id}><div><b>{a.title}</b><p>{a.description}</p>{a.deadline&&<span>Срок: {a.deadline}</span>}{a.reviewRequired&&<span>Требует пересмотра после изменения основания</span>}</div><div className="action-buttons">{impact.isCurrent&&impact.timeState==='active'&&!a.reviewRequired&&a.executionStatus==='open'&&<button onClick={()=>void onAction(a.id,'in_progress')}>В работу</button>}{impact.isCurrent&&impact.timeState==='active'&&!a.reviewRequired&&a.executionStatus!=='completed'&&<button className="primary" onClick={()=>void onAction(a.id,'completed')}>Выполнено</button>}{a.executionStatus==='completed'&&<span className="done">✓ Выполнено</span>}</div></div>)}</div>}
      <div className="evidence"><h3>Основание</h3>{impact.rule.evidenceRefs.map(e => <button key={e.id} onClick={() => window.WebApp?.openLink ? window.WebApp.openLink(e.url) : window.open(e.url,'_blank')}>{e.label} ↗</button>)}</div>
    </div>}
  </article>;
}

function QuestionInput({q,onSubmit}:{q:ImpactQuestion;onSubmit:(v:unknown)=>Promise<void>}) {
  const [value,setValue]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [saving,setSaving]=useState(false);

  async function submit(next: unknown) {
    setSaving(true);
    try { await onSubmit(next); }
    finally { setSaving(false); }
  }

  if (q.inputType === 'boolean') {
    return <div className="question"><p>{q.text}</p><div className="choice-row">
      <button disabled={saving} onClick={()=>void submit(true)}>Да</button>
      <button disabled={saving} onClick={()=>void submit(false)}>Нет</button>
    </div><small>Если пока не знаете ответ, оставьте вопрос без ответа.</small></div>;
  }

  if (q.inputType === 'select') {
    return <div className="question"><p>{q.text}</p><div className="question-input">
      <select value={value} onChange={e=>setValue(e.target.value)}>
        <option value="">Выберите вариант</option>
        {(q.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button disabled={saving || !value} onClick={()=>void submit(value)}>Сохранить</button>
    </div></div>;
  }

  if (q.inputType === 'multi_select') {
    return <div className="question"><p>{q.text}</p><div className="chips">
      {(q.options ?? []).map(o => { const active=selected.includes(o.value); return <button type="button" key={o.value} className={active?'selected':''} onClick={()=>setSelected(active?selected.filter(v=>v!==o.value):[...selected,o.value])}>{o.label}</button>; })}
    </div><div className="question-footer"><button disabled={saving || selected.length===0} onClick={()=>void submit(selected)}>Сохранить выбор</button></div></div>;
  }

  if (q.inputType === 'string_list') {
    const list=value.split(',').map(v=>v.trim()).filter(Boolean);
    return <div className="question"><p>{q.text}</p><div className="question-input">
      <input value={value} onChange={e=>setValue(e.target.value)} placeholder={q.placeholder ?? 'Значения через запятую'}/>
      <button disabled={saving} onClick={()=>void submit(list)}>Сохранить</button>
    </div><small>Несколько значений укажите через запятую. Пустой список означает, что таких значений нет.</small></div>;
  }

  if (q.inputType === 'number') {
    return <div className="question"><p>{q.text}</p><div className="question-input">
      <input type="number" min="0" inputMode="decimal" value={value} onChange={e=>setValue(e.target.value)} placeholder={q.placeholder ?? 'Введите число'}/>
      <button disabled={saving || value===''} onClick={()=>void submit(Number(value))}>Сохранить</button>
    </div></div>;
  }

  if (q.inputType === 'date') {
    return <div className="question"><p>{q.text}</p><div className="question-input">
      <input type="date" value={value} onChange={e=>setValue(e.target.value)}/>
      <button disabled={saving || !value} onClick={()=>void submit(value)}>Сохранить</button>
    </div></div>;
  }

  return <div className="question"><p>{q.text}</p><div className="question-input">
    <input value={value} onChange={e=>setValue(e.target.value)} placeholder={q.placeholder ?? 'Введите значение'}/>
    <button disabled={saving || !value.trim()} onClick={()=>void submit(value.trim())}>Сохранить</button>
  </div></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname === '/review' || location.pathname.startsWith('/review/')
  ? <React.Suspense fallback={<div className="loading-card">Загрузка редактора…</div>}><ReviewApp /></React.Suspense> : <App />}</React.StrictMode>);
