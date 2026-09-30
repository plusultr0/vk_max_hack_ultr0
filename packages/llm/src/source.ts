import { SEGMENTATION_VERSION, MAX_SOURCE_LENGTH, sourceTextHash, segmentSourceText, isCalendarDate } from './source-segments.js';
export { SEGMENTATION_VERSION, MAX_SOURCE_LENGTH, sourceTextHash, segmentSourceText, isCalendarDate, datesInText, sourceDateMentions } from './source-segments.js';
import { z } from 'zod';

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
  // Optional for old immutable snapshots. Captured by the server, never the LLM.
  sourceMetadata: z.object({
    number:z.string().nullable(),issuer:z.string().nullable(),
    publicationDate:z.string().refine(isCalendarDate).nullable(),
  }).strict().optional(),
}).strict();
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type LlmSourceInput = {
  sourceTitle: string;
  officialUrl: string;
  sourceText: string;
  sourceTextOrigin?: z.infer<typeof SourceOriginSchema>;
  sourceRetrievedAt?: string | null;
  sourceMetadata?: {number:string|null;issuer:string|null;publicationDate:string|null};
};

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
    ...(input.sourceMetadata ? {sourceMetadata:input.sourceMetadata}:{}),
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

