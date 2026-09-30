import React,{useEffect,useId,useRef,useState} from 'react';

export type StyledSelectOption={value:string;label:string};

export function StyledSelect({id,value,options,onChange,placeholder='Выберите вариант',disabled=false,ariaLabel,ariaDescribedBy,testId,className=''}:{
  id?:string;value:string;options:StyledSelectOption[];onChange:(value:string)=>void;placeholder?:string;disabled?:boolean;
  ariaLabel?:string;ariaDescribedBy?:string;testId?:string;className?:string;
}) {
  const generated=useId(),buttonId=id??generated+'-button',listId=generated+'-list';
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false);
  const selected=options.find(o=>o.value===value);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  function keyboard(event:React.KeyboardEvent) {
    if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);button.current?.focus();}
    if((event.key==='ArrowDown'||event.key==='Enter'||event.key===' ')&&!open){event.preventDefault();setOpen(true);requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>('[role=option]')?.focus());}
  }
  return <div ref={root} className={'styled-select '+className} onKeyDown={keyboard}>
    <button ref={button} id={buttonId} data-testid={testId} type="button" className="styled-select-button" disabled={disabled}
      aria-label={ariaLabel} aria-describedby={ariaDescribedBy} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      onClick={()=>setOpen(v=>!v)}>
      <span className={selected?'':'styled-select-placeholder'}>{selected?.label??placeholder}</span><span className="styled-select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open&&<div id={listId} className="styled-select-menu" role="listbox" aria-label={ariaLabel}>
      {options.map(option=><button key={option.value} type="button" role="option" aria-selected={option.value===value}
        className="styled-select-option" onClick={()=>{onChange(option.value);setOpen(false);requestAnimationFrame(()=>button.current?.focus());}}>
        <span>{option.label}</span>{option.value===value&&<span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
