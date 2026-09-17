import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SEGMENTATION_VERSION = 'exact-chunks-v1' as const;
export const MAX_SOURCE_LENGTH = 120_000;
export const SourceOriginSchema = z.enum(['request', 'staged-official-page', 'official-url-fetch', 'synthetic']);
export const SourceSegmentSchema = z.object({
  sourceSegmentIndex: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1),
}).strict();
export const SourceSnapshotSchema = z.object({
  sourceTitle: z.string().min(1),
  officialUrl: z.string().url(),
  origin: SourceOriginSchema,
  capturedAt: z.string().datetime(),
  sourceRetrievedAt: z.string().datetime().nullable(),
  sourceText: z.string().min(1).max(MAX_SOURCE_LENGTH),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
  segmentationVersion: z.literal(SEGMENTATION_VERSION),
  segments: z.array(SourceSegmentSchema).min(1),
}).strict();
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type LlmSourceInput = {
  sourceTitle: string;
  officialUrl: string;
  sourceText: string;
  sourceTextOrigin?: z.infer<typeof SourceOriginSchema>;
  sourceRetrievedAt?: string | null;
};

export function sourceTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Offsets are UTF-16 code units (String.slice), not bytes. No whitespace normalization.
export function segmentSourceText(sourceText: string): SourceSnapshot['segments'] {
  if (!sourceText.trim()) throw new Error('SOURCE_TEXT_REQUIRED');
  if (sourceText.length > MAX_SOURCE_LENGTH) throw new Error('SOURCE_TEXT_TOO_LONG');
  const segments: SourceSnapshot['segments'] = [];
  let start = 0;
  while (start < sourceText.length) {
    let end = Math.min(start + 1000, sourceText.length);
    if (end < sourceText.length) {
      const preferred = Math.max(sourceText.lastIndexOf('\n', end - 1), sourceText.lastIndexOf('. ', end - 2) + 1);
      const space = sourceText.lastIndexOf(' ', end - 1);
      if (preferred > start + 400) end = preferred + 1;
      else if (space > start + 400) end = space + 1;
      if (/[\uD800-\uDBFF]/.test(sourceText[end - 1]!)) end -= 1;
    }
    segments.push({ sourceSegmentIndex: segments.length, start, end, text: sourceText.slice(start, end) });
    start = end;
  }
  return segments;
}

export function createSourceSnapshot(input: LlmSourceInput): SourceSnapshot {
  return SourceSnapshotSchema.parse({
    sourceTitle: input.sourceTitle,
    officialUrl: input.officialUrl,
    origin: input.sourceTextOrigin ?? 'request',
    capturedAt: new Date().toISOString(),
    sourceRetrievedAt: input.sourceRetrievedAt ?? null,
    sourceText: input.sourceText,
    textHash: sourceTextHash(input.sourceText),
    segmentationVersion: SEGMENTATION_VERSION,
    segments: segmentSourceText(input.sourceText),
  });
}

export function validateSourceSnapshot(value: unknown): SourceSnapshot {
  const snapshot = SourceSnapshotSchema.parse(value);
  if (snapshot.textHash !== sourceTextHash(snapshot.sourceText)) throw new Error('SOURCE_SNAPSHOT_HASH_MISMATCH');
  if (JSON.stringify(snapshot.segments) !== JSON.stringify(segmentSourceText(snapshot.sourceText))) {
    throw new Error('SOURCE_SNAPSHOT_SEGMENTS_MISMATCH');
  }
  return snapshot;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function datesInText(text: string): string[] {
  const dates = new Set<string>();
  const add = (year: string, month: string, day: string) => {
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (isCalendarDate(date)) dates.add(date);
  };
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(match[1]!, match[2]!, match[3]!);
  for (const match of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)) add(match[3]!, match[2]!, match[1]!);
  for (const match of text.toLowerCase().matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${months.join('|')})\\s+(\\d{4})`, 'g'))) {
    add(match[3]!, String(months.indexOf(match[2]!) + 1), match[1]!);
  }
  return [...dates].sort();
}

export function sourceDateMentions(snapshot: SourceSnapshot) {
  // Scan the full text so dates crossing a segment boundary remain visible.
  return datesInText(snapshot.sourceText);
}
