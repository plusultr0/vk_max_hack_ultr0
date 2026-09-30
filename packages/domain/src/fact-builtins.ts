import { z } from 'zod';
import { CompanyProfileSchema, type LegalRule } from './schemas.js';
import { FactDefinitionSchema, type FactDefinition, type FactRequirement } from './fact-schema.js';
import { conditionFields } from './fact-logic.js';

const names:Record<string,string>={
  legalForm:'company.legalForm',industry:'company.industry',region:'company.region',registrationDate:'company.registrationDate',
  taxRegime:'tax.regime',sellsToConsumers:'sales.b2c',salesChannels:'sales.channels',
  distanceSales:'sales.distance',onlinePayment:'payments.online',collectsPersonalData:'personalData.collects',
  income2025Usn:'tax.income',incomeYtd2026:'tax.incomeYtd',revenuePreviousYear:'finance.revenue',
  tradeObjectRevenuePreviousYear:'tradeObject.revenue',paymentLocationHasInternet:'tradeObject.hasInternet',
};
const labels: Record<string, string> = {
  legalForm: 'Форма бизнеса', industry:'Отрасль бизнеса', registrationDate: 'Дата регистрации', region: 'Регион', taxRegime: 'Налоговый режим',
  hasCombinedTaxRegimes: 'Совмещение налоговых режимов', sellsToConsumers: 'Продажи физлицам', salesChannels: 'Каналы продаж',
  distanceSales: 'Дистанционные продажи', onlinePayment: 'Онлайн-оплата', usesKkt: 'Применение ККТ', internetSettlement: 'Расчёты в интернете',
  receiptIssuer: 'Кто формирует чек', productGroups: 'Группы товаров', productCodes: 'Коды товаров', isExcludedProduct: 'Товар в исключениях',
  isTurnoverParticipant: 'Участник оборота', hasResidualStock: 'Остатки товаров', residualStockInRfOn2025_12_01: 'Остатки в РФ на 01.12.2025',
  residualStockProducedOrImportedBefore2025_12_01: 'Остатки произведены или ввезены до 01.12.2025', collectsPersonalData: 'Сбор персональных данных',
  processingContexts: 'Контексты обработки данных', personalDataLegalBasis: 'Основания обработки данных', usesConsent: 'Использование согласия',
  consentSeparate: 'Отдельное согласие', hasLoyaltyProgram: 'Программа лояльности', sellsViaOwnSite: 'Продажи на своём сайте',
  sellsViaAggregator: 'Продажи через агрегатор', sellerIdentityInfoChecked: 'Сведения о продавце проверены', sellerIdentityMissingFields: 'Недостающие сведения о продавце',
  income2025Usn: 'Доход УСН за 2025 год', incomeYtd2026: 'Доход с начала 2026 года', incomeAsOf: 'Дата определения дохода',
  revenuePreviousYear: 'Выручка компании за предыдущий год', hasEpaymentAcceptanceAgreementAsOf2026_01_01: 'Договор приёма платежей на 01.01.2026',
  acquiringBankCategoryAsOf2026_01_01: 'Категория банка на 01.01.2026', tradeObjectRevenuePreviousYear: 'Выручка конкретной торговой точки', paymentLocationHasInternet: 'Интернет в месте расчёта',
};
const optionLabels:Record<string,string>={IP:'\u0418\u041f',LLC:'\u041e\u041e\u041e',USN:'\u0423\u0421\u041d',OSNO:'\u041e\u0421\u041d\u041e',other:'\u0414\u0440\u0443\u0433\u043e\u0435',
  own_site:'\u0421\u0432\u043e\u0439 \u0441\u0430\u0439\u0442',marketplace:'\u041c\u0430\u0440\u043a\u0435\u0442\u043f\u043b\u0435\u0439\u0441',
  offline:'\u041e\u0444\u043b\u0430\u0439\u043d',social:'\u0421\u043e\u0446\u0441\u0435\u0442\u0438',messenger:'\u041c\u0435\u0441\u0441\u0435\u043d\u0434\u0436\u0435\u0440'};
Object.assign(optionLabels,{"retail_non_food":"Розничная торговля непродовольственными товарами","retail_food":"Розничная торговля продуктами","food_service":"Кафе, ресторан, общепит","food_production":"Производство пищевой продукции","manufacturing":"Производство непродовольственных товаров","construction":"Строительство","property_management":"Недвижимость и управление объектами","transport_logistics":"Перевозки и логистика","hotels":"Гостиницы и размещение","beauty":"Салоны красоты и бьюти-услуги","healthcare":"Медицинские услуги","pharmacy":"Аптека и фармацевтика","education":"Образование и курсы","childcare":"Детские центры и дошкольные услуги","fitness":"Фитнес и спортивные услуги","tourism":"Туризм и турагентские услуги","it_software":"IT, разработка и онлайн-сервисы","advertising":"Реклама, маркетинг и медиа","banking_fintech":"Финансовые и платёжные сервисы","accounting":"Бухгалтерские и налоговые услуги","crop_farming":"Растениеводство и фермерство","childrens_goods":"Детские товары и игрушки","auto_service":"Автосервис и ремонт транспорта","security_services":"Охранные услуги","waste_recycling":"Обращение с отходами и переработка","veterinary":"Ветеринарные услуги","industry_other":"Другая отрасль","IP": "ИП", "LLC": "ООО", "other": "Другая категория", "USN": "УСН", "OSNO": "ОСНО", "company": "Наша компания", "marketplace_or_agent": "Маркетплейс или агент", "systemically_important": "Системно значимый банк", "significant_payment_market": "Значимый на рынке платёжных услуг", "universal_license_other": "Другой банк с универсальной лицензией", "consent": "Согласие", "contract": "Исполнение договора", "law": "Требование закона", "legitimate_interest": "Иной допустимый интерес/основание", "mixed": "Несколько оснований"});
const questionText: Record<string, string> = {
  tradeObjectId: 'Укажите обозначение конкретной торговой точки. Данные выручки и доступности интернета должны относиться к ней.',
  hasCombinedTaxRegimes: 'Совмещает ли компания УСН с другим налоговым режимом?',
  consentSeparate: 'Оформлено ли согласие на обработку персональных данных отдельно от других подтверждаемых документов?',
  sellerIdentityInfoChecked: 'Вы уже проверяли наличие обязательных сведений о продавце на сайте или в приложении?',
  sellerIdentityMissingFields: 'Каких обязательных сведений о продавце не хватает? Если всё размещено, оставьте список пустым.',
  productCodes: 'Укажите коды ТН ВЭД ЕАЭС или ОКПД2 для проверяемых товаров.',
  personalDataLegalBasis: 'Какие правовые основания обработки персональных данных используются в этом процессе?',
  registrationDate: 'Когда зарегистрированы ИП или организация?',
  incomeAsOf: 'На какую дату рассчитан доход с начала года?',
  income2025Usn: 'Какой доход по правилам УСН был за 2025 год?',
  incomeYtd2026: 'Какой доход по правилам УСН накоплен с начала 2026 года?',
  revenuePreviousYear: 'Какова выручка от реализации за предыдущий календарный год?',
  tradeObjectRevenuePreviousYear: 'Какова выручка конкретного торгового объекта за предыдущий календарный год?',
};
const numericPeriods=new Set(['income2025Usn','incomeYtd2026','revenuePreviousYear','tradeObjectRevenuePreviousYear']);
export function builtinFactDefinitions():FactDefinition[] {
  return Object.entries(CompanyProfileSchema.shape).filter(([key])=>!['profileVersion','confirmedAt','tradeObjectId'].includes(key)).map(([field,input])=>{
    let s:z.ZodTypeAny=input;while(s instanceof z.ZodOptional||s instanceof z.ZodNullable)s=s.unwrap();
    const array=s instanceof z.ZodArray,scalar=array?(s as z.ZodArray<z.ZodTypeAny>).element:s;
    const opts=scalar instanceof z.ZodEnum?(scalar.options as string[]).map(value=>({value,label:optionLabels[value]??value})):[];
    const type=s instanceof z.ZodBoolean?'boolean':s instanceof z.ZodNumber?'number':array?(opts.length?'multi_enum':'string_list'):
      opts.length?'enum':['registrationDate','incomeAsOf'].includes(field)?'date':'text';
    const key=names[field]??'profile.'+field;
    const stable=field==='registrationDate'||field==='legalForm'||/AsOf2026_01_01|2025_12_01/.test(field)||field==='income2025Usn';
    return FactDefinitionSchema.parse({key,version:1,semanticKey:key,title:labels[field]??field,
      description:'Existing profile field: '+field,type,scope:['tradeObjectRevenuePreviousYear','paymentLocationHasInternet'].includes(field)?'trade_object':'company',
      question:questionText[field]??(labels[field]??field)+'?',options:opts,freshness:{kind:stable?'stable':'periodic',maxAgeDays:stable?null:30},
      periodic:numericPeriods.has(field),unit:type==='number'?'RUB':'none',min:type==='number'?0:null,max:null,legacyField:field,origin:'builtin'});
  });
}
export function ruleFactRequirements(rule:LegalRule):FactRequirement[] {
  if(rule.factModel)return rule.factModel.requiredFacts;
  const defs=builtinFactDefinitions();
  const groups={applicability:[...conditionFields(rule.applicability.condition),...rule.manualReviewGates.flatMap(g=>conditionFields(g.condition))],compliance:[...conditionFields(rule.compliance.compliantWhen),...conditionFields(rule.compliance.actionRequiredWhen)],
    action:rule.actions.flatMap(a=>conditionFields(a.when)),deadline:rule.effectiveFrom.type==='first_day_next_month'?[rule.effectiveFrom.sourceField]:[]};
  return [...new Set(Object.values(groups).flat())].flatMap(field=>{
    const d=defs.find(d=>d.legacyField===field);if(!d)return [];
    const period:FactRequirement['period']=field==='income2025Usn'?{kind:'range',start:'2025-01-01',end:'2026-01-01'}:
      field==='incomeYtd2026'?{kind:'current_ytd'}:d.periodic?{kind:'previous_calendar_year'}:{kind:'none'};
    return [{field,key:d.key,definitionVersion:1,period,maxAgeDays:null,purposes:Object.entries(groups).filter(([,fields])=>fields.includes(field)).map(([purpose])=>purpose as FactRequirement['purposes'][number])}];
  });
}
