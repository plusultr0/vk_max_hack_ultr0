import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractRegulatoryDraft, GigaChatProvider, MockLlmProvider, createSourceSnapshot, regulatoryExtractionQualityIssues } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM adapter', () => {
  it('validates deterministic mock output', async () => {
    const result = await extractRegulatoryDraft(new MockLlmProvider(), {
      sourceTitle: 'Тестовый акт',
      officialUrl: 'https://example.test/act',
      sourceText: 'Официальный тестовый фрагмент.',
    });
    expect(result.title).toBe('Тестовый акт');
    expect(result.uncertaintyNotes.length).toBeGreaterThan(0);
  });

  it('uses GigaChat OAuth and json_schema structured output', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token', expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          title: 'Требование',
          summary: 'Кратко',
          phases: [],
          dateNotes: [],
          uncertaintyNotes: ['Недостаточно данных.'],
        }) } }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GigaChatProvider({ authKey: 'abc', model: 'GigaChat-2-Pro' });
    const result = await extractRegulatoryDraft(provider, {
      sourceTitle: 'Тест',
      officialUrl: 'https://example.test/source',
      sourceText: 'Организации обязаны разместить на сайте сведения о продавце.',
    });

    expect(result.schemaVersion).toBe('reg-extract-v4-source-segments');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const oauthInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((oauthInit.headers as Record<string, string>).Authorization).toBe('Basic abc');
    const chatInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const chatBody = JSON.parse(String(chatInit.body));
    expect(chatBody.response_format.type).toBe('json_schema');
    expect(chatBody.response_format.strict).toBe(true);
    expect(chatBody.response_format.schema.properties.evidence).toBeUndefined();
    expect(chatBody.response_format.schema.properties.phases).toBeDefined();
  });

  it('reuses a non-expired GigaChat token', async () => {
    const payload = {
      title: 'Тест', summary: 'Тест', subjectRole: null, validFrom: null, validTo: null,
      conditions: [], exceptions: [], affectedProcesses: [], actionDrafts: [], uncertaintyNotes: [], evidence: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token', expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GigaChatProvider({ authKey: 'abc' });
    await provider.generateJson({ system: 's', user: 'u' });
    await provider.generateJson({ system: 's', user: 'u' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an empty extraction without an explanation', () => {
    const issues = regulatoryExtractionQualityIssues({ title: 'Тест', summary: 'Тест', phases: [], dateNotes: [], uncertaintyNotes: [] }, createSourceSnapshot({ sourceTitle: 'Тест', officialUrl: 'https://example.test', sourceText: 'Текст' }));
    expect(issues).toContain('Empty extraction requires uncertaintyNotes');
  });
});