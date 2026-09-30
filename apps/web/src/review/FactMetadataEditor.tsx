import React,{useState} from 'react';
import type {Field,ReviewDocument} from './types.js';
export function boundFactFields(document:ReviewDocument|null):Field[] {
  if(!document)return [];
  return [...new Map(document.phases.flatMap(p=>(p.factRequirements??[]).flatMap(r=>{
    const d=document.factDefinitions?.find(d=>d.key===r.key&&d.version===r.definitionVersion);
    if(!d)return [];
    const type=d.type==='multi_enum'||d.type==='string_list'?'array':d.type==='enum'||d.type==='text'?'string':d.type;
    return [{name:r.field,label:d.title,type,scope:d.scope,allowedValues:d.options.length?d.options.map(o=>o.value):null,
      operators:type==='array'?['contains_any','contains_all','known','is_empty']:type==='number'||type==='date'?['eq','neq','gt','gte','lt','lte','in','known']:['eq','neq','in','known']}];
  })).map(f=>[f.name,f])).values()];
}
export function FactMetadataEditor({document,onChange}:{document:ReviewDocument;onChange:(d:ReviewDocument)=>void}) {
  const [value,setValue]=useState(JSON.stringify({definitions:document.factDefinitions??[],bindings:document.phases.map(p=>({phaseId:p.id,requiredFacts:p.factRequirements??[]}))},null,2));
  const [error,setError]=useState('');
  function apply() {
    try {
      if(value.length>300000)throw new Error('METADATA_TOO_LARGE');
      const parsed=JSON.parse(value);
      if(!Array.isArray(parsed.definitions)||!Array.isArray(parsed.bindings))throw new Error('INVALID_FACT_METADATA');
      onChange({...document,approvalMode:'human',factDefinitions:parsed.definitions,phases:document.phases.map(p=>({...p,
        factRequirements:parsed.bindings.find((b:any)=>b.phaseId===p.id)?.requiredFacts??p.factRequirements}))});setError('');
    }catch {setError('INVALID_FACT_METADATA');}
  }
  return <details className="rv-section"><summary>{'Факты и периоды — проверка оператором'}</summary>
    <p>{'Декларативные JSON-данные. Сервер проверит типы, привязки и конфликты при сохранении и публикации.'}</p>
    <textarea aria-label="Fact metadata JSON" rows={12} value={value} onChange={e=>setValue(e.target.value)}/>
    {error&&<p role="alert">{error}</p>}<button type="button" onClick={apply}>{'Применить к ревизии'}</button>
  </details>;
}
