import { createHash } from 'node:crypto';
import { z } from 'zod';

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

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  retries?: number;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, (options.retries ?? 1) + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': options.userAgent ?? 'max-regulatory-control/0.9' },
        signal: controller.signal,
      });
      if (response.ok) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(Math.min(1500, 250 * attempt));
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const ru = trimmed.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  const iso = trimmed.match(/^(\d{4})[.\/-](\d{2})[.\/-](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function findColumn(row: Record<string, string>, candidates: string[]): string | null {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const candidate of candidates) {
    const found = normalized.get(normalizeHeader(candidate));
    if (found !== undefined && found !== '') return found;
  }
  return null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]) : null;
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

export function parseCsv(text: string): Array<Record<string, string>> {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiters = [',', ';', '\t'] as const;
  const delimiter = delimiters.map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]?.d ?? ',';
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      currentRow.push(current);
      current = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      currentRow.push(current);
      if (currentRow.some((cell) => cell.trim() !== '')) rows.push(currentRow);
      currentRow = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length || currentRow.length) {
    currentRow.push(current);
    if (currentRow.some((cell) => cell.trim() !== '')) rows.push(currentRow);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((value, index) => value.trim() || `column_${index + 1}`);
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

export async function resolveCsvUrl(input: {
  openDataUrl: string;
} & FetchOptions): Promise<string> {
  const response = await fetchWithRetry(input.openDataUrl, input);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/csv') || input.openDataUrl.toLowerCase().endsWith('.csv')) return input.openDataUrl;
  const html = await response.text();
  const matches = [...html.matchAll(/href=["']([^"']+\.csv(?:\?[^"']*)?)["']/gi)];
  if (matches.length === 0) throw new Error('CSV link was not found on the official open-data page');
  return new URL(matches[0][1], input.openDataUrl).toString();
}

export async function fetchPravoOpenData(input: {
  openDataUrl: string;
} & FetchOptions): Promise<{ datasetUrl: string; documents: SourceDocument[]; rawCount: number }> {
  const datasetUrl = await resolveCsvUrl(input);
  const response = await fetchWithRetry(datasetUrl, input);
  const text = await response.text();
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
  const html = await response.text();
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
        text: text.slice(0, 120_000),
      },
    });
    return { datasetUrl: input.url, documents: [document], rawCount: 1 };
  }

  const documents: SourceDocument[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const href = decodeHtml(match[1]).trim();
    const title = htmlToText(match[2]);
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
      publicationDate: dateFromText(title),
      officialUrl,
      sourceDatasetUrl: input.url,
      rawHash: sha256(`${title}|${officialUrl}`),
      raw: {
        sourceKind: 'official-html-index',
        anchorText: title,
        sourcePageUrl: input.url,
      },
    }));
    if (documents.length >= (input.maxDocuments ?? 250)) break;
  }

  if (documents.length === 0) throw new Error(`${input.source}: no document links matched the configured parser`);
  return { datasetUrl: input.url, documents, rawCount: documents.length };
}

export async function fetchReadableOfficialText(input: { url: string } & FetchOptions): Promise<string> {
  const response = await fetchWithRetry(input.url, input);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error(`Automatic extraction supports HTML/text only; received ${contentType}`);
  }
  const text = htmlToText(await response.text());
  if (text.length < 80) throw new Error('Official page did not contain enough readable text');
  return text.slice(0, 120_000);
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
    raw: { sourceKind: 'manual-official', text: text.slice(0, 120_000) },
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
