import { EXPRESSION_ERROR_CODES, ExpressionError } from "./errors";
import type { ExpressionParseOptions, ParsedTemplate, TemplatePart } from "./types";

const DEFAULT_MAX_EXPRESSION_LENGTH = 512;
const DEFAULT_MAX_INTERPOLATIONS = 50;
const DEFAULT_MAX_PATH_DEPTH = 16;
const DEFAULT_MAX_ARRAY_INDEX = 10_000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ARRAY_INDEX = /^[0-9]+$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor", "eval"]);
const cache = new Map<string, ParsedTemplate>();
const CACHE_MAX = 500;

export function parseTemplate(source: string, options: ExpressionParseOptions = {}): ParsedTemplate {
  const cached = cache.get(source);
  if (cached) return cached;

  const parts: TemplatePart[] = [];
  let cursor = 0;
  let expressionCount = 0;
  const regex = /\{\{([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    if (match.index > cursor) {
      parts.push({ type: "text", value: source.slice(cursor, match.index) });
    }
    const raw = match[1].trim();
    expressionCount += 1;
    if (expressionCount > (options.maxInterpolations ?? DEFAULT_MAX_INTERPOLATIONS)) {
      throw syntax("Too many expressions in one field", raw);
    }
    parts.push({ type: "expression", raw, path: parsePath(raw, options) });
    cursor = regex.lastIndex;
  }
  if (cursor < source.length) {
    const tail = source.slice(cursor);
    if (tail.includes("{{") || tail.includes("}}")) {
      throw syntax("Invalid expression delimiters", source);
    }
    parts.push({ type: "text", value: tail });
  }
  if (source.includes("{{") && expressionCount === 0) {
    throw syntax("Invalid expression delimiters", source);
  }
  const isSingleExpression = parts.length === 1 && parts[0]?.type === "expression";
  const parsed = Object.freeze({ source, parts: Object.freeze(parts), expressionCount, isSingleExpression }) as ParsedTemplate;
  cache.set(source, parsed);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return parsed;
}

export function parsePath(raw: string, options: ExpressionParseOptions = {}) {
  if (!raw) throw syntax("Expression cannot be empty", raw);
  if (raw.length > (options.maxExpressionLength ?? DEFAULT_MAX_EXPRESSION_LENGTH)) {
    throw syntax("Expression is too long", raw);
  }
  if (/[()[\]'"`|+\-*/%?:,]/.test(raw)) {
    throw syntax("Expression syntax is not supported", raw);
  }
  const segments = raw.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw syntax("Expression path contains an empty segment", raw);
  }
  if (segments.length > (options.maxPathDepth ?? DEFAULT_MAX_PATH_DEPTH)) {
    throw syntax("Expression path is too deep", raw);
  }
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new ExpressionError({
        code: EXPRESSION_ERROR_CODES.segmentForbidden,
        message: `Expression segment "${segment}" is not allowed`,
        expression: raw,
        path: raw
      });
    }
    if (ARRAY_INDEX.test(segment)) {
      if (Number(segment) > (options.maxArrayIndex ?? DEFAULT_MAX_ARRAY_INDEX)) {
        throw syntax("Array index is too large", raw);
      }
      continue;
    }
    if (!IDENTIFIER.test(segment)) {
      throw syntax(`Expression segment "${segment}" is invalid`, raw);
    }
  }
  return {
    raw,
    namespace: segments[0],
    segments
  };
}

function syntax(message: string, expression: string): never {
  throw new ExpressionError({
    code: EXPRESSION_ERROR_CODES.syntaxInvalid,
    message,
    expression,
    path: expression
  });
}
