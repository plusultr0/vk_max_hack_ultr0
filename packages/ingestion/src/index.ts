import { normalizeDate, decodeHtml, htmlToText, parseCsv } from './text.js';
export { htmlToText, parseCsv } from './text.js';
import { fetchWithRetry, responseText, type FetchOptions } from './transport.js';
import { pdfText } from './pdf-text.js';
export { extractionErrorCode } from './transport.js';
export type { FetchOptions } from './transport.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_OFFICIAL_TEXT_LENGTH = 120_000;
function requireCompleteText(text: string): string {
  if (text.length > MAX_OFFICIAL_TEXT_LENGTH) throw new Error('SOURCE_TEXT_TOO_LONG: split the official document explicitly; text must not be silently truncated');
  return text;
}

export const SourceDocumentSchema = z.object({
  source: z.string().min(1),
  externalId: z.string(),
  title: z.string(),
  number: z.string().nullable(),
  issuer: z.string().nullable(),
  publicationDate: z.string().nullable(),
  officialUrl: z.string().url(),
  sourceDatasetUrl: z.string().url(),
  rawHash: z.string(),
  raw: z.record(z.unknown()),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export type OfficialHtmlSource = {
  source: string;
  url: string;
  issuer: string;
  mode: 'links' | 'page';
  title?: string;
  includeHref?: RegExp;
  maxDocuments?: number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

function findColumn(row: Record<string, string>, candidates: string[]): string | null {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const candidate of candidates) {
    const found = normalized.get(normalizeHeader(candidate));
    if (found !== undefined && found !== '') return found;
  }
  return null;
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]!) : null;
}

function dateFromText(value: string): string | null {
  const ru = value.match(/\b(\d{2})[.\/-](\d{2})[.\/-](\d{4})\b/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  return null;
}

function numberFromText(value: string): string | null {
  const match = value.match(/(?:№|N)\s*([A-ZА-Я0-9@./-]{1,40})/iu);
  return match?.[1] ?? null;
}

export async function resolveCsvUrl(input: {
  openDataUrl: string;
} & FetchOptions): Promise<string> {
  const response = await fetchWithRetry(input.openDataUrl, input);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/csv') || input.openDataUrl.toLowerCase().endsWith('.csv')) return input.openDataUrl;
  const html = await responseText(response);
  const matches = [...html.matchAll(/href=["']([^"']+\.csv(?:\?[^"']*)?)["']/gi)];
  if (matches.length === 0) throw new Error('CSV link was not found on the official open-data page');
  return new URL(matches[0]![1]!, input.openDataUrl).toString();
}

export async function fetchPravoOpenData(input: {
  openDataUrl: string;
} & FetchOptions): Promise<{ datasetUrl: string; documents: SourceDocument[]; rawCount: number }> {
  const datasetUrl = await resolveCsvUrl(input);
  const response = await fetchWithRetry(datasetUrl, input);
  const text = await responseText(response);
  const rows = parseCsv(text);
  const documents = rows.flatMap((row, index) => {
    const title = findColumn(row, ['name', 'title', 'documentname', 'Наименование документа', 'Название']) ?? '';
    const officialUrlRaw = findColumn(row, ['url', 'link', 'documenturl', 'Ссылка', 'Адрес страницы']);
    if (!title || !officialUrlRaw) return [];
    let officialUrl: string;
    try {
      officialUrl = new URL(officialUrlRaw, 'https://publication.pravo.gov.ru/').toString();
    } catch {
      return [];
    }
    const externalId = findColumn(row, ['id', 'documentid', 'eoNumber', 'Номер опубликования']) ?? sha256(`${title}|${officialUrl}|${index}`).slice(0, 24);
    const number = findColumn(row, ['number', 'documentnumber', 'Номер документа']);
    const issuer = findColumn(row, ['issuer', 'authority', 'Орган', 'Принявший орган']);
    const publicationDate = normalizeDate(findColumn(row, ['publicationdate', 'publishdate', 'Дата опубликования', 'Дата публикации']));
    const canonical = JSON.stringify(row, Object.keys(row).sort());
    return [SourceDocumentSchema.parse({
      source: 'publication.pravo.gov.ru',
      externalId,
      title,
      number,
      issuer,
      publicationDate,
      officialUrl,
      sourceDatasetUrl: datasetUrl,
      rawHash: sha256(canonical),
      raw: { ...row, sourceKind: 'official-publication' },
    })];
  });
  return { datasetUrl, documents, rawCount: rows.length };
}

function shouldKeepAnchor(source: OfficialHtmlSource, href: string, title: string): boolean {
  if (title.length < 18) return false;
  if (/^(войти|поиск|меню|главная|подробнее|показать еще|архив)$/iu.test(title)) return false;
  if (source.includeHref && !source.includeHref.test(href)) return false;
  return true;
}

export async function fetchOfficialHtmlSource(input: OfficialHtmlSource & FetchOptions): Promise<{
  datasetUrl: string;
  documents: SourceDocument[];
  rawCount: number;
}> {
  const response = await fetchWithRetry(input.url, input);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain') && contentType !== '') {
    throw new Error(`${input.source} returned unsupported content type: ${contentType}`);
  }
  const html = await responseText(response);
  const text = htmlToText(html);

  if (input.mode === 'page') {
    const title = input.title ?? pageTitle(html) ?? input.source;
    const document = SourceDocumentSchema.parse({
      source: input.source,
      externalId: sha256(`${input.source}|${input.url}`).slice(0, 24),
      title,
      number: null,
      issuer: input.issuer,
      publicationDate: null,
      officialUrl: input.url,
      sourceDatasetUrl: input.url,
      rawHash: sha256(text),
      raw: {
        sourceKind: 'official-regulator-page',
        text: requireCompleteText(text),
      },
    });
    return { datasetUrl: input.url, documents: [document], rawCount: 1 };
  }

  const documents: SourceDocument[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const href = decodeHtml(match[1]!).trim();
    const title = htmlToText(match[2]!);
    if (!href || !title) continue;
    let officialUrl: string;
    try {
      officialUrl = new URL(href, input.url).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(officialUrl) || !shouldKeepAnchor(input, officialUrl, title) || seen.has(officialUrl)) continue;
    seen.add(officialUrl);
    documents.push(SourceDocumentSchema.parse({
      source: input.source,
      externalId: sha256(`${input.source}|${officialUrl}`).slice(0, 24),
      title,
      number: numberFromText(title),
      issuer: input.issuer,
      publicationDate: null, // Act date in a title is NOT its publication date.
      officialUrl,
      sourceDatasetUrl: input.url,
      rawHash: sha256(`${title}|${officialUrl}`),
      raw: {
        sourceKind: 'official-html-index',
        anchorText: title,
        sourcePageUrl: input.url,
        actDateFromTitle: dateFromText(title),
      },
    }));
    if (documents.length >= (input.maxDocuments ?? 250)) break;
  }

  if (documents.length === 0) throw new Error(`${input.source}: no document links matched the configured parser`);
  return { datasetUrl: input.url, documents, rawCount: documents.length };
}

export async function fetchReadableOfficialText(input: { url: string } & FetchOptions): Promise<string> {
  const response = await fetchWithRetry(input.url, input);
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/pdf'))return pdfText(new Uint8Array(await response.arrayBuffer()));
  if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml+xml')) {
    throw new Error('SOURCE_UNSUPPORTED_CONTENT_TYPE');
  }
  const raw = await responseText(response);
  // Preserve plain text literally. HTML alone needs markup removal.
  const text = contentType.includes('text/plain') ? raw : htmlToText(raw);
  if (text.trim().length < 80) throw new Error('SOURCE_TEXT_REQUIRED');
  return requireCompleteText(text);
}

export function makeManualOfficialDocument(input: {
  title: string;
  officialUrl: string;
  issuer?: string | null;
  number?: string | null;
  publicationDate?: string | null;
  sourceText: string;
}): SourceDocument {
  const url = new URL(input.officialUrl);
  const text = input.sourceText.trim();
  if (text.length < 40) throw new Error('Manual official source text is too short');
  return SourceDocumentSchema.parse({
    source: `manual.${url.hostname}`,
    externalId: sha256(`${url.hostname}|${input.officialUrl}|${input.title}`).slice(0, 24),
    title: input.title.trim(),
    number: input.number?.trim() || null,
    issuer: input.issuer?.trim() || null,
    publicationDate: normalizeDate(input.publicationDate ?? null),
    officialUrl: input.officialUrl,
    sourceDatasetUrl: input.officialUrl,
    rawHash: sha256(text),
    raw: { sourceKind: 'manual-official', text: requireCompleteText(text) },
  });
}

const ECOMMERCE_TERMS = [
  'касс', 'ккт', 'налог', 'усн', 'ндс', 'маркиров', 'персональн', 'соглас', 'оператор',
  'потребител', 'рознич', 'дистанцион', 'электронн', 'цифров', 'платеж', 'торгов', 'товар',
  'интернет', 'маркетплейс', 'продавец', 'онлайн',
];

export function scorePilotRelevance(document: SourceDocument): { score: number; matchedTerms: string[] } {
  const rawText = typeof document.raw.text === 'string'
    ? document.raw.text.slice(0, 40_000)
    : typeof document.raw.anchorText === 'string'
      ? document.raw.anchorText
      : '';
  const haystack = `${document.title} ${document.issuer ?? ''} ${document.number ?? ''} ${rawText}`.toLowerCase();
  const matchedTerms = ECOMMERCE_TERMS.filter((term) => haystack.includes(term));
  return { score: Math.min(1, matchedTerms.length / 4), matchedTerms };
}
