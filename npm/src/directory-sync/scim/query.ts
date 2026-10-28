import { JacksonError } from '../../controller/error';

export type ListQuery = { filter?: unknown; count?: unknown; startIndex?: unknown };

// SCIM equality queries used by directory clients. Unsupported expressions
// must fail explicitly rather than silently searching a different attribute.
export function equalityFilters(filter: unknown, allowed: string[]) {
  if (filter === undefined) return [];
  const invalid = () => new JacksonError('Unsupported or invalid SCIM filter.', 400, 'invalidFilter');
  if (typeof filter !== 'string' || !filter.trim()) throw invalid();
  const expression =
    /\s*(userName|externalId|displayName|emails\.value|emails\[type\s+eq\s+"work"\]\.value)\s+eq\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)\s*/giy;
  const filters: { attribute: string; value: string }[] = [];
  while (expression.lastIndex < filter.length) {
    const term = expression.exec(filter);
    if (!term) throw invalid();
    const attribute = term[1].toLowerCase().replace(/\s+/g, '');
    if (!allowed.includes(attribute)) throw invalid();
    let value = term[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw invalid();
      }
    } else if (value.startsWith("'")) value = value.slice(1, -1);
    filters.push({ attribute, value });
    if (expression.lastIndex === filter.length) break;
    const join = /^and\s+/i.exec(filter.slice(expression.lastIndex));
    if (!join) throw invalid();
    expression.lastIndex += join[0].length;
    if (expression.lastIndex === filter.length) throw invalid();
  }
  return filters;
}

export function pagination({ count, startIndex }: ListQuery) {
  const integer = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      !/^-?\d+$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value))
    ) {
      throw new JacksonError('count and startIndex must be integers.', 400);
    }
    return Number(value);
  };
  return {
    count: Math.min(1000, Math.max(0, integer(count, 100))),
    startIndex: Math.max(1, integer(startIndex, 1)),
  };
}

export const equal = (value: unknown, expected: string, exact = false) =>
  typeof value === 'string' && (exact ? value === expected : value.toLowerCase() === expected.toLowerCase());
