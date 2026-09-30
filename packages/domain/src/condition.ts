import type { Condition, ConditionResult, Tri } from './schemas.js';

const UNKNOWN = Symbol('UNKNOWN');
type UnknownValue = typeof UNKNOWN;

function getPath(input: unknown, path: string): unknown | UnknownValue {
  const parts = path.split('.');
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return UNKNOWN;
    if (['__proto__', 'prototype', 'constructor'].includes(part) || !Object.hasOwn(current, part)) return UNKNOWN;
    current = (current as Record<string, unknown>)[part];
  }
  return current === null || current === undefined ? UNKNOWN : current;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function result(value: Tri, field: string | null, reason: string): ConditionResult {
  return {
    value,
    missingFields: value === 'unknown' && field ? [field] : [],
    reasons: [reason],
  };
}

function comparable(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string';
}

function compare(left: number | string, right: number | string): number | null {
  if (typeof left !== typeof right) return null;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function evaluateCondition(condition: Condition, input: unknown): ConditionResult {
  switch (condition.op) {
    case 'and': {
      const evaluated: ConditionResult[] = [];
      for (const child of condition.conditions) {
        const childResult = evaluateCondition(child, input);
        evaluated.push(childResult);
        if (childResult.value === 'false') {
          return {
            value: 'false',
            missingFields: [],
            reasons: evaluated.flatMap((item) => item.reasons),
          };
        }
      }
      const unknowns = evaluated.filter((item) => item.value === 'unknown');
      if (unknowns.length > 0) {
        return {
          value: 'unknown',
          missingFields: uniq(unknowns.flatMap((item) => item.missingFields)),
          reasons: evaluated.flatMap((item) => item.reasons),
        };
      }
      return { value: 'true', missingFields: [], reasons: evaluated.flatMap((item) => item.reasons) };
    }

    case 'or': {
      const evaluated: ConditionResult[] = [];
      for (const child of condition.conditions) {
        const childResult = evaluateCondition(child, input);
        evaluated.push(childResult);
        if (childResult.value === 'true') {
          return {
            value: 'true',
            missingFields: [],
            reasons: evaluated.flatMap((item) => item.reasons),
          };
        }
      }
      const unknowns = evaluated.filter((item) => item.value === 'unknown');
      if (unknowns.length > 0) {
        return {
          value: 'unknown',
          missingFields: uniq(unknowns.flatMap((item) => item.missingFields)),
          reasons: evaluated.flatMap((item) => item.reasons),
        };
      }
      return { value: 'false', missingFields: [], reasons: evaluated.flatMap((item) => item.reasons) };
    }

    case 'not': {
      const child = evaluateCondition(condition.condition, input);
      const value: Tri = child.value === 'true' ? 'false' : child.value === 'false' ? 'true' : 'unknown';
      return { ...child, value, reasons: child.reasons.map((reason) => `NOT (${reason})`) };
    }

    case 'exists': {
      const value = getPath(input, condition.field);
      return result(value === UNKNOWN ? 'false' : 'true', null, `${condition.field} exists = ${value === UNKNOWN ? 'false' : 'true'}`);
    }

    case 'known': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      return result('true', null, `${condition.field} is known`);
    }

    case 'is_empty': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      if (Array.isArray(value)) return result(value.length === 0 ? 'true' : 'false', null, `${condition.field} empty = ${value.length === 0}`);
      if (typeof value === 'string') return result(value.length === 0 ? 'true' : 'false', null, `${condition.field} empty = ${value.length === 0}`);
      return result('false', null, `${condition.field} is not an emptyable value`);
    }

    case 'eq':
    case 'neq': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      const equal = Object.is(value, condition.value);
      const matches = condition.op === 'eq' ? equal : !equal;
      return result(matches ? 'true' : 'false', null, `${condition.field} ${condition.op} ${JSON.stringify(condition.value)} = ${matches}`);
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      if (!comparable(value)) return result('false', null, `${condition.field} is not comparable`);
      const ordering = compare(value, condition.value);
      if (ordering === null) return result('false', null, `${condition.field} type mismatch`);
      const matches = condition.op === 'gt'
        ? ordering > 0
        : condition.op === 'gte'
          ? ordering >= 0
          : condition.op === 'lt'
            ? ordering < 0
            : ordering <= 0;
      return result(matches ? 'true' : 'false', null, `${condition.field} ${condition.op} ${condition.value} = ${matches}`);
    }

    case 'in': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      const matches = condition.values.some((candidate) => Object.is(candidate, value));
      return result(matches ? 'true' : 'false', null, `${condition.field} in values = ${matches}`);
    }

    case 'contains_any':
    case 'contains_all': {
      const value = getPath(input, condition.field);
      if (value === UNKNOWN) return result('unknown', condition.field, `${condition.field} is unknown`);
      if (!Array.isArray(value)) return result('false', null, `${condition.field} is not an array`);
      const matches = condition.op === 'contains_any'
        ? condition.values.some((candidate) => value.some((item) => Object.is(item, candidate)))
        : condition.values.every((candidate) => value.some((item) => Object.is(item, candidate)));
      return result(matches ? 'true' : 'false', null, `${condition.field} ${condition.op} = ${matches}`);
    }
  }
}
