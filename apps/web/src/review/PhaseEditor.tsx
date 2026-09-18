import React from 'react';
import type { Field, ReviewPhase } from './types.js';
import { Decision, DeadlineEditor, ExpressionEditor, References, TextField, type EvidenceProps } from './Fields.js';
import { expressionFields } from './model.js';

export default function PhaseEditor({ phase, onChange, fields, segments, onCite }: EvidenceProps & { phase: ReviewPhase; onChange: (phase: ReviewPhase) => void; fields: Field[] }) {
  const change = (patch: Partial<ReviewPhase>) => onChange({ ...phase, ...patch });
  const used = [...new Set([...phase.conditions, ...phase.exceptions].filter(c=>c.decision==='include').flatMap(c=>expressionFields(c.expression)))];
  const questions = [...new Set([...used, ...Object.keys(phase.questionMap)])];
  const base = () => ({ id:crypto.randomUUID(), originIndex:null, decision:'unresolved' as const, reason:null, sourceSegmentIndexes:[] });
  return <div className="rv-phase-editor" id="review-phase">
    <section className="rv-section"><h2>Этап требования</h2><Decision value={phase.decision} reason={phase.reason} onChange={change} />
      <TextField label="Название этапа" value={phase.title} onChange={title=>change({title})} />
      <TextField label="Заголовок для компании" value={phase.userTitle} onChange={userTitle=>change({userTitle})} />
      <TextField label="Краткое содержание" value={phase.summary} onChange={summary=>change({summary})} area />
      <div className="rv-form-grid"><TextField label="Кто обязан выполнить" value={phase.subjectRole} onChange={subjectRole=>change({subjectRole:subjectRole || null})} />
        <label className="rv-field"><span>Категория</span><select value={phase.category ?? ''} onChange={e=>change({category:e.target.value as ReviewPhase['category'] || null})}>
          <option value="">Выберите категорию</option>{Object.entries({kkt:'Кассы и чеки',tax:'Налоги',marking:'Маркировка',personal_data:'Персональные данные',distance_sales:'Дистанционная торговля',payments:'Платежи'}).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div>
      <label className="rv-field"><span>Область требования</span><select value={phase.scope ?? ''} onChange={e=>change({scope:e.target.value as ReviewPhase['scope'] || null})}>
        <option value="">Нужно определить</option><option value="company">Компания целиком</option><option value="trade_object">Конкретная торговая точка</option></select></label>
      <References value={phase.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>change({sourceSegmentIndexes})} segments={segments} onCite={onCite} />
      <details><summary>Идентификаторы и происхождение</summary><p className="rv-mono">{phase.ruleId}</p><p>Редакция правила: {phase.version}. {phase.originIndex === null ? 'Добавлено проверяющим' : `Этап ${phase.originIndex+1} исходного извлечения`}</p><p>Этапы имеют разные идентификаторы; редакции того же правила оформляются при публикации.</p></details>
    </section>
    {phase.decision !== 'exclude' && <><section className="rv-section"><h2>Период действия</h2>
      <TextField label="Начало действия (включительно)" value={phase.validFrom.date} type="date" onChange={date=>change({validFrom:{date:date || null,sourceSegmentIndexes:date ? phase.validFrom.sourceSegmentIndexes : []}})} />
      <References value={phase.validFrom.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>change({validFrom:{...phase.validFrom,sourceSegmentIndexes}})} segments={segments} onCite={onCite} />
      <TextField label="Окончание действия (дата не включается)" value={phase.validTo.date} type="date" onChange={date=>change({validTo:{date:date || null,sourceSegmentIndexes:date ? phase.validTo.sourceSegmentIndexes : []}})} />
      {phase.validTo.date && <References value={phase.validTo.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>change({validTo:{...phase.validTo,sourceSegmentIndexes}})} segments={segments} onCite={onCite} />}
      <TextField label="Основание окончания или его отсутствия" value={phase.endReason} onChange={endReason=>change({endReason:endReason || null})} area />
      <p className="rv-help">Начало следующего этапа само по себе не прекращает этот этап. Если источник не устанавливает окончание, оставьте дату пустой и объясните почему.</p>
    </section>
    {(['conditions','exceptions'] as const).map(kind=><section className="rv-section" key={kind}><h2>{kind==='conditions'?'Условия применимости':'Исключения'}</h2>
      {kind==='conditions' && <label className="rv-field"><span>Связь между условиями</span><select value={phase.conditionJoin ?? ''} onChange={e=>change({conditionJoin:e.target.value as 'and'|'or' || null})}>
        <option value="">Нужно определить</option><option value="and">Должны выполняться все (И)</option><option value="or">Достаточно любого (ИЛИ)</option></select></label>}
      {kind==='exceptions' && <p className="rv-help">Любое подтверждённое исключение освобождает субъект от этого требования. Сложное исключение можно описать вложенной логикой.</p>}
      {phase[kind].map((item,i)=>{ const patch = (part:Partial<typeof item>) => change({[kind]:phase[kind].map((v,j)=>i===j?{...v,...part}:v)});
        return <article className={`rv-item ${item.decision==='exclude'?'rv-excluded':''}`} key={item.id}><div className="rv-item-head"><b>{kind==='conditions'?'Условие':'Исключение'} {i+1}</b><span>{item.originIndex===null?'Добавлено вручную':'Из извлечения'}</span></div>
          <TextField label={kind==='conditions'?'Текст условия':'Текст исключения'} value={item.text} onChange={text=>patch({text})} area />
          <References value={item.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>patch({sourceSegmentIndexes})} segments={segments} onCite={onCite} />
          <Decision value={item.decision} reason={item.reason} onChange={patch} />
          {item.decision!=='exclude' && <ExpressionEditor value={item.expression} onChange={expression=>patch({expression})} fields={fields} segments={segments} onCite={onCite} />}
        </article>;
      })}
      <button type="button" disabled={phase[kind].length>=100} onClick={()=>change({[kind]:[...phase[kind],{...base(),text:kind==='conditions'?'Новое условие':'Новое исключение',expression:null}]})}>+ {kind==='conditions'?'Добавить условие':'Добавить исключение'}</button>
    </section>)}
    <section className="rv-section"><h2>Действия компании</h2>{phase.actions.map((action,i)=>{ const patch = (part:Partial<typeof action>)=>change({actions:phase.actions.map((a,j)=>i===j?{...a,...part}:a)});
      return <article className={`rv-item ${action.decision==='exclude'?'rv-excluded':''}`} key={action.id}><h3>Действие {i+1}</h3>
        <TextField label="Название действия" value={action.title} onChange={title=>patch({title})} /><TextField label="Что нужно сделать" value={action.description} onChange={description=>patch({description})} area />
        <Decision value={action.decision} reason={action.reason} onChange={patch} /><References value={action.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>patch({sourceSegmentIndexes})} segments={segments} onCite={onCite} />
        {action.decision!=='exclude' && <DeadlineEditor value={action.deadline} onChange={deadline=>patch({deadline})} segments={segments} onCite={onCite} />}</article>;
    })}<button type="button" disabled={phase.actions.length>=100} onClick={()=>change({actions:[...phase.actions,{...base(),title:'Новое действие',description:'Уточните действие',deadline:{kind:'unknown'}}]})}>+ Добавить действие</button></section>
    <section className="rv-section"><h2>Вопросы компании</h2><p className="rv-help">Эти вопросы появятся, если для включённых условий не хватает данных.</p>
      {!questions.length && <p>Сначала формализуйте и включите условия.</p>}{questions.map(name=><div key={name}><TextField label={fields.find(f=>f.name===name)?.label ?? name} value={phase.questionMap[name] ?? ''}
        onChange={text=>{const questionMap={...phase.questionMap}; if(text.trim())questionMap[name]=text; else delete questionMap[name]; change({questionMap});}} />
        {!used.includes(name) && <button type="button" onClick={()=>{const questionMap={...phase.questionMap}; delete questionMap[name]; change({questionMap});}}>Убрать вопрос без условия</button>}</div>)}</section></>}
  </div>;
}
