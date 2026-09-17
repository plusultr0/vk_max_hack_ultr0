import { describe, expect, it } from 'vitest';
import {
  fetchOfficialHtmlSource,
  fetchPravoOpenData,
  htmlToText,
  makeManualOfficialDocument,
  parseCsv,
  resolveCsvUrl,
  scorePilotRelevance,
  SourceDocumentSchema,
} from './index.js';

describe('ingestion CSV', () => {
  it('parses semicolon CSV and quoted values', () => {
    const rows = parseCsv('id;title;url\n1;"Закон; о торговле";https://example.test/1\n');
    expect(rows).toEqual([{ id: '1', title: 'Закон; о торговле', url: 'https://example.test/1' }]);
  });

  it('resolves a CSV link from a landing page', async () => {
    const fakeFetch = async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://publication.pravo.gov.ru/open-data');
      return new Response('<a href="/data/legal.csv">CSV</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    await expect(resolveCsvUrl({ openDataUrl: 'https://publication.pravo.gov.ru/open-data', fetchImpl: fakeFetch as typeof fetch }))
      .resolves.toBe('https://publication.pravo.gov.ru/data/legal.csv');
  });

  it('normalizes a minimal official dataset row', async () => {
    const landing = 'https://publication.pravo.gov.ru/open-data';
    const csv = 'https://publication.pravo.gov.ru/data/legal.csv';
    const fakeFetch = async (url: string | URL | Request) => {
      if (String(url) === landing) {
        return new Response(`<a href="${csv}">CSV</a>`, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('id;Наименование документа;Ссылка;Дата публикации\n42;Постановление о розничной торговле;/document/42;16.09.2026\n', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    };
    const result = await fetchPravoOpenData({ openDataUrl: landing, fetchImpl: fakeFetch as typeof fetch });
    expect(result.rawCount).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(SourceDocumentSchema.parse(result.documents[0]).publicationDate).toBe('2026-09-16');
    expect(result.documents[0]!.officialUrl).toBe('https://publication.pravo.gov.ru/document/42');
  });
});

describe('official HTML fallbacks', () => {
  it('rejects oversized official text rather than silently dropping the end', async () => {
    const text = 'x'.repeat(120001);
    const fakeFetch = async () => new Response(`<html><body>${text}</body></html>`, { headers: { 'content-type': 'text/html' } });
    await expect(fetchOfficialHtmlSource({ source: 'test', url: 'https://example.test', issuer: 'Test', mode: 'page', fetchImpl: fakeFetch as typeof fetch })).rejects.toThrow('SOURCE_TEXT_TOO_LONG');
    expect(() => makeManualOfficialDocument({ title: 'Test', officialUrl: 'https://example.test', sourceText: text })).toThrow('SOURCE_TEXT_TOO_LONG');
  });
  it('extracts matching government document links and ignores navigation', async () => {
    const fakeFetch = async () => new Response(`
      <html><body>
        <a href="/about/">О Правительстве Российской Федерации</a>
        <a href="/docs/all/163178/">Постановление Правительства Российской Федерации от 30.03.2026 № 341 о торговле товарами</a>
      </body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const result = await fetchOfficialHtmlSource({
      source: 'government.ru',
      url: 'https://government.ru/docs/all/',
      issuer: 'Правительство Российской Федерации',
      mode: 'links',
      includeHref: /\/docs\/(?:all\/)?\d+\/?$/i,
      fetchImpl: fakeFetch as typeof fetch,
    });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.officialUrl).toBe('https://government.ru/docs/all/163178/');
    expect(result.documents[0]!.source).toBe('government.ru');
  });

  it('stages a regulator page with readable text', async () => {
    const fakeFetch = async () => new Response('<html><head><title>Налоги 2026</title></head><body><h1>НДС для УСН</h1><p>Изменения налогового законодательства для организаций.</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const result = await fetchOfficialHtmlSource({
      source: 'nalog.gov.ru',
      url: 'https://www.nalog.gov.ru/new2026/',
      issuer: 'ФНС России',
      mode: 'page',
      fetchImpl: fakeFetch as typeof fetch,
    });
    expect(result.documents).toHaveLength(1);
    expect(String(result.documents[0]!.raw.text)).toContain('НДС для УСН');
    expect(scorePilotRelevance(result.documents[0]!).score).toBeGreaterThan(0);
  });

  it('converts HTML to readable compact text', () => {
    expect(htmlToText('<style>x{}</style><p>НДС&nbsp;для <b>УСН</b></p>')).toBe('НДС для УСН');
  });

  it('creates manual official fallback documents without losing provenance', () => {
    const doc = makeManualOfficialDocument({
      title: 'Разъяснение ФНС по НДС',
      officialUrl: 'https://www.nalog.gov.ru/example/',
      issuer: 'ФНС России',
      sourceText: 'Организации на УСН обязаны учитывать соответствующие требования по НДС при выполнении установленных условий.',
    });
    expect(doc.source).toBe('manual.www.nalog.gov.ru');
    expect(doc.raw.sourceKind).toBe('manual-official');
  });
});

describe('pilot relevance', () => {
  it('scores e-commerce related legal metadata above unrelated metadata', () => {
    const base = {
      source: 'publication.pravo.gov.ru',
      externalId: '1',
      number: null,
      issuer: 'Правительство РФ',
      publicationDate: '2026-09-16',
      officialUrl: 'https://publication.pravo.gov.ru/document/1',
      sourceDatasetUrl: 'https://publication.pravo.gov.ru/data.csv',
      rawHash: 'x',
      raw: {},
    };
    const relevant = scorePilotRelevance(SourceDocumentSchema.parse({ ...base, title: 'Правила дистанционной розничной торговли и платежей' }));
    const unrelated = scorePilotRelevance(SourceDocumentSchema.parse({ ...base, externalId: '2', title: 'Положение о лесоустройстве' }));
    expect(relevant.score).toBeGreaterThan(unrelated.score);
    expect(relevant.matchedTerms.length).toBeGreaterThan(0);
  });
});
