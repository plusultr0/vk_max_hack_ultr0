import { createSourceSnapshot, materializeExtraction, validateRegulatoryExtraction, type RegulatoryDraft } from '@reg/llm';
import { createReviewDocument, type ReviewDocument } from '../src/index.js';

// Invented technical example, not a legal interpretation or approved regulatory rule.
export function testExtraction() {
  const snapshot = createSourceSnapshot({ sourceTitle: 'Синтетический пример для тестов', officialUrl: 'https://example.test/review', sourceTextOrigin: 'synthetic',
    sourceText: 'Тестовый пример, не норма права. Этапы: 01.09.2026, 01.09.2027, 01.09.2028. Конец примера: 01.09.2029. Выручка компании должна превышать порог 120, 30 или 20 соответственно; требуется договор приёма платежей. Исключение: исключённый товар. Действие: подготовить приём платежей к началу соответствующего этапа.' });
  const draft: RegulatoryDraft = { title: snapshot.sourceTitle, summary: 'Технический пример', uncertaintyNotes: [],
    dateNotes: [{ date: '2029-09-01', reason: 'Конец тестового примера.', sourceSegmentIndexes: [0] }],
    phases: [2026, 2027, 2028].map((year, i) => ({ title: `Тестовый этап ${year}`, subjectRole: 'Компания',
      validFrom: { date: `${year}-09-01`, sourceSegmentIndexes: [0] }, validTo: { date: null, sourceSegmentIndexes: [] }, sourceSegmentIndexes: [0],
      conditions: [
        { fieldHint: 'revenuePreviousYear', operatorHint: 'gt', valueHint: [120, 30, 20][i]!, text: 'Выручка превышает порог.', sourceSegmentIndexes: [0] },
        { fieldHint: 'hasEpaymentAcceptanceAgreementAsOf2026_01_01', operatorHint: 'eq', valueHint: true, text: 'Требуется договор.', sourceSegmentIndexes: [0] },
      ], exceptions: [{ text: 'Исключённый товар.', sourceSegmentIndexes: [0] }], affectedProcesses: ['Приём платежей'], uncertaintyNotes: [],
      actionDrafts: [{ title: 'Подготовить приём', description: 'Тестовое действие.', deadline: { kind: 'phase_start' }, sourceSegmentIndexes: [0] }],
    })) };
  return validateRegulatoryExtraction(materializeExtraction(draft, snapshot));
}

export function completeTestReview(document: ReviewDocument): ReviewDocument {
  const doc = structuredClone(document);
  doc.sourceReview = { confirmed: true, note: 'Проверка синтетического примера; не правовое заключение.' };
  doc.resolutions.forEach((r) => { r.resolved = true; r.note = 'Дата используется в граничных тестах.'; });
  doc.phases.forEach((p) => {
    p.decision = 'include'; p.reason = 'Включить тестовый этап.';
    p.category = 'payments'; p.scope = 'company'; p.conditionJoin = 'and';
    p.endReason = 'Окончание этапа в этом тестовом варианте не задано.';
    p.conditions.forEach((c) => { c.decision = 'include'; c.reason = 'Тестовое условие подтверждено.'; });
    p.exceptions.forEach((c) => { c.decision = 'include'; c.reason = 'Тестовое исключение подтверждено.';
      c.expression = { op: 'eq', field: 'isExcludedProduct', value: true, scope: 'company', sourceSegmentIndexes: [0] }; });
    p.actions.forEach((a) => { a.decision = 'include'; a.reason = 'Тестовое действие подтверждено.'; });
    p.questionMap = { revenuePreviousYear: 'Какова выручка?', hasEpaymentAcceptanceAgreementAsOf2026_01_01: 'Есть договор?', isExcludedProduct: 'Товар исключён?' };
  });
  return doc;
}
export function readyTestDocument() { return completeTestReview(createReviewDocument(testExtraction())); }
