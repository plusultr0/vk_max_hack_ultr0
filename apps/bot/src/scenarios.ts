import { callbackButton, openMiniAppButton, type MaxButtonRows } from '@reg/max';

export type BotIntent = 'start'|'menu'|'status'|'requirements'|'actions'|'changes'|'documents'|'history'|'help'|'app'|'profile'|'unknown';

export const BOT_COMMANDS = [
  { name: 'start', description: 'Начать работу с сервисом' },
  { name: 'menu', description: 'Показать главное меню' },
  { name: 'status', description: 'Статус требований для бизнеса' },
  { name: 'requirements', description: 'Мои применимые требования' },
  { name: 'actions', description: 'Что нужно сделать' },
  { name: 'changes', description: 'Последние изменения' },
  { name: 'documents', description: 'Документы и важные настройки' },
  { name: 'history', description: 'История проверок и действий' },
  { name: 'profile', description: 'Открыть профиль бизнеса' },
  { name: 'help', description: 'Как работает сервис' },
];

function cleanText(value: string) {
  return value.trim().toLowerCase().replaceAll('ё','е').replace(/\s+/g,' ');
}

export function detectIntent(value: string | null | undefined): BotIntent {
  if (!value?.trim()) return 'unknown';
  const text = cleanText(value);
  const command = text.match(/^\/([a-z_]+)(?::[^\s]+)?(?:\s|$)/)?.[1];
  if (command) {
    const commands: Record<string,BotIntent> = {
      start:'start', menu:'menu', status:'status', requirements:'requirements', actions:'actions',
      changes:'changes', documents:'documents', history:'history', help:'help', app:'app', profile:'profile',
    };
    return commands[command] ?? 'unknown';
  }
  if (/^(привет|здравствуй|здравствуйте|начать|старт|меню)$/.test(text)) return 'menu';
  if (/(мой статус|статус|сводк|как дела у бизнеса|все ли в порядке|всё ли в порядке)/.test(text)) return 'status';
  if (/(мои требования|требования|законы|проверки|что относится|что касается)/.test(text)) return 'requirements';
  if (/(что делать|действия|задачи|что(?: мне| нам)? нужно сделать|что(?: мне| нам)? надо сделать|план действий|сроки)/.test(text)) return 'actions';
  if (/(что изменилось|изменения|новое|новые требования|обновления)/.test(text)) return 'changes';
  if (/(документы|документ|настройки|чеклист|чек-лист|что должно быть готово)/.test(text)) return 'documents';
  if (/(истори|что я делал|что уже сделал|прошлые проверки|предыдущие проверки)/.test(text)) return 'history';
  if (/(профиль|мой бизнес|данные бизнеса)/.test(text)) return 'profile';
  if (/(помощь|help|что умеешь|как пользоваться|как работает)/.test(text)) return 'help';
  if (/(открыть приложение|открыть мини|mini app|мини-приложение|мини приложение)/.test(text)) return 'app';
  return 'unknown';
}

export function mainMenuButtons(botUsername: string): MaxButtonRows {
  return [
    [openMiniAppButton(botUsername,'Открыть Mini App','home')],
    [callbackButton('Статус','nav:status'),callbackButton('Требования','nav:requirements')],
    [callbackButton('Действия','nav:actions'),callbackButton('Изменения','nav:changes')],
    [callbackButton('Документы','nav:documents'),callbackButton('Мой бизнес','nav:profile')],
    [callbackButton('История','nav:history'),callbackButton('Помощь','nav:help')],
  ];
}

export function sectionButtons(botUsername:string, view:string, primaryLabel:string): MaxButtonRows {
  return [
    [openMiniAppButton(botUsername,primaryLabel,view)],
    [callbackButton('← Меню','nav:menu')],
  ];
}

export function menuMessage(firstName?: string | null) {
  const hello = firstName ? `${firstName}, ` : '';
  return `${hello}я помогаю следить за требованиями, которые могут относиться к вашему бизнесу.\n\n`+
    `В чате можно быстро посмотреть статус, требования, действия и изменения. Для полного сценария откройте Mini App.`;
}

export function helpMessage() {
  return `Что умеет бот:\n\n`+
    `• «Статус» — краткая сводка по вашему бизнесу.\n`+
    `• «Требования» — что сейчас относится к бизнесу или требует уточнения.\n`+
    `• «Действия» — конкретные шаги и сроки; выполненное действие можно подтвердить прямо в чате.\n`+
    `• «Изменения» — недавно добавленные релевантные требования.\n`+
    `• «Документы» — что уже отмечено готовым, чего не хватает и что нужно уточнить.\n`+
    `• «История» — переход к сохранённым проверкам и действиям.\n`+
    `• Mini App — профиль бизнеса, подробные основания, официальные источники и полный план действий.\n\n`+
    `Бот не заменяет юридическую консультацию и оценивает только требования, загруженные в сервис.`;
}

export function appMessage() {
  return 'Откройте Mini App, чтобы пройти проверку, изменить профиль бизнеса и увидеть подробные карточки требований.';
}

export function unknownMessage() {
  return `Я не хочу угадывать юридический ответ по свободному тексту. Выберите один из сценариев ниже — так результат будет рассчитан по данным вашего бизнеса и проверенным требованиям.`;
}

const SEARCH_STOP_WORDS=new Set([
  'можно','нужно','надо','ли','мне','нам','мой','мои','моего','нашего','что','как','какие','какой','это','для','про','при','или','если',
  'есть','быть','делать','сделать','бизнес','компания','ип','ооо','закон','законы','требование','требования','проверить','проверка',
]);

function searchTokens(value:string) {
  return [...new Set(cleanText(value).replace(/[^a-zа-я0-9-]+/gi,' ').split(' ')
    .filter(token=>token.length>=4&&!SEARCH_STOP_WORDS.has(token)))];
}

function searchStem(token:string) {
  if(token.length<=4)return token;
  if(token.length<=6)return token.slice(0,-1);
  return token.slice(0,Math.max(5,token.length-3));
}

export function searchRequirements(baseline:any,query:string) {
  const tokens=searchTokens(query);
  if(!tokens.length)return [];
  return (baseline.items??[]).map((impact:any)=>{
    const haystack=cleanText([
      impact.rule?.userTitle,impact.rule?.summary,impact.rule?.category,
      ...(impact.actions??[]).flatMap((action:any)=>[action.title,action.description]),
    ].filter(Boolean).join(' '));
    const words=haystack.replace(/[^a-zа-я0-9-]+/gi,' ').split(' ').filter(Boolean);
    const score=tokens.reduce((sum,token)=>{
      const stem=searchStem(token);
      return sum+(words.some((word:string)=>word.startsWith(stem))?1:0);
    },0);
    return {impact,score};
  }).filter((item:any)=>item.score>0)
    .sort((a:any,b:any)=>b.score-a.score||priority(a.impact)-priority(b.impact)||String(a.impact.rule?.userTitle??'').localeCompare(String(b.impact.rule?.userTitle??'')))
    .map((item:any)=>item.impact);
}

export function searchMessage(matches:any[]) {
  if(!matches.length)return unknownMessage();
  const shown=matches.slice(0,5),lines=['По вашему текущему профилю нашёл связанные требования:',''];
  shown.forEach((impact:any,index:number)=>lines.push(`${index+1}. ${short(impact.rule?.userTitle??impact.ruleId)} — ${impactState(impact)}`));
  if(matches.length>shown.length)lines.push('',`Ещё ${countWord(matches.length-shown.length,'требование','требования','требований')} — в Mini App.`);
  lines.push('','Это поиск только по подтверждённой базе сервиса, а не свободная юридическая консультация.');
  return lines.join('\n');
}

export function searchButtons(botUsername:string,matches:any[]):MaxButtonRows {
  const rows:MaxButtonRows=matches.slice(0,3).map((impact:any,index:number)=>[
    openMiniAppButton(botUsername,`Открыть ${index+1}`,`assessment_${impact.id}`),
  ]);
  rows.push([openMiniAppButton(botUsername,'Вся проверка','check')]);
  rows.push([callbackButton('← Меню','nav:menu')]);
  return rows;
}

export function groupPrivacyMessage() {
  return `Персональные результаты бизнеса я не показываю в групповых чатах. Откройте личный диалог с ботом и используйте меню там.`;
}

export function profileNeededMessage(progress:{answered:number;total:number;percent:number}) {
  if (progress.answered > 0) {
    return `Профиль бизнеса ещё не подтверждён. Заполнено ${progress.answered} из ${progress.total} вопросов (${progress.percent}%). Продолжите в Mini App — после подтверждения я смогу показывать персональный статус и требования.`;
  }
  return `Сначала заполните короткий профиль бизнеса в Mini App. После этого я смогу показывать персональный статус, требования, действия и изменения.`;
}

function countWord(value:number, one:string, few:string, many:string) {
  const mod10=value%10,mod100=value%100;
  return value+' '+(mod10===1&&mod100!==11?one:mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?few:many);
}

export function statusMessage(baseline:any) {
  const s=baseline.summary;
  const assessed=baseline.coverage?.activeRulesAssessed ?? baseline.items?.length ?? 0;
  const lines=[
    'Статус по загруженным требованиям:',
    '',
    `• требуют действий: ${s.actionRequired}`,
    `• нужно уточнить данные: ${s.needsInfo}`,
    `• нужно проверить выполнение: ${s.verify}`,
    `• отмечены выполненными: ${s.selfReportedCompleted}`,
    `• оценено активных требований: ${assessed}`,
  ];
  if (baseline.refreshPending) lines.push('', 'Пересчёт ещё выполняется — данные могут обновиться в ближайшее время.');
  lines.push('', 'Это не полная юридическая экспертиза: сервис проверяет требования из своей подтверждённой базы.');
  return lines.join('\n');
}

function impactState(impact:any) {
  if (impact.questions?.length || impact.verdict==='needs_info') return 'нужно уточнить';
  const open=(impact.actions??[]).filter((a:any)=>!['completed','dismissed'].includes(a.executionStatus));
  if (impact.complianceState==='action_required' && open.length) return 'нужно действие';
  if ((impact.actions??[]).length && (impact.actions??[]).every((a:any)=>a.executionStatus==='completed')) return 'выполнено';
  if (impact.complianceState==='compliant') return 'выполнено';
  return 'нужно проверить';
}

function priority(impact:any) {
  if (impact.questions?.length) return 0;
  if (impact.complianceState==='action_required' && (impact.actions??[]).some((a:any)=>!['completed','dismissed'].includes(a.executionStatus))) return 1;
  if (['unknown','not_assessed'].includes(impact.complianceState)) return 2;
  return 3;
}

function short(value:string,max=76) {
  const text=value.replace(/\s+/g,' ').trim();
  return text.length<=max?text:text.slice(0,max-1).trimEnd()+'…';
}

export function requirementsMessage(baseline:any) {
  const items=[...(baseline.items??[])].sort((a:any,b:any)=>priority(a)-priority(b)||String(a.rule?.userTitle??'').localeCompare(String(b.rule?.userTitle??'')));
  if (!items.length) return 'Сейчас в подтверждённом профиле нет активных применимых требований из загруженной базы.';
  const shown=items.slice(0,5);
  const lines=['Мои требования:',''];
  shown.forEach((impact:any,index:number)=>lines.push(`${index+1}. ${short(impact.rule?.userTitle??impact.ruleId)} — ${impactState(impact)}`));
  if(items.length>shown.length)lines.push('',`Ещё ${countWord(items.length-shown.length,'требование','требования','требований')} — в Mini App.`);
  return lines.join('\n');
}

export type OpenAction = { action:any; impact:any };
export function openActions(baseline:any):OpenAction[] {
  const result:OpenAction[]=[];
  for(const impact of baseline.items??[])for(const action of impact.actions??[])
    if(!['completed','dismissed'].includes(action.executionStatus)&&!action.reviewRequired)result.push({action,impact});
  return result.sort((a,b)=>String(a.action.deadline??'9999-99-99').localeCompare(String(b.action.deadline??'9999-99-99'))||String(a.action.title).localeCompare(String(b.action.title)));
}

export function actionsMessage(baseline:any) {
  const items=openActions(baseline);
  if(!items.length)return 'Открытых действий сейчас нет. Если вы уже заполнили профиль, это означает, что по текущей базе нет невыполненных шагов.';
  const shown=items.slice(0,3),lines=['Что нужно сделать:',''];
  shown.forEach(({action,impact},index)=>lines.push(`${index+1}. ${short(action.title,68)}${action.deadline?` — до ${action.deadline}`:''}\n   ${short(impact.rule?.userTitle??impact.ruleId,68)}`));
  if(items.length>shown.length)lines.push('',`Ещё ${countWord(items.length-shown.length,'действие','действия','действий')} — в Mini App.`);
  return lines.join('\n');
}

export function actionButtons(botUsername:string, baseline:any):MaxButtonRows {
  const rows:MaxButtonRows=[];
  openActions(baseline).slice(0,3).forEach(({action,impact},index)=>{
    rows.push([
      callbackButton(`Готово ${index+1}`,`action:ask:${action.id}`),
      openMiniAppButton(botUsername,`Открыть ${index+1}`,`assessment_${impact.id}`),
    ]);
  });
  rows.push([openMiniAppButton(botUsername,'Все действия','check')]);
  rows.push([callbackButton('← Меню','nav:menu')]);
  return rows;
}

export function changesMessage(feed:any) {
  const items=feed.items??[];
  if(!items.length)return 'Новых релевантных изменений в текущей ленте пока нет.';
  const shown=items.slice(0,5),lines=['Последние изменения:',''];
  shown.forEach((item:any,index:number)=>{
    const date=item.addedAt?.slice?.(0,10)??item.discoveredAt?.slice?.(0,10)??item.publishedAt??'';
    lines.push(`${index+1}. ${short(item.impact?.rule?.userTitle??item.impact?.ruleId)}${date?` — ${date}`:''}`);
  });
  if((feed.total??items.length)>shown.length)lines.push('',`Ещё ${countWord((feed.total??items.length)-shown.length,'изменение','изменения','изменений')} — в Mini App.`);
  return lines.join('\n');
}

export function actionConfirmation(title:string,deadline?:string|null) {
  return `Подтвердить выполнение действия?\n\n${short(title,180)}${deadline?`\nСрок: ${deadline}`:''}\n\nПосле подтверждения оно будет отмечено выполненным и в Mini App.`;
}

export function documentsMessage(checks:any) {
  const s=checks.summary??{total:0,present:0,missing:0,clarify:0};
  const lines=[
    'Документы и важные настройки:',
    '',
    `• отмечено готовым: ${s.present??0}`,
    `• нужно сделать: ${s.missing??0}`,
    `• нужно уточнить: ${(s.clarify??0)+(s.unknown??0)}`,
    `• ещё не проверено: ${s.unchecked??0}`,
    `• понадобится позже: ${s.upcoming??0}`,
    `• всего проверок: ${s.total??0}`,
  ];
  const missing=(checks.items??[]).filter((item:any)=>item.state==='missing').slice(0,3);
  if(missing.length){
    lines.push('','В первую очередь:');
    missing.forEach((item:any,index:number)=>lines.push(`${index+1}. ${short(item.title,76)}`));
  }
  lines.push('','Подробности и отметки по каждому пункту доступны в Mini App.');
  return lines.join('\n');
}

export function historyMessage() {
  return 'История сохраняет предыдущие проверки, изменения требований и ваши отметки выполнения. Откройте Mini App, чтобы посмотреть её полностью.';
}
