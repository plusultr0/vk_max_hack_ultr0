import { z } from 'zod';
import { CompanyProfileSchema } from '@reg/domain';
import { fieldScope } from './draft.js';

const labels: Record<string, string> = {
  legalForm: 'Форма бизнеса', registrationDate: 'Дата регистрации', region: 'Регион', taxRegime: 'Налоговый режим',
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
export function reviewFieldCatalog() {
  return Object.entries(CompanyProfileSchema.shape).filter(([name]) => !['profileVersion', 'confirmedAt'].includes(name)).map(([name, input]) => {
    let schema: z.ZodTypeAny = input;
    while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) schema = schema.unwrap();
    const type = schema instanceof z.ZodArray ? 'array' : schema instanceof z.ZodBoolean ? 'boolean' : schema instanceof z.ZodNumber ? 'number'
      : ['registrationDate', 'incomeAsOf'].includes(name) ? 'date' : 'string';
    const scalar = schema instanceof z.ZodArray ? schema.element : schema;
    const operators = type === 'array' ? ['contains_any', 'contains_all', 'known', 'is_empty'] : type === 'number' || type === 'date'
      ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'known'] : type === 'boolean' ? ['eq', 'neq', 'in', 'known']
      : ['eq', 'neq', 'in', 'known', ...(schema instanceof z.ZodString ? ['is_empty'] : [])];
    return { name, label: labels[name] ?? name, type, scope: fieldScope(name), allowedValues: scalar instanceof z.ZodEnum ? scalar.options as string[] : null, operators };
  });
}
