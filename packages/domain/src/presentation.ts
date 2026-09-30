/**
 * Plain-language presentation only. Never changes a verdict or a persisted fact.
 * This module has no runtime dependency on Zod, the database or an LLM.
 */
export type Choice = { value: string; label: string };
export type FieldCopy = { title: string; question: string; hint: string; placeholder?: string };
export const FIELD_COPY: Record<string, FieldCopy> = {
  legalForm: { title:'Форма бизнеса', question:'Как оформлен ваш бизнес?', hint:'ИП или ООО указаны в документах о регистрации. Если работаете как самозанятый без ИП, выберите «Другое».' },
  industry: { title:'Отрасль бизнеса', question:'Чем в основном занимается бизнес?', hint:'Выберите основную отрасль. Она нужна, чтобы не показывать требования из чужих сфер. Если у бизнеса несколько направлений, выберите главное для текущей проверки.' },
  region: { title:'Где работает бизнес', question:'Где в основном работает бизнес?', hint:'Если работаете по всей стране, выберите «По всей России». Если работаете в России и странах СНГ — выберите этот вариант. Иначе укажите основной регион или другой охват вручную.', placeholder:'Например, Москва или Ленинградская область' },
  taxRegime: { title:'Система налогообложения', question:'Какая у вас система налогообложения?', hint:'Если у вас УСН «Доходы» или УСН «Доходы минус расходы», выберите УСН. Для текущих требований эти два варианта отдельно не различаются. Если не уверены, уточните у бухгалтера или выберите «Не знаю».' },
  registrationDate: { title:'Дата регистрации бизнеса', question:'Когда зарегистрировали бизнес?', hint:'Для ИП и ООО дата есть в выписке из государственного реестра: ЕГРИП для ИП или ЕГРЮЛ для организаций. Если у вас другая форма, укажите дату её регистрации.' },
  hasCombinedTaxRegimes: { title:'Несколько налоговых режимов', question:'Используете упрощённую систему (УСН) вместе с другой системой налогообложения?', hint:'Например, одновременно УСН и патентную систему. Если не уверены, выберите «Не знаю» и уточните у бухгалтера.' },
  sellsToConsumers: { title:'Продажи обычным покупателям', question:'Есть ли среди ваших покупателей обычные люди, а не только компании и ИП?', hint:'Ответьте «Да», если хотя бы часть покупателей берёт товары или услуги для себя, семьи или дома.' },
  salesChannels: { title:'Где принимаете заказы', question:'Где покупатели оформляют заказы?', hint:'Выберите все подходящие варианты. Если заказов пока нет, так и отметьте.' },
  distanceSales: { title:'Заказ без визита', question:'Можно оформить заказ без посещения магазина или офиса?', hint:'Например, на сайте, маркетплейсе, по телефону или в сообщениях.' },
  onlinePayment: { title:'Возможность онлайн-оплаты', question:'Подключена ли возможность онлайн-оплаты?', hint:'Необязательно. Это описание доступных способов оплаты. Для требования о чеках отдельно уточняются фактические расчёты через интернет; доступная кнопка оплаты ещё не означает, что такие расчёты есть.' },
  collectsPersonalData: { title:'Данные покупателей', question:'Получаете данные покупателей: имя, телефон, электронную почту или адрес?', hint:'Например, при заказе, доставке, обратном звонке, регистрации или подписке на новости.' },
  internetSettlement: { title:'Оплата через интернет', question:'Есть ли у бизнеса фактические расчёты с покупателями через интернет?', hint:'Например, на сайте или по платёжной ссылке. Если не уверены, уточните схему оплаты у бухгалтера или сервиса кассы.' },
  receiptIssuer: { title:'Кто выдаёт кассовый чек', question:'Кто отправляет покупателю кассовый чек?', hint:'Кассовый чек отличается от банковского уведомления об оплате. Посмотрите, кто указан продавцом в чеке.' },
  usesKkt: { title:'Онлайн-касса', question:'Для этих оплат вы используете онлайн-кассу?', hint:'Касса может быть своей или облачной. Если не уверены, уточните у бухгалтера или в сервисе, который формирует кассовые чеки.' },
  productCodes: { title:'Коды товаров', question:'Какие коды указаны в документах на эти товары?', hint:'Нужны коды товара из документов поставщика — обычно они подписаны «ТН ВЭД» или «ОКПД2». Не заменяйте код названием. Если документов нет под рукой, выберите «Не знаю».', placeholder:'Например: 9503 00, 32.40' },
  productGroups: { title:'Группы товаров', question:'Какие группы товаров продаёте?', hint:'Укажите группы через запятую.', placeholder:'Например: игрушки, одежда' },
  isExcludedProduct: { title:'Исключения для товара', question:'В официальном перечне есть исключение, которое подходит вашему товару?', hint:'Сравните характеристики товара с перечнем исключений в источнике или уточните у поставщика. Если ещё не сравнивали, выберите «Не знаю».' },
  isTurnoverParticipant: { title:'Работа с этим товаром', question:'Ваша компания продаёт, производит или ввозит эти товары?', hint:'Ответьте только за свою компанию, а не за поставщика или покупателя.' },
  hasResidualStock: { title:'Остатки товаров', question:'У вас есть остатки этих товаров без маркировки?', hint:'Речь о товарах, для которых проверяется требование в этой карточке.' },
  residualStockInRfOn2025_12_01: { title:'Остатки на 1 декабря 2025 года', question:'Эти остатки находились в России на 1 декабря 2025 года?', hint:'Сверьтесь со складским учётом или документами поставщика.' },
  residualStockProducedOrImportedBefore2025_12_01: { title:'Дата производства или ввоза', question:'Эти остатки произвели или ввезли до 1 декабря 2025 года?', hint:'Дата должна относиться к проверяемым товарам.' },
  usesConsent: { title:'Согласие на обработку данных', question:'В этой ситуации вы просите покупателя дать согласие на обработку данных?', hint:'Например, человек отдельно ставит отметку или подтверждает текст согласия. Само оформление заказа ещё не означает, что используется именно согласие.' },
  consentSeparate: { title:'Отдельное согласие', question:'Покупатель отдельно подтверждает согласие на обработку данных?', hint:'Посмотрите форму или документ: согласие должно подтверждаться отдельно, а не одной общей отметкой сразу за несколько документов.' },
  personalDataLegalBasis: { title:'Почему используете данные', question:'Почему бизнес использует эти данные покупателей?', hint:'Выберите ближайший вариант: человек дал согласие, данные нужны для выполнения договора, их требует закон или есть другая причина. Если вы раньше не определяли это основание, выберите «Не знаю».' },
  processingContexts: { title:'Для чего нужны данные', question:'В каких случаях собираете данные покупателей?', hint:'Можно выбрать несколько вариантов.' },
  sellsViaOwnSite: { title:'Свой сайт', question:'Покупатели оформляют заказы на вашем собственном сайте?', hint:'Маркетплейс здесь не считается вашим собственным сайтом.' },
  sellsViaAggregator: { title:'Продажи через площадку', question:'Продаёте через площадку, которая собирает предложения разных продавцов?', hint:'Например, через маркетплейс.' },
  sellerIdentityInfoChecked: { title:'Информация о продавце', question:'Вы уже сверяли данные продавца на сайте или в приложении с регистрационными документами?', hint:'Откройте страницу с данными продавца и сравните название, адрес, регистрационные данные и контакты. Если не знаете полный список, откройте официальный источник в карточке.' },
  sellerIdentityMissingFields: { title:'Чего не хватает в данных продавца', question:'После проверки страницы с данными продавца чего на ней не хватает?', hint:'Укажите только то, чего действительно нет. Если всё проверили и всё размещено, выберите «Всё есть».', placeholder:'Например: адрес, контакты' },
  income2025Usn: { title:'Доход по УСН за 2025 год', question:'Какой доход учтён для УСН за 2025 год?', hint:'Нужна сумма из налогового учёта, а не остаток на банковском счёте. Если точной суммы нет под рукой, выберите «Не знаю» и уточните у бухгалтера.', placeholder:'Например, 15 000 000' },
  incomeYtd2026: { title:'Доход по УСН с начала года', question:'Какой доход учтён для УСН с начала указанного года?', hint:'Нужна сумма из налогового учёта на дату расчёта, а не остаток на банковском счёте. Если точной суммы нет под рукой, выберите «Не знаю» и уточните у бухгалтера.', placeholder:'Например, 15 000 000' },
  incomeAsOf: { title:'Дата расчёта дохода', question:'На какую дату рассчитана указанная сумма дохода?', hint:'Выберите дату, к которой относится сумма, а не дату заполнения формы.' },
  revenuePreviousYear: { title:'Выручка компании за год', question:'Какая выручка от продаж была за указанный год?', hint:'Нужна выручка за всю компанию за этот год. Если точной суммы нет под рукой, выберите «Не знаю» и уточните у бухгалтера.', placeholder:'Например, 15 000 000' },
  tradeObjectRevenuePreviousYear: { title:'Выручка торговой точки', question:'Какая выручка была у этой торговой точки за указанный год?', hint:'Нужна выручка только по выбранной точке, а не по всей компании. Если точной суммы нет, выберите «Не знаю».', placeholder:'Например, 3 000 000' },
  tradeObjectId: { title:'Торговая точка', question:'Какую торговую точку проверяем?', hint:'Дайте понятное название. Следующие ответы про выручку и интернет должны относиться к этой точке.', placeholder:'Например, магазин на Лесной' },
  paymentLocationHasInternet: { title:'Интернет в торговой точке', question:'В месте приёма оплаты доступен интернет?', hint:'Ответьте за торговую точку, которую сейчас проверяете.' },
  hasEpaymentAcceptanceAgreementAsOf2026_01_01: { title:'Договор приёма платежей', question:'На 1 января 2026 года у бизнеса был договор с банком на приём электронной оплаты?', hint:'Например, договор на приём оплаты картой — эквайринг. Если не уверены, уточните у бухгалтера или банка.' },
  acquiringBankCategoryAsOf2026_01_01: { title:'Категория банка', question:'Какая категория была у вашего банка на 1 января 2026 года?', hint:'Это специальная категория из правил Банка России, а не тариф и не тип счёта. Если вы её не знаете, выберите «Не знаю» и уточните у банка.' },
  hasLoyaltyProgram: { title:'Программа лояльности', question:'Есть ли у бизнеса программа лояльности?', hint:'Например, накопительные баллы или скидочная карта.' },
};
export const VALUE_LABELS: Record<string,string> = {
  IP:'ИП',LLC:'ООО',USN:'УСН (упрощённая система)',OSNO:'ОСНО (общая система)',other:'Другое',
  retail_non_food:'Розничная торговля непродовольственными товарами',retail_food:'Розничная торговля продуктами',
  food_service:'Кафе, ресторан, общепит',food_production:'Производство пищевой продукции',manufacturing:'Производство непродовольственных товаров',
  construction:'Строительство',property_management:'Недвижимость и управление объектами',transport_logistics:'Перевозки и логистика',
  hotels:'Гостиницы и размещение',beauty:'Салоны красоты и бьюти-услуги',healthcare:'Медицинские услуги',pharmacy:'Аптека и фармацевтика',
  education:'Образование и курсы',childcare:'Детские центры и дошкольные услуги',fitness:'Фитнес и спортивные услуги',tourism:'Туризм и турагентские услуги',
  it_software:'IT, разработка и онлайн-сервисы',advertising:'Реклама, маркетинг и медиа',banking_fintech:'Финансовые и платёжные сервисы',
  accounting:'Бухгалтерские и налоговые услуги',crop_farming:'Растениеводство и фермерство',childrens_goods:'Детские товары и игрушки',
  auto_service:'Автосервис и ремонт транспорта',security_services:'Охранные услуги',waste_recycling:'Обращение с отходами и переработка',
  veterinary:'Ветеринарные услуги',industry_other:'Другая отрасль',
  own_site:'Свой сайт',marketplace:'Маркетплейс',social:'Соцсети',messenger:'Мессенджеры',offline:'Магазин или офис',
  company:'Наша компания',marketplace_or_agent:'Маркетплейс или агент',
  consent:'Согласие человека',contract:'Выполнение договора',law:'Требование закона',legitimate_interest:'Другая законная причина',mixed:'Несколько причин',
  systemically_important:'Системно значимый банк',significant_payment_market:'Значимый на рынке платёжных услуг',
  universal_license_other:'Другой банк с универсальной лицензией',
  order:'Оформление заказа',callback:'Обратный звонок',newsletter:'Рассылка',account:'Личный кабинет',
  name:'Название продавца',ogrn:'Регистрационный номер',address:'Адрес',contacts:'Контакты',
};
export function plainText(value: unknown, fallback = 'Подробности нужно уточнить'): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim()
    .replace(/\\n/g,' ')
    .replace(/^#{1,6}\s+/gm,'')
    .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
    .replace(/\*\*([^*]+)\*\*/g,'$1')
    .replace(/`([^`]+)`/g,'$1');
  // Do not leak a trace, a JSON blob or an internal field identifier to a customer.
  if (/facts\.[a-z]|[a-z]+[A-Z][A-Za-z]+\s*(?:[=:?]|$)|\b(?:eq|neq|gte|lte|contains_any|is_empty)\b|^NOT\s*\(|^[A-Z][A-Z_]{3,}$|^\s*[{[]|\\u[0-9a-f]{4}/.test(text)) return fallback;
  return text;
}
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Дата не указана';
  const date = new Date(value.slice(0,10)+'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==value.slice(0,10)) return 'Дата не указана';
  return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(date);
}
export function formatValue(value: unknown, options: Choice[] = [], unit = 'none'): string {
  if (value === null || value === undefined) return 'Не указано';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'number') {
    if(!Number.isFinite(value))return 'Не указано';
    const suffix: Record<string,string> = {RUB:' ₽',count:'',percent:' %',days:' дн.'};
    return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value)+(suffix[unit]??'');
  }
  if (Array.isArray(value)) return value.length ? value.map(v=>formatValue(v,options)).join(', ') : 'Ничего из перечисленного';
  if (typeof value !== 'string') return 'Значение нужно уточнить';
  const mapped=options.find(o=>o.value===value)?.label??VALUE_LABELS[value];
  if(mapped)return plainText(mapped,'Другое');
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return formatDate(value);
  return plainText(value,'Другое');
}
export function periodLabel(period?: {start:string|null;end:string|null;asOf:string|null}): string {
  if (!period) return '';
  const {start,end,asOf}=period;
  if(start&&end) {
    const last = new Date(end+'T00:00:00Z');
    if(!Number.isFinite(last.getTime())||!Number.isFinite(Date.parse(start))||end<=start)return '';
    last.setUTCDate(last.getUTCDate()-1);
    const inclusive=last.toISOString().slice(0,10);
    if(start.endsWith('-01-01')&&inclusive===start.slice(0,4)+'-12-31')return 'За '+start.slice(0,4)+' год';
    return 'С '+formatDate(start)+' по '+formatDate(inclusive);
  }
  return asOf ? 'По состоянию на '+formatDate(asOf) : '';
}
export type ResultShape = {
  isCurrent:boolean; timeState:string; verdict:string; reviewState:string; complianceState:string;
  questions?:unknown[]; actions?:{executionStatus:string}[];
};
export function resultCopy(i: ResultShape): {label:string;tone:string;summary:string;cta:string} {
  if(!i.isCurrent)return {label:'Предыдущий результат',tone:'muted',summary:'Это сохранённая версия результата. Ответы и отметки в ней уже нельзя менять.',cta:'Посмотреть'};
  if(['ended','cancelled'].includes(i.timeState))return {label:'Больше не действует',tone:'muted',summary:'Эта версия требования больше не действует. Мы сохранили её только для истории.',cta:'Посмотреть'};
  if(i.verdict==='not_applicable')return {label:'Не относится',tone:'muted',summary:'Сейчас это требование не относится к вашему бизнесу. Если данные бизнеса изменятся, результат пересчитается.',cta:'Почему не относится'};
  if(i.reviewState==='needs_review')return {label:'Нужно проверить вручную',tone:'warning',summary:'По вашим данным автоматического ответа недостаточно. Откройте карточку — там указано, что сверить по официальному источнику или со специалистом.',cta:'Что проверить'};
  if(i.verdict==='needs_info'||(i.questions?.length??0)>0)return {label:'Нужны ваши ответы',tone:'info',summary:'Для результата не хватает нескольких ответов о бизнесе. После сохранения карточка пересчитается.',cta:'Ответить'};
  if(i.timeState==='upcoming')return {label:'Понадобится позже',tone:'info',summary:'Требование начнёт действовать позже и может относиться к бизнесу. В карточке есть дата и шаги, которые можно подготовить заранее.',cta:'Посмотреть'};
  if(i.actions?.length&&i.actions.every(a=>a.executionStatus==='completed'))return {label:'Все шаги отмечены',tone:'success',summary:'Вы отметили все действия в этой карточке как выполненные. Сервис сохраняет вашу отметку, но не проверяет документы или настройки автоматически.',cta:'Посмотреть'};
  if(i.complianceState==='compliant')return {label:'Готово',tone:'success',summary:'По этому требованию сейчас нет незакрытых шагов. Сервис не открывал и не проверял ваши документы автоматически.',cta:'Посмотреть'};
  if(i.complianceState==='action_required')return {label:'Нужно выполнить шаги',tone:'warning',summary:'Остались действия. В карточке указано, что сделать и к какому сроку, если срок известен.',cta:'Что сделать'};
  return {label:'Нужно проверить готовность',tone:'accent',summary:'Это требование относится к вашему бизнесу, но по сохранённым данным пока нельзя понять, всё ли готово. Откройте карточку и посмотрите следующие шаги.',cta:'Что проверить'};
}
export function errorMessage(error: unknown): string {
  const code=typeof error==='string'?error:error instanceof Error?error.message:'';
  const messages:Record<string,string>={
    STALE_IMPACT:'Результат уже обновился. Откройте карточку заново и отправьте ответы ещё раз.',
    STALE_ACTION:'Список действий изменился. Обновите результат и выберите актуальное действие.',
    FACT_CHANGED:'Этот ответ уже изменился в другом окне. Обновите карточку перед сохранением.',
    INVALID_FACT_VALUE:'Проверьте введённое значение. Возможно, число или дата указаны в неверном формате.',
    INVALID_FACT_ANSWERS:'Проверьте заполненные поля и повторите сохранение.',
    FIELD_NOT_REQUESTED:'Этот вопрос больше не нужен для расчёта. Обновите результат.',
    FACT_NOT_CONFIRMABLE:'Данные изменились. Укажите актуальное значение ещё раз.',
    TRADE_OBJECT_REQUIRED:'Сначала укажите, какую торговую точку проверяем.',
    PROFILE_INCOMPLETE:'Ответьте на вопросы о бизнесе. Для неизвестных данных можно выбрать «Не знаю».',
    PROFILE_DRAFT_STALE:'Информация о бизнесе уже изменилась в другом окне. Обновите страницу перед сохранением.',
    PROFILE_NOT_CONFIRMED:'Сначала сохраните информацию о бизнесе.',
    INVALID_PROFILE_DRAFT:'Проверьте ответы о бизнесе и повторите сохранение.',
    PROFILE_CONFIRM_FAILED:'Не удалось завершить сохранение информации о бизнесе. Ответы сохранены, попробуйте ещё раз.',
    AUTH_REQUIRED:'Сессия завершилась. Откройте приложение из MAX ещё раз.',
    INVALID_SESSION:'Сессия завершилась. Откройте приложение из MAX ещё раз.',
    MAX_AUTH_FAILED:'Не удалось подтвердить вход. Откройте приложение кнопкой в боте MAX.',
    MAX_BOT_TOKEN_NOT_CONFIGURED:'Вход через MAX ещё настраивается.',
    DEV_AUTH_UNAVAILABLE:'Откройте приложение через бота MAX.',
    IMPACT_NOT_FOUND:'Эта карточка недоступна. Вернитесь к списку требований.',
    IDEMPOTENCY_CONFLICT:'Похоже, этот ответ уже отправлялся с другими данными. Обновите карточку и повторите действие.',
    CHECK_STALE:'Условия этого требования изменились. Откройте актуальный результат.',
    CHECK_NOT_AVAILABLE:'Сначала уточните данные о бизнесе для этого требования.',
    CHECK_ACTION_ANSWER_NOT_SUPPORTED:'Для действия отметьте выполнение или оставьте его открытым. Подробности можно посмотреть в карточке требования.',
    INVALID_HISTORY_QUERY:'Не удалось загрузить следующую страницу истории. Откройте историю заново.',
    CHECK_SAVE_FAILED:'Не удалось сохранить отметку. Повторите запрос.',
    FACT_ANSWER_FAILED:'Не удалось обновить результат. Ответы остались в форме. Повторите запрос.',
    DUPLICATE_FACT_ANSWER:'Один из ответов отправился дважды. Обновите карточку и повторите сохранение.',
    CHECK_NOT_FOUND:'Этого пункта больше нет в текущем требовании.',
    NETWORK_ERROR:'Нет связи с сервером. Ответы остались в форме. Проверьте соединение и повторите.',
    REQUEST_TIMEOUT:'Сервер не ответил вовремя. Ответы остались в форме. Повторите запрос.',
    SERVICE_UNAVAILABLE:'Сервис временно недоступен. Попробуйте ещё раз через минуту.',
  };
  for(const [key,message] of Object.entries(messages))if(code===key||code.startsWith(key+':'))return message;
  // Neither SQL/provider errors nor arbitrary HTML from a reverse proxy enter UI.
  return 'Не удалось выполнить действие. Ваши ответы остались в форме. Попробуйте ещё раз.';
}

export function reviewReasonText(value: unknown): string {
  const text=plainText(value,'');
  if(!text)return 'Для этой ситуации нужно сверить условия по официальному источнику или со специалистом.';
  if(/обязанност[ьи].*ККТ|применять ККТ/i.test(text))return 'Эта карточка проверяет интернет-чек, но не определяет, обязаны ли вы вообще использовать онлайн-кассу. Это нужно проверить отдельно.';
  if(/совмещени[ея].*режим/i.test(text))return 'Если вы совмещаете несколько систем налогообложения, автоматического расчёта этой карточки недостаточно. Уточните ситуацию у бухгалтера или по официальному источнику.';
  if(/конкретн(?:ой|ую) точк|канал/i.test(text))return 'Для конкретной торговой точки или способа оплаты могут действовать дополнительные условия. Сверьте их по официальному источнику или с банком.';
  if(/[A-Za-z_]{4,}|unsupported|definition|field|fact/i.test(text))return 'Для этой ситуации нужно сверить условия по официальному источнику или со специалистом.';
  return text;
}

export function auditLabel(event: string): string {
  if(event.startsWith('profile.'))return 'Обновлена информация о бизнесе';
  if(event==='facts.answered')return 'Сохранены ответы на вопросы';
  if(event==='action.status')return 'Изменена отметка о выполнении';
  if(event==='check.answered')return 'Обновлена отметка в документах и настройках';
  if(event.startsWith('impact.'))return 'Обновлён результат требования';
  if(event.includes('feedback'))return 'Сохранён ваш комментарий';
  return 'Сохранено изменение';
}
/** A readable description of the SAME expression; no decision is computed here. */
export function describeRequirement(node: unknown, fields: {field:string;title:string;options?:Choice[];unit?:string}[]): string {
  if(!node||typeof node!=='object')return 'Подробные условия приведены в официальном источнике.';
  const c=node as Record<string,unknown>;
  if(Array.isArray(c.conditions)) {
    const children=c.conditions.map(n=>describeRequirement(n,fields));
    return (c.op==='and'?'Одновременно должны выполняться: ':'Достаточно, чтобы выполнялось хотя бы одно: ')+children.join('; ');
  }
  if(c.op==='not')return 'Не должно выполняться условие: '+describeRequirement(c.condition,fields);
  const field=fields.find(f=>f.field===c.field);
  const title=field?.title??'Дополнительный параметр бизнеса';
  const value=(v:unknown)=>formatValue(v,field?.options,field?.unit);
  if(c.op==='eq')return `${title} — ${value(c.value)}`;
  if(c.op==='neq')return `${title} — не ${value(c.value)}`;
  const operators:Record<string,string>={gt:'больше',gte:'не меньше',lt:'меньше',lte:'не больше'};
  if(operators[String(c.op)])return `${title} — ${operators[String(c.op)]} ${value(c.value)}`;
  if(c.op==='in'||c.op==='contains_any')return `${title} — подходит хотя бы один вариант: ${value(c.values)}`;
  if(c.op==='contains_all')return `${title} — нужны все варианты: ${value(c.values)}`;
  if(c.op==='is_empty')return `${title} — ничего из списка`;
  return `${title} — нужно знать ответ`;
}

// Wording only. Applicability, dates, evidence and action identity stay in the rule.
// The mapping is deliberately restricted to the supplied version 1, never amendments.
export const CORE_RULE_COPY:Record<string,{title:string;summary:string;actions:Record<string,{title:string;description:string}>}>={
  kkt_online_receipts_v1:{
    title:'Чек при оплате через интернет',
    summary:'Если покупатели платят через интернет, к кассовому чеку могут применяться специальные требования. Карточка покажет, относятся ли они к вашей схеме оплаты и что сверить.',
    actions:{
      check_kkt_software:{title:'Проверить настройки кассовой программы',description:'Уточните в сервисе кассы, формирует ли он интернет-чек с нужными сведениями. Точный перечень можно открыть в официальном источнике.'},
      test_online_receipt:{title:'Проверить чек после тестовой оплаты',description:'Сделайте тестовую оплату, откройте именно кассовый чек и сравните его данные с перечнем из официального источника.'}
    }},
  usn_vat_start_2026_v1:{
    title:'НДС на упрощённой системе с начала 2026 года',
    summary:'Для бизнеса на УСН, зарегистрированного до 1 января 2026 года, проверяем доход за 2025 год. Если он превысил 20 млн ₽, НДС нужно учитывать с 1 января 2026 года.',
    actions:{prepare_vat_process_start_2026:{title:'Проверить с бухгалтером учёт НДС',description:'Сообщите бухгалтеру, что для этой карточки дата начала НДС — 1 января 2026 года. Проверьте, что с этой даты учёт, касса, договоры и рабочие документы ведутся с учётом НДС.'}}},
  usn_vat_threshold_during_2026_v1:{
    title:'НДС при росте дохода в 2026 году',
    summary:'Если доход на УСН в течение 2026 года превысил 20 млн ₽, НДС нужно учитывать с первого числа следующего месяца. Карточка рассчитывает эту дату по вашему доходу и дате расчёта.',
    actions:{prepare_vat_next_month:{title:'Подготовить учёт к дате начала НДС',description:'Уточните месяц, когда доход превысил установленную сумму, и передайте бухгалтеру дату из карточки. К этой дате нужно подготовить учёт и связанные процессы.'}}},
  child_goods_marking_v1:{
    title:'Маркировка детских игр и игрушек',
    summary:'Проверяем, нужно ли наносить обязательную маркировку на ваши игры или игрушки. Для результата понадобятся коды товаров и сведения об остатках.',
    actions:{
      prepare_output_reporting:{title:'Подготовить учёт и кассу для маркированных товаров',description:'Проверьте, готов ли учёт передавать сведения о продаже и списании маркированных товаров к дате из карточки.'},
      mark_residual_stock:{title:'Проверить подходящие под правило остатки',description:'Если у вас есть подходящие под это правило остатки без маркировки, откройте срок в карточке и проверьте, что нужно сделать именно с ними.'}
    }},
  pd_consent_separate_v1:{
    title:'Согласие покупателя на обработку данных',
    summary:'Если вы просите покупателя дать согласие на использование его данных, проверим, подтверждается ли это согласие отдельно от других документов и условий.',
    actions:{separate_consent:{title:'Оформить согласие отдельно',description:'Проверьте сам текст, как человек подтверждает согласие и сохраняете ли вы версию текста, которую он видел.'}}},
  distance_seller_identity_v1:{
    title:'Информация о продавце для покупателей',
    summary:'Если покупатель оформляет заказ дистанционно, ему должна быть доступна информация о продавце. Карточка поможет понять, что уже размещено, а что нужно проверить.',
    actions:{add_missing_seller_identity:{title:'Добавить недостающие сведения',description:'Добавьте недостающие данные о продавце в том месте, где покупатель оформляет заказ. Точный список сведений указан в официальном источнике.'}}},
  digital_ruble_acceptance_v1:{
    title:'Приём оплаты цифровыми рублями',
    summary:'Проверяем, относится ли к вашему бизнесу первый этап приёма цифровых рублей с сентября 2026 года. Для результата нужны выручка и сведения о банке на указанную дату.',
    actions:{prepare_digital_ruble_acceptance:{title:'Уточнить подключение и проверить оплату',description:'Уточните в банке, как подключить приём цифровых рублей для вашего бизнеса, затем проверьте настройки и тестовую оплату.'}}}
};
export function readableRule(i:{ruleId:string;ruleVersion:number;rule:{userTitle:string;summary:string}}) {
  const copy=i.ruleVersion===1?CORE_RULE_COPY[i.ruleId]:undefined;
  return {title:copy?.title??plainText(i.rule.userTitle,'Требование для бизнеса'),
    summary:copy?.summary??plainText(i.rule.summary,'Откройте карточку, чтобы посмотреть детали.')};
}
export function readableAction(i:{ruleId:string;ruleVersion:number;effectiveFrom?:string|null},a:{actionKey?:string;title:string;description:string}) {
  const copy=i.ruleVersion===1&&a.actionKey?CORE_RULE_COPY[i.ruleId]?.actions[a.actionKey]:undefined;
  if(i.ruleVersion===1&&a.actionKey==='prepare_vat_next_month'&&i.effectiveFrom) return {
    title:copy?.title??'Подготовить учёт к дате начала НДС',
    description:`По этой карточке НДС нужно начать учитывать с ${formatDate(i.effectiveFrom)}. Передайте эту дату бухгалтеру и проверьте, что к ней готовы учёт, касса, договоры и рабочие документы.`
  };
  return copy??{title:plainText(a.title,'Проверить готовность'),description:plainText(a.description,'Подробности приведены в источнике.')};
}
