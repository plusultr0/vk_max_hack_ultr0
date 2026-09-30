export type CheckSummaryItem={state:string;clarification?:string};
export function summarizeBusinessChecks(items:CheckSummaryItem[]) {
  const count=(state:string)=>items.filter(i=>i.state===state).length;
  return {
    total:items.length,present:count('present'),missing:count('missing'),
    unchecked:count('unchecked'),unknown:count('unknown'),
    clarify:items.filter(i=>i.state==='clarify'&&i.clarification!=='upcoming').length,
    upcoming:items.filter(i=>i.state==='clarify'&&i.clarification==='upcoming').length,
  };
}
/** Unknown/unchecked document observations never imply that an action is done. */
export function actionCheckState(status:string|undefined) {
  return status==='completed'?'present':status==='dismissed'?'unknown':'missing';
}
