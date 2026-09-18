import type { ReviewDocument, ReviewExpression } from './types.js';

export function expressionFields(expression: ReviewExpression | null): string[] {
  if (!expression) return [];
  if ('conditions' in expression) return expression.conditions.flatMap(expressionFields);
  if ('condition' in expression) return expressionFields(expression.condition);
  return [expression.field];
}
export function documentChanges(before: unknown, after: unknown, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => documentChanges(a[key], b[key], path ? `${path}.${key}` : key));
  }
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((v) => v && typeof v === 'object' && typeof v.id === 'string')) {
    const a = new Map(before.map((v) => [v.id, v])), b = new Map(after.map((v) => [v.id, v]));
    const changes = [...new Set([...a.keys(), ...b.keys()])].flatMap((id) => documentChanges(a.get(id), b.get(id), `${path}[${id.slice(0, 8)}]`));
    if (JSON.stringify([...a.keys()]) !== JSON.stringify([...b.keys()])) changes.push({ path: `${path}.порядок`, before: [...a.keys()], after: [...b.keys()] });
    return changes;
  }
  return [{ path, before, after }];
}
export function newPhase(): ReviewDocument['phases'][number] {
  const id = crypto.randomUUID();
  return { id, originIndex: null, ruleId: `review-rule-${id}`, version: 1, decision: 'unresolved', reason: null,
    sourceSegmentIndexes: [], title: 'Новый этап', userTitle: 'Новый этап', summary: 'Уточните требование', subjectRole: null,
    category: null, scope: null, validFrom: { date: null, sourceSegmentIndexes: [] }, validTo: { date: null, sourceSegmentIndexes: [] },
    endReason: null, conditionJoin: null, conditions: [], exceptions: [], actions: [], questionMap: {} };
}
