import React,{useState,useId,useRef,useEffect} from 'react';
import { formatValue, periodLabel, plainText, errorMessage, VALUE_LABELS } from '../../../../packages/domain/src/presentation.js';
import { formatNumberInput, parseNumberInput, questionFingerprint, newRequestId } from '../ui/model.js';
import type { FactQuestion, FactAnswer } from '../ui/types.js';
import { StyledSelect } from '../ui/StyledSelect.js';
export type { FactQuestion, FactAnswer } from '../ui/types.js';

export function FactQuestionsForm({questions,onSubmit,disabled=false}:{questions:FactQuestion[];onSubmit:(answers:FactAnswer[],requestId:string)=>Promise<void>;disabled?:boolean}) {
  const formId=useId();
  const [answers,setAnswers]=useState<Record<string,FactAnswer>>({});
  const [texts,setTexts]=useState<Record<string,string>>({});
  const [editing,setEditing]=useState<Record<string,boolean>>({});
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const lastQuestions=useRef<Record<string,string>>({});
  const request=useRef<{signature:string;id:string}|null>(null);
  const signature=JSON.stringify(questions.map(questionFingerprint));
  useEffect(()=>{
    const next=Object.fromEntries(questions.map(q=>[q.field,questionFingerprint(q)]));
    const retained=(field:string)=>next[field]===lastQuestions.current[field];
    setAnswers(old=>Object.fromEntries(Object.entries(old).filter(([field])=>retained(field))));
    setTexts(old=>Object.fromEntries(Object.entries(old).filter(([field])=>retained(field))));
    setEditing(old=>Object.fromEntries(Object.entries(old).filter(([field])=>retained(field))));
    lastQuestions.current=next;
  },[signature]);
  function set(q:FactQuestion,value:unknown,confirm=false) {
    setError('');
    setAnswers(a=>({...a,[q.field]:{field:q.field,value,confirm,expectedObservationId:q.expectedObservationId}}));
  }
  function clear(field:string) {
    setError('');
    setAnswers(old=>{const next={...old};delete next[field];return next;});
  }
  function text(q:FactQuestion,value:string) {
    const display=q.inputType==='number'&&q.unit==='RUB'?formatNumberInput(value):value;
    setTexts(old=>({...old,[q.field]:display}));
    if(display.trim())set(q,display);
    else clear(q.field);
  }
  async function submit(e:React.FormEvent) {
    e.preventDefault();if(saving||disabled)return;setSaving(true);setError('');
    try {
      const payload=questions.filter(q=>Object.hasOwn(answers,q.field)).map(q=>{
        const answer={...answers[q.field]!};
        if(!answer.confirm&&answer.value!==null) {
          if(q.inputType==='text'&&typeof answer.value==='string')answer.value=answer.value.trim()||null;
          if(q.inputType==='number')answer.value=parseNumberInput(texts[q.field]??String(answer.value),q);
          if(q.inputType==='string_list')answer.value=(texts[q.field]??'').split(/[,\n]/).map(v=>v.trim()).filter(Boolean);
          if(q.inputType==='date'&&typeof answer.value==='string') {
            const d=new Date(answer.value+'T00:00:00Z');
            if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==answer.value)throw new Error('INVALID_FACT_VALUE');
          }
        }
        return answer;
      });
      if(!payload.length)return;
      const key=JSON.stringify(payload);
      // Reuse the request ID after a timeout: the server may already have committed.
      if(request.current?.signature!==key)request.current={signature:key,id:newRequestId()};
      await onSubmit(payload,request.current.id);
      request.current=null;setAnswers({});setTexts({});setEditing({});
    } catch(error) {setError(errorMessage(error));} finally {setSaving(false);}
  }
  const answeredCount=Object.keys(answers).length;
  return <form onSubmit={submit} className="fact-questions">
    {questions.map((q,index)=>{
      const answer=answers[q.field],value=answer?.value;
      const id=formId+'-'+index,helpId=q.hint?id+'-help':undefined;
      const stale=q.status==='stale',showInput=!stale||editing[q.field]===true;
      const period=periodLabel(q.period);
      const options=q.options??[];
      const selected=(v:unknown)=>answer!==undefined&&!answer.confirm&&JSON.stringify(value)===JSON.stringify(v);
      const unknownButton=(extraClass='')=><button className={'secondary-choice '+extraClass+(selected(null)?' selected':'')} aria-pressed={selected(null)} type="button" onClick={()=>{setTexts(t=>({...t,[q.field]:''}));set(q,null);}}>Не знаю</button>;
      return <fieldset key={q.field} disabled={saving||disabled}>
        <legend>{questions.length>1&&<span className="question-number">Вопрос {index+1} из {questions.length}</span>}<span>{plainText(q.text,'Уточните данные о вашем бизнесе')}</span></legend>
        {q.hint&&<p className="field-help" id={helpId}>{plainText(q.hint,'Ответьте за свой бизнес. Если не уверены, можно выбрать «Не знаю».')}</p>}
        {period&&<p className="period">{period}</p>}
        {q.status==='fresh'&&<p className="current-answer">Сейчас сохранено: <b>{q.displayValue??formatValue(q.currentValue,options,q.unit)}</b></p>}
        {stale&&<div className="confirmation">
          <p>Раньше вы указали: <b>{q.displayValue??formatValue(q.currentValue,options,q.unit)}</b></p>
          <p className="field-help">Если прежний ответ всё ещё актуален, подтвердите его. Если изменился — исправьте.</p>
          <div className="choices"><button type="button" aria-pressed={answer?.confirm===true} className={answer?.confirm?'selected':''} onClick={()=>set(q,q.currentValue,true)}>Да, всё верно</button>
          <button type="button" onClick={()=>{setEditing(old=>({...old,[q.field]:true}));set(q,q.currentValue);if(q.inputType==='number'||q.inputType==='text'||q.inputType==='string_list')setTexts(t=>({...t,[q.field]:Array.isArray(q.currentValue)?q.currentValue.join(', '):q.inputType==='number'&&q.unit==='RUB'?formatNumberInput(String(q.currentValue??'')):String(q.currentValue??'')}));}}>Исправить ответ</button></div>
        </div>}
        {showInput&&!answer?.confirm&&<>
          {q.inputType==='boolean'&&<div className="choices" role="group" aria-label={q.text}>
            <button type="button" aria-pressed={selected(true)} className={selected(true)?'selected':''} onClick={()=>set(q,true)}>Да</button>
            <button type="button" aria-pressed={selected(false)} className={selected(false)?'selected':''} onClick={()=>set(q,false)}>Нет</button>
            {unknownButton()}
          </div>}
          {q.inputType==='select'&&<StyledSelect id={id} ariaLabel={q.text} ariaDescribedBy={helpId} value={selected(null)?'__unknown':typeof value==='string'?value:''} onChange={next=>set(q,next==='__unknown'?null:next||null)}
            options={[...options.map(o=>({value:o.value,label:VALUE_LABELS[o.value]??plainText(o.label,'Другой вариант')})),{value:'__unknown',label:'Не знаю'}]}/>} 
          {q.inputType==='multi_select'&&<><div className="option-list">{options.map(o=>{
            const values=Array.isArray(value)?value as string[]:[];
            return <label key={o.value}><input type="checkbox" checked={values.includes(o.value)} onChange={e=>set(q,e.target.checked?[...values,o.value]:values.filter(v=>v!==o.value))}/><span>{VALUE_LABELS[o.value]??plainText(o.label,'Другой вариант')}</span></label>;
          })}</div><div className="choice-tools"><button className={'secondary-choice '+(selected([])?'selected':'')} type="button" onClick={()=>set(q,[])}>Ничего из перечисленного</button>{unknownButton()}</div></>}
          {q.inputType==='number'&&<><div className="input-with-unit"><input id={id} aria-label={q.text} aria-describedby={helpId} type="text" inputMode="decimal" autoComplete="off"
            placeholder={q.placeholder??'Введите число'} value={texts[q.field]??''} onChange={e=>text(q,e.target.value)}/><span>{({RUB:'₽',count:'шт.',percent:'%',days:'дн.'} as Record<string,string>)[q.unit??'']??''}</span></div><div className="question-actions">{unknownButton()}</div></>}
          {q.inputType==='date'&&<><input id={id} aria-label={q.text} aria-describedby={helpId} type="date" value={typeof value==='string'?value:''} onChange={e=>e.target.value?set(q,e.target.value):clear(q.field)}/><div className="question-actions">{unknownButton()}</div></>}
          {q.inputType==='text'&&<><input id={id} aria-label={q.text} aria-describedby={helpId} maxLength={2000} placeholder={q.placeholder??'Введите ответ'} value={texts[q.field]??(typeof value==='string'?value:'')} onChange={e=>text(q,e.target.value)}/><div className="question-actions">{unknownButton()}</div></>}
          {q.inputType==='string_list'&&<>
            <textarea id={id} aria-label={q.text} aria-describedby={helpId} rows={2} maxLength={10000} placeholder={q.placeholder??'Укажите через запятую или с новой строки'} value={texts[q.field]??''} onChange={e=>text(q,e.target.value)}/>
            <div className="choice-tools"><button type="button" className={'secondary-choice '+(selected([])?'selected':'')} onClick={()=>{setTexts(t=>({...t,[q.field]:''}));set(q,[]);}}>
              {q.field==='sellerIdentityMissingFields'?'Всё есть':'Таких данных нет'}
            </button>{unknownButton()}</div>
          </>}
          {selected(null)&&<p className="unknown-note">Сохраним ответ «Не знаю». Если без него нельзя определить результат, карточка позже попросит уточнить данные.</p>}
        </>}
      </fieldset>;
    })}
    {error&&<p className="error-note" role="alert">{error}</p>}
    <div className="fact-form-footer">
      <button className="primary" disabled={saving||disabled||!answeredCount} type="submit">{saving?'Сохраняем и обновляем…':'Сохранить и обновить результат'}</button></div>
  </form>;
}
