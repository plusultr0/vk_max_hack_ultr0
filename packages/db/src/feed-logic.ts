export type FeedImpact={questions:unknown[];timeState:string;verdict:string;complianceState:string;actions:{executionStatus:string}[]};
export function feedState(impact:FeedImpact) {
  if(impact.verdict==='not_applicable')return 'not_applicable';
  if(impact.questions.length)return 'needs_info';
  if(impact.timeState==='upcoming')return 'upcoming';
  if(impact.complianceState==='action_required'&&impact.actions.some(a=>!['completed','dismissed'].includes(a.executionStatus)))return 'action_required';
  return impact.complianceState==='compliant'?'checked':'verify';
}
export function recentlyAdded(addedAt:string|null,now=Date.now()) {
  const at=addedAt?Date.parse(addedAt):NaN;
  return Number.isFinite(at)&&at>=now-90*86400_000&&at<=now;
}

export type FeedFilterItem={state:string;isRecent:boolean;impact:{timeState:string}};
export function feedMatchesFilter(item:FeedFilterItem,filter:string){
  if(filter==='all')return true;
  if(filter==='new')return item.isRecent;
  if(filter==='new_relevant')return item.isRecent&&item.state!=='not_applicable';
  if(filter==='relevant')return item.state!=='not_applicable';
  if(filter==='upcoming')return item.impact.timeState==='upcoming';
  return item.state===filter;
}
