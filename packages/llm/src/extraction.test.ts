import { describe, expect, it, vi } from 'vitest';
import { createSourceSnapshot, datesInText, extractionJsonSchema, extractRegulatoryDraft, regulatoryExtractionQualityIssues, resolveDraftDeadline, segmentSourceText, validateRegulatoryExtraction, type RegulatoryDraft } from './index.js';

const sourceText = 'С 1 сентября 2026 года обязанность для продавцов с выручкой свыше 120 млн рублей.\nС 1 сентября 2027 года порог составляет 30 млн рублей.\nС 1 сентября 2028 года порог составляет 20 млн рублей.';
const input = { sourceTitle: 'Тестовые этапы', officialUrl: 'https://example.test/act', sourceText };
function draft(): RegulatoryDraft {
  return {
    title: 'Этапы', summary: 'Тест', dateNotes: [], uncertaintyNotes: [],
    phases: [2026, 2027, 2028].map((year, i) => ({
      title: `Этап ${year}`, subjectRole: 'Продавцы', validFrom: { date: `${year}-09-01`, sourceSegmentIndexes: [0] }, validTo: { date: null, sourceSegmentIndexes: [] }, sourceSegmentIndexes: [0],
      conditions: [{ fieldHint: 'revenuePreviousYear', operatorHint: 'gt', valueHint: [120e6, 30e6, 20e6][i]!, text: 'Выручка выше порога', sourceSegmentIndexes: [0] }],
      exceptions: [], affectedProcesses: [], actionDrafts: [], uncertaintyNotes: [],
    })),
  };
}
const provider = (value: unknown) => ({ name: 'test', model: 'test', generateJson: vi.fn().mockResolvedValue(value) });

describe('source-segment extraction', () => {
  it('preserves whitespace, Unicode and offsets across long chunks', () => {
    const text = '  Начало\r\n' + 'Абзац с текстом.\n'.repeat(300) + '😀'.repeat(800) + '\tКонец  ';
    const segments = segmentSourceText(text);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    for (const s of segments) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
      expect(s.text.length).toBeLessThanOrEqual(1000);
      expect(/[\uD800-\uDBFF]$/.test(s.text)).toBe(false);
    }
  });
  it('rejects empty and oversized sources before contacting the model', async () => {
    const p = provider(draft());
    await expect(extractRegulatoryDraft(p, { ...input, sourceText: ' \n' })).rejects.toThrow('SOURCE_TEXT_REQUIRED');
    await expect(extractRegulatoryDraft(p, { ...input, sourceText: 'x'.repeat(120001) })).rejects.toThrow('SOURCE_TEXT_TOO_LONG');
    expect(p.generateJson).not.toHaveBeenCalled();
  });
  it('keeps all three phases and materializes exact server-owned evidence', async () => {
    const result = await extractRegulatoryDraft(provider(draft()), input);
    expect(result.phases.map((p) => p.validFrom.date)).toEqual(['2026-09-01', '2027-09-01', '2028-09-01']);
    expect(result.evidence).toEqual([{ index: 0, sourceSegmentIndex: 0, quote: sourceText }]);
    expect(validateRegulatoryExtraction(result)).toEqual(result);
    const reordered = structuredClone(result);
    reordered.evidence = reordered.evidence.map(({ index, sourceSegmentIndex, quote }) => ({ quote, index, sourceSegmentIndex }));
    expect(validateRegulatoryExtraction(reordered)).toEqual(result);
  });
  it('rejects caller changes to quote, snapshot text, or segment offsets', async () => {
    const result = await extractRegulatoryDraft(provider(draft()), input);
    const quote = structuredClone(result); quote.evidence[0]!.quote = 'Подмена';
    expect(() => validateRegulatoryExtraction(quote)).toThrow('SERVER_EVIDENCE_MISMATCH');
    const text = structuredClone(result); text.sourceSnapshot.sourceText += 'Подмена';
    expect(() => validateRegulatoryExtraction(text)).toThrow('SOURCE_SNAPSHOT_HASH_MISMATCH');
    const offset = structuredClone(result); offset.sourceSnapshot.segments[0]!.start = 1;
    expect(() => validateRegulatoryExtraction(offset)).toThrow('SOURCE_SNAPSHOT_SEGMENTS_MISMATCH');
  });
  it('repairs schema failures and never accepts model-supplied quotes', async () => {
    const invalid = { ...draft(), evidence: [{ index: 0, quote: 'Подмена' }] };
    const p = provider(invalid); p.generateJson.mockResolvedValueOnce(invalid).mockResolvedValueOnce(draft());
    const result = await extractRegulatoryDraft(p, input);
    expect(p.generateJson).toHaveBeenCalledTimes(2);
    expect(result.evidence[0]!.quote).toBe(sourceText);
    expect(JSON.parse(p.generateJson.mock.calls[1]![0].user).qualityIssues.join(' ')).toContain('evidence');
  });
  it('repairs missing source references exactly once', async () => {
    const bad = draft(); bad.phases[0]!.conditions[0]!.sourceSegmentIndexes = [900];
    const p = provider(bad); p.generateJson.mockResolvedValueOnce(bad).mockResolvedValueOnce(draft());
    await expect(extractRegulatoryDraft(p, input)).resolves.toHaveProperty('schemaVersion');
    expect(p.generateJson).toHaveBeenCalledTimes(2);
  });
  it('fails closed after a second invalid response', async () => {
    const bad = draft(); bad.phases[0]!.conditions[0]!.sourceSegmentIndexes = [];
    const p = provider(bad);
    await expect(extractRegulatoryDraft(p, input)).rejects.toThrow('EXTRACTION_QUALITY_GATE_FAILED');
    expect(p.generateJson).toHaveBeenCalledTimes(2);
  });
  it('repairs malformed JSON but propagates transport errors', async () => {
    const p = provider(draft()); p.generateJson.mockRejectedValueOnce(new SyntaxError('bad JSON'));
    await expect(extractRegulatoryDraft(p, input)).resolves.toHaveProperty('phases');
    expect(p.generateJson).toHaveBeenCalledTimes(2);
    const network = provider(draft()); network.generateJson.mockRejectedValue(new Error('OAuth failed'));
    await expect(extractRegulatoryDraft(network, input)).rejects.toThrow('OAuth failed');
    expect(network.generateJson).toHaveBeenCalledTimes(1);
  });
  it('does not silently lose a later dated phase', async () => {
    const bad = draft(); bad.phases.pop();
    await expect(extractRegulatoryDraft(provider(bad), input)).rejects.toThrow('2028-09-01 is unrepresented');
  });
  it('recognizes dates in supported Russian and numeric formats', () => {
    expect(datesInText('1 сентября 2026 года; 01.09.2027; 2028-09-01; 31.02.2026')).toEqual(['2026-09-01', '2027-09-01', '2028-09-01']);
  });
  it('specializes the provider date schema per source without leaking dates between extractions', () => {
    const schema = JSON.stringify(extractionJsonSchema(createSourceSnapshot(input)));
    const other = JSON.stringify(extractionJsonSchema(createSourceSnapshot({ ...input, sourceText: 'Дата 01.01.2030.' })));
    expect(schema).toContain('2028-09-01');
    expect(schema).not.toContain('2030-01-01');
    expect(other).toContain('2030-01-01');
    expect(other).not.toContain('2028-09-01');
  });
  it('rejects invented and impossible dates', async () => {
    const bad = draft(); bad.phases[0]!.validFrom.date = '2026-09-02';
    await expect(extractRegulatoryDraft(provider(bad), input)).rejects.toThrow('not explicit in cited source segments');
    bad.phases[0]!.validFrom.date = '2026-02-31';
    await expect(extractRegulatoryDraft(provider(bad), input)).rejects.toThrow('actual calendar date');
  });
  it('rejects operator text as a deadline', async () => {
    const bad = draft();
    bad.phases[0]!.actionDrafts.push({ title: 'Действие', description: 'Описание', sourceSegmentIndexes: [0], deadline: { kind: 'fixed', date: 'date_eq', sourceSegmentIndexes: [0] } });
    await expect(extractRegulatoryDraft(provider(bad), input)).rejects.toThrow('actual calendar date');
  });
  it('derives a preparation deadline from the grounded phase instead of accepting model-owned date copies', async () => {
    const raw = draft();
    raw.phases[0]!.actionDrafts.push({ title: 'Подготовка', description: 'Подготовиться к началу этапа', sourceSegmentIndexes: [0], deadline: { kind: 'phase_start' } });
    const result = await extractRegulatoryDraft(provider(raw), input);
    const phase = result.phases[0]!;
    expect(resolveDraftDeadline(phase, phase.actionDrafts[0]!)).toEqual({ date: '2026-09-01', sourceSegmentIndexes: [0], origin: 'derived-from-phase' });
    raw.phases[0]!.validFrom = { date: null, sourceSegmentIndexes: [] };
    await expect(extractRegulatoryDraft(provider(raw), input)).rejects.toThrow('phase_start requires a grounded phase');
  });
  it.each([
    ['boolean with a number', 'distanceSales', 'eq', 1], ['numeric comparison on boolean', 'distanceSales', 'gt', 10],
    ['in with scalar', 'taxRegime', 'in', 'USN'], ['unknown field', 'inventedField', 'eq', true], ['invalid enum', 'legalForm', 'eq', 'UNSUPPORTED'],
  ])('rejects incompatible condition: %s', (_label, fieldHint, operatorHint, valueHint) => {
    const bad = draft(); Object.assign(bad.phases[0]!.conditions[0]!, { fieldHint, operatorHint, valueHint });
    expect(regulatoryExtractionQualityIssues(bad, createSourceSnapshot(input)).some((issue) => issue.includes('conditions[0]'))).toBe(true);
  });
  it('retains an unmappable condition for human review', async () => {
    const unresolved = draft();
    Object.assign(unresolved.phases[0]!.conditions[0]!, { fieldHint: null, operatorHint: 'other', valueHint: null });
    unresolved.phases[0]!.uncertaintyNotes = ['В профиле нет нужного признака.'];
    await expect(extractRegulatoryDraft(provider(unresolved), input)).resolves.toHaveProperty('phases');
  });
  it('only accepts exact relative deadline phrases', async () => {
    const extra = ' Заявление подаётся в течение 10 дней после регистрации.';
    const relative = draft();
    relative.phases[0]!.actionDrafts = [{ title: 'Заявление', description: 'Подать', sourceSegmentIndexes: [0], deadline: { kind: 'relative', description: 'в течение 10 дней после регистрации', sourceSegmentIndexes: [0] } }];
    await expect(extractRegulatoryDraft(provider(relative), { ...input, sourceText: sourceText + extra })).resolves.toHaveProperty('phases');
    const deadline = relative.phases[0]!.actionDrafts[0]!.deadline; if (deadline.kind === 'relative') deadline.description = 'в течение 5 дней';
    await expect(extractRegulatoryDraft(provider(relative), { ...input, sourceText: sourceText + extra })).rejects.toThrow('verbatim description');
  });
});
