export type { ReviewDocument, ReviewPhase, ReviewExpression, ReviewIssue } from '../../../../packages/review/src/schema.js';
export type { ReviewCompilation } from '../../../../packages/review/src/compiler.js';
import type { ReviewDocument } from '../../../../packages/review/src/schema.js';
import type { ReviewCompilation } from '../../../../packages/review/src/compiler.js';
import type { RegulatoryExtraction, SourceSnapshot } from '../../../../packages/llm/src/index.js';

export type Field = { name: string; label: string; type: string; scope: 'company' | 'trade_object'; allowedValues: string[] | null; operators: string[] };
export type Candidate = { id: string; source_title: string; review_state: string; created_at: string; provider: string; model: string | null;
  source_snapshot?: SourceSnapshot | null; draft: Omit<RegulatoryExtraction, 'sourceSnapshot'>; review_warnings?: Array<{ code: string; message: string }>;
  automation_state?:string; automation_issues?:string[];
  review_requirements?: Array<{ key: string; message: string }> };
export type Review = { candidateId: string; revision: number; state: 'draft' | 'ready'; document: ReviewDocument; contentHash: string;
  compilation: ReviewCompilation; actorId: string; reason: string; createdAt: string };
export type HistoryItem = { revision: number; state: string; actor_id: string; reason: string; created_at: string; content_hash: string };
export type Preview = { revision: number; asOf: string; hypothetical: boolean; items: Array<{ phaseId: string; ruleId: string; scope: string; timeState: string;
  contextRequired: boolean; evaluation: { verdict: string; missingFields: string[]; effectiveFrom: string | null; reasons: string[];
    actions: Array<{ actionKey: string; title: string; deadline: string | null }> } | null }> };
