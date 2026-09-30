/**
 * Pilot readiness checklist derived from the supplied Core-7 action descriptions.
 * These are documents/settings to inspect, NOT ten universally mandatory papers.
 * Version-1 mappings must not silently attach to amended versions of a rule.
 */
export type BusinessCheckTemplate = {
  key:string;version:number;ruleIds:string[];ruleVersion:number;kind:'document'|'setting'|'action';
  title:string;help:string;
};
export const PILOT_BUSINESS_CHECKS: BusinessCheckTemplate[] = [
  {key:'receipt-software',version:1,ruleIds:['kkt_online_receipts_v1'],ruleVersion:1,kind:'setting',
    title:'Настройки онлайн-кассы',help:'Уточните в сервисе кассы, формирует ли он интернет-чек с нужными сведениями. После проверки отметьте, всё ли настроено или нужны изменения.'},
  {key:'receipt-example',version:1,ruleIds:['kkt_online_receipts_v1'],ruleVersion:1,kind:'document',
    title:'Пример кассового чека после онлайн-оплаты',help:'Сделайте тестовую оплату и откройте кассовый чек, который получает покупатель. Сравните его с перечнем из официального источника. Банковское уведомление об оплате — это не кассовый чек.'},
  {key:'consent-text',version:1,ruleIds:['pd_consent_separate_v1'],ruleVersion:1,kind:'document',
    title:'Отдельное согласие покупателя',help:'Если покупатель даёт согласие на использование своих данных, проверьте, что он подтверждает его отдельно, а не одной общей отметкой сразу за несколько документов.'},
  {key:'consent-record',version:1,ruleIds:['pd_consent_separate_v1'],ruleVersion:1,kind:'setting',
    title:'Как вы сохраняете подтверждение согласия',help:'Проверьте, сохраняете ли вы факт согласия и текст, который видел покупатель в момент подтверждения. Этот пункт относится к той же карточке требования, а не к отдельной обязанности.'},
  {key:'seller-details',version:1,ruleIds:['distance_seller_identity_v1'],ruleVersion:1,kind:'document',
    title:'Информация о продавце на сайте',help:'Откройте страницу с информацией о продавце и сравните её с регистрационными документами. Точный перечень сведений можно посмотреть в официальном источнике.'},
  {key:'seller-contacts',version:1,ruleIds:['distance_seller_identity_v1'],ruleVersion:1,kind:'document',
    title:'Контакты продавца в месте оформления заказа',help:'Проверьте, видит ли покупатель актуальные контакты продавца там, где оформляет заказ. Если не уверены в полном перечне, откройте официальный источник.'},
  {key:'vat-accounting',version:1,ruleIds:['usn_vat_start_2026_v1','usn_vat_threshold_during_2026_v1'],ruleVersion:1,kind:'setting',
    title:'Учёт и касса перед началом НДС',help:'Покажите бухгалтеру дату из карточки и проверьте, готовы ли учёт и касса к работе с НДС — налогом на добавленную стоимость.'},
  {key:'vat-contracts',version:1,ruleIds:['usn_vat_start_2026_v1','usn_vat_threshold_during_2026_v1'],ruleVersion:1,kind:'document',
    title:'Договоры и рабочие шаблоны перед НДС',help:'Передайте бухгалтеру договоры и рабочие шаблоны и уточните, нужны ли в них изменения из-за НДС. Здесь вы отмечаете только результат своей проверки.'},
  {key:'vat-date',version:1,ruleIds:['usn_vat_start_2026_v1','usn_vat_threshold_during_2026_v1'],ruleVersion:1,kind:'document',
    title:'Расчёт дохода и дата начала НДС',help:'Проверьте расчёт дохода и дату, с которой по этой карточке нужно учитывать НДС. Если доход превысил установленную сумму в течение года, уточните у бухгалтера месяц превышения.'},
  {key:'digital-payment',version:1,ruleIds:['digital_ruble_acceptance_v1'],ruleVersion:1,kind:'setting',
    title:'Приём цифровых рублей',help:'Если это требование относится к бизнесу, уточните в банке, как подключить приём цифровых рублей, затем проверьте настройки и тестовую оплату.'},
  {key:'marking-process',version:1,ruleIds:['child_goods_marking_v1'],ruleVersion:1,kind:'setting',
    title:'Учёт и касса для маркированных игрушек',help:'Проверьте, готовы ли учёт и касса работать с продажей и списанием маркированных товаров к дате из карточки. Если дата ещё не наступила, это подготовка заранее.'},
  {key:'marking-stock',version:1,ruleIds:['child_goods_marking_v1'],ruleVersion:1,kind:'document',
    title:'Остатки игрушек без маркировки',help:'Проверьте, есть ли у вас такие остатки и подходят ли они под условия карточки. Этот пункт относится только к проверяемым товарам, а не ко всему ассортименту.'},
];
export type CheckImpact = {
  id:string;ruleId:string;ruleVersion:number;isCurrent:boolean;timeState:string;verdict:string;reviewState:string;
  questions:unknown[];rule:{userTitle:string;evidenceRefs:unknown[]};
  actions:{id?:string;actionKey?:string;title:string;description:string;executionStatus?:string;reviewRequired?:boolean;completedAt?:unknown}[];
};
export function businessCheckTemplates(impacts:CheckImpact[]) {
  const live=impacts.filter(i=>i.isCurrent&&!['ended','cancelled'].includes(i.timeState)&&i.verdict!=='not_applicable');
  const represented=new Set<string>();
  const rows:PilotCheck[]=[];
  for(const t of PILOT_BUSINESS_CHECKS) {
    // Keep one item for every distinct duty/phase. Never let a newer unrelated
    // rule steal the checklist entry or reuse its completion.
    const matches=live.filter(i=>t.ruleIds.includes(i.ruleId)&&i.ruleVersion===t.ruleVersion);
    for(const impact of matches) {
      represented.add(impact.ruleId+':'+impact.ruleVersion);
      rows.push({template:t,impact,checkKey:t.key+':'+impact.ruleId+':v'+impact.ruleVersion});
    }
  }
  // A new, approved rule can contribute its own action checks without code changes.
  for(const impact of live.filter(i=>!represented.has(i.ruleId+':'+i.ruleVersion))) {
    if(impact.actions.length)impact.actions.forEach((action,index)=>rows.push({
      actionId:action.id,template:{key:'rule-action-'+(action.actionKey??index),version:1,ruleIds:[impact.ruleId],ruleVersion:impact.ruleVersion,
        kind:'action',title:action.title,help:action.description},impact,
      checkKey:'rule-action:' + impact.ruleId + ':v' + impact.ruleVersion + ':' + (action.actionKey??index)
    }));
    else rows.push({template:{key:'rule-readiness',version:1,ruleIds:[impact.ruleId],ruleVersion:impact.ruleVersion,
      kind:'action',title:impact.rule.userTitle,help:'Сначала ответьте на вопросы в карточке. После этого сервис сможет показать, что именно нужно сделать.'},
      impact,checkKey:'rule-readiness:'+impact.ruleId+':v'+impact.ruleVersion});
  }
  return rows;
}
export type PilotCheck={template:BusinessCheckTemplate;impact:CheckImpact;checkKey:string;actionId?:string};
export function checkAnswerAllowed(impact:CheckImpact) {
  return impact.isCurrent && impact.timeState==='active' && impact.verdict==='applies' &&
    impact.reviewState!=='needs_review' && impact.questions.length===0;
}
