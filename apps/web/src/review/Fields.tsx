import React from 'react';
import type { Field, ReviewExpression, ReviewPhase } from './types.js';

export function TextField({ label, value, onChange, area = false, type = 'text' }: { label: string; value: string | null; onChange: (value: string) => void; area?: boolean; type?: string }) {
  return <label className="rv-field"><span>{label}</span>{area ? <textarea rows={3} value={value ?? ''} onChange={e => onChange(e.target.value)} />
    : <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} />}</label>;
}
export type EvidenceProps = { segments: Array<{ sourceSegmentIndex: number; text: string }>; onCite: (index: number) => void };
export function References({ value, onChange, segments, onCite }: EvidenceProps & { value: number[]; onChange: (value: number[]) => void }) {
  return <div className="rv-references"><div className="rv-citations">{value.length ? value.map(index => <a href={`#source-${index}`} key={index} onClick={e => { e.preventDefault(); onCite(index); }}>§ {index + 1}</a>) : <span>Основание не выбрано</span>}</div>
    <details><summary>Выбрать фрагменты ({value.length})</summary><div className="rv-ref-picker">{segments.map(segment => <label key={segment.sourceSegmentIndex}>
      <input type="checkbox" checked={value.includes(segment.sourceSegmentIndex)} onChange={e => onChange(e.target.checked ? [...value, segment.sourceSegmentIndex].sort((a,b)=>a-b) : value.filter(i => i !== segment.sourceSegmentIndex))} />
      <span><b>§ {segment.sourceSegmentIndex + 1}</b> {segment.text.slice(0, 110)}…</span></label>)}</div></details></div>;
}
export function Decision({ value, reason, onChange }: { value: string; reason: string | null; onChange: (patch: { decision?: 'unresolved' | 'include' | 'exclude'; reason?: string | null }) => void }) {
  return <div className="rv-decision"><label className="rv-field"><span>Решение</span><select value={value} onChange={e => onChange({ decision: e.target.value as 'include' })}>
    <option value="unresolved">Нужно проверить</option><option value="include">Включить</option><option value="exclude">Исключить</option></select></label>
    <TextField label="Обоснование решения" value={reason} onChange={reason => onChange({ reason: reason || null })} /></div>;
}
const opLabels: Record<string,string> = { eq:'Равно', neq:'Не равно', gt:'Больше', gte:'Не меньше', lt:'Меньше', lte:'Не больше', in:'Одно из значений', contains_any:'Содержит хотя бы одно', contains_all:'Содержит все', known:'Значение известно', is_empty:'Пустой список / строка' };
type Scalar = string | number | boolean;
export function ValueInput({ field, value, onChange, multiple = false, label = 'Значение' }: { field?: Field; value: Scalar | Scalar[] | null; onChange: (value: Scalar | Scalar[] | null) => void; multiple?: boolean; label?: string }) {
  const values = field?.allowedValues ?? (field?.type === 'boolean' ? ['true', 'false'] : null);
  const convert = (v: string): Scalar => field?.type === 'number' ? Number(v) : field?.type === 'boolean' ? v === 'true' : v;
  if (multiple && values) return <div className="rv-field"><span>{label}</span><div className="rv-value-options">{values.map(v => <label key={v}><input type="checkbox" checked={Array.isArray(value) && value.includes(convert(v))}
    onChange={e => { const old = Array.isArray(value) ? value : []; onChange(e.target.checked ? [...old, convert(v)] : old.filter(x => x !== convert(v))); }} />{v === 'true' ? 'Да' : v === 'false' ? 'Нет' : v}</label>)}</div></div>;
  if (!multiple && values) return <label className="rv-field"><span>{label}</span><select value={value === null || Array.isArray(value) ? '' : String(value)} onChange={e => onChange(e.target.value ? convert(e.target.value) : null)}>
    <option value="">Не задано</option>{values.map(v => <option key={v} value={v}>{v === 'true' ? 'Да' : v === 'false' ? 'Нет' : v}</option>)}</select></label>;
  if (multiple) return <ListInput value={Array.isArray(value) ? value : []} onChange={onChange} field={field} label={label} />;
  return <label className="rv-field"><span>{label}</span><input type={field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'} min={field?.type === 'number' ? 0 : undefined}
    value={value === null || Array.isArray(value) ? '' : String(value)} onChange={e => onChange(e.target.value === '' ? null : convert(e.target.value))} /></label>;
}
function ListInput({ value, onChange, field, label }: { value: Scalar[]; onChange: (value: Scalar[]) => void; field?: Field; label: string }) {
  // Preserve partial input (including a trailing delimiter) until a different document is loaded.
  const [raw, setRaw] = React.useState(value.join('\n'));
  const emitted = React.useRef(JSON.stringify(value));
  React.useEffect(() => { const next=JSON.stringify(value); if(next!==emitted.current)setRaw(value.join('\n')); emitted.current=next; }, [JSON.stringify(value)]);
  const parsed = raw.split(/\n/).map(v => v.trim()).filter(Boolean);
  const valid = field?.type !== 'number' || parsed.every(v => Number.isFinite(Number(v)) && Number(v) >= 0);
  return <div className="rv-field"><label><span>{label} — по одному на строке</span><textarea value={raw} onChange={e => { const next = e.target.value; setRaw(next); const lines = next.split(/\n/).map(v=>v.trim()).filter(Boolean);
    const nextValues=lines.map(v => field?.type === 'number' ? Number(v) : v); emitted.current=JSON.stringify(nextValues); onChange(nextValues); }} /></label>{!valid && <span className="rv-danger">Ожидаются неотрицательные числа.</span>}</div>;
}
export function ExpressionEditor({ value, onChange, fields, segments, onCite, depth = 0 }: EvidenceProps & { value: ReviewExpression | null; onChange: (value: ReviewExpression | null) => void; fields: Field[]; depth?: number }) {
  const kind = value === null ? 'unmapped' : 'conditions' in value ? value.op : 'condition' in value ? 'not' : 'predicate';
  const blank = (): ReviewExpression => ({ op: 'eq', field: 'legalForm', value: null, scope: 'company', sourceSegmentIndexes: [] });
  const changeKind = (next: string) => onChange(next === 'unmapped' ? null : next === 'predicate' ? blank() : next === 'not' ? { op: 'not', condition: value ?? blank() }
    : { op: next as 'and' | 'or', conditions: [value ?? blank()] });
  const leaf = value && 'field' in value ? value : null;
  const field = fields.find(f => f.name === leaf?.field);
  return <div className="rv-expression"><label className="rv-field"><span>Логика условия</span><select aria-label="Логика условия" value={kind} onChange={e => changeKind(e.target.value)}>
    <option value="unmapped">Не формализовано</option><option value="predicate">Проверка признака</option>{depth < 7 && <><option value="and">Все условия (И)</option><option value="or">Любое условие (ИЛИ)</option><option value="not">Отрицание (НЕ)</option></>}</select></label>
    {leaf && <><div className="rv-form-grid"><label className="rv-field"><span>Признак</span><select value={leaf.field} onChange={e => { const f = fields.find(f=>f.name===e.target.value)!; onChange({ ...leaf, field: f.name, scope: f.scope, op: f.operators[0] as typeof leaf.op, value: f.type === 'array' ? [] : null }); }}>
      {fields.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}</select></label>
      <label className="rv-field"><span>Оператор</span><select value={leaf.op} onChange={e => onChange({ ...leaf, op: e.target.value as typeof leaf.op, value: ['known','is_empty'].includes(e.target.value) ? null : ['in','contains_any','contains_all'].includes(e.target.value) ? [] : null })}>
        {(field?.operators ?? [leaf.op]).map(op => <option key={op} value={op}>{opLabels[op] ?? op}</option>)}</select></label></div>
      {!['known','is_empty'].includes(leaf.op) && <ValueInput field={field} value={leaf.value} onChange={v=>onChange({...leaf,value:v})} multiple={['in','contains_any','contains_all'].includes(leaf.op)} />}
      <p className="rv-help">Область признака: {leaf.scope === 'trade_object' ? 'конкретная торговая точка' : 'компания'}</p><References value={leaf.sourceSegmentIndexes} onChange={refs=>onChange({...leaf,sourceSegmentIndexes:refs})} segments={segments} onCite={onCite} /></>}
    {value && 'conditions' in value && <>{value.conditions.map((child, i) => <div className="rv-expression-child" key={i}><ExpressionEditor value={child} onChange={next=>onChange({...value,conditions:value.conditions.map((x,j)=>i===j ? next ?? blank() : x)})} fields={fields} segments={segments} onCite={onCite} depth={depth+1} />
      <button type="button" disabled={value.conditions.length === 1} onClick={()=>onChange({...value,conditions:value.conditions.filter((_,j)=>j!==i)})}>Убрать вложенную проверку</button></div>)}
      <button type="button" disabled={value.conditions.length>=50} onClick={()=>onChange({...value,conditions:[...value.conditions,blank()]})}>+ Вложенная проверка</button></>}
    {value && 'condition' in value && <ExpressionEditor value={value.condition} onChange={next=>onChange({...value,condition:next ?? blank()})} fields={fields} segments={segments} onCite={onCite} depth={depth+1} />}
  </div>;
}
export function DeadlineEditor({ value, onChange, segments, onCite }: EvidenceProps & { value: ReviewPhase['actions'][number]['deadline']; onChange: (value: ReviewPhase['actions'][number]['deadline']) => void }) {
  return <div className="rv-deadline"><label className="rv-field"><span>Срок действия</span><select value={value.kind} onChange={e => onChange(e.target.value === 'fixed' ? { kind:'fixed', date:'', sourceSegmentIndexes:[] }
    : e.target.value === 'relative' ? {kind:'relative',description:'',sourceSegmentIndexes:[]} : e.target.value === 'none' ? {kind:'none',reason:''} : {kind:e.target.value as 'unknown'|'phase_start'})}>
    <option value="unknown">Не определён</option><option value="fixed">Дата из источника</option><option value="phase_start">К началу этапа (расчётный)</option><option value="none">Срок не установлен</option><option value="relative">Относительный срок — требует доработки</option></select></label>
    {value.kind === 'fixed' && <TextField label="Дата срока" type="date" value={value.date} onChange={date=>onChange({...value,date})} />}
    {value.kind === 'none' && <TextField label="Почему срок отсутствует" value={value.reason} onChange={reason=>onChange({...value,reason})} />}
    {value.kind === 'relative' && <TextField label="Описание относительного срока" value={value.description} onChange={description=>onChange({...value,description})} />}
    {'sourceSegmentIndexes' in value && <References value={value.sourceSegmentIndexes} onChange={sourceSegmentIndexes=>onChange({...value,sourceSegmentIndexes})} segments={segments} onCite={onCite} />}
    {value.kind === 'phase_start' && <p className="rv-help">Срок вычисляется из начала этапа; это не отдельная дата, прямо указанная в источнике.</p>}
  </div>;
}
