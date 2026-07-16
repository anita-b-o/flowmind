import { EXPRESSION_ERROR_CODES, ExpressionError } from "./errors";
import { parseTemplate } from "./parser";
import type { ExpressionResolveOptions, ExpressionScope, ParsedTemplate } from "./types";

export class ExpressionResolver {
  resolveValue(value: unknown, scope: ExpressionScope, options: ExpressionResolveOptions = {}): unknown {
    if (typeof value === "string") return this.resolveString(value, scope, options);
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, scope, options));
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.resolveValue(entry, scope, options)]));
    }
    return value;
  }

  resolveString(value: string, scope: ExpressionScope, options: ExpressionResolveOptions = {}): unknown {
    const parsed = parseTemplate(value, options);
    if (parsed.expressionCount === 0) return value;
    return this.resolveTemplate(parsed, scope, options);
  }

  resolveTemplate(parsed: ParsedTemplate, scope: ExpressionScope, options: ExpressionResolveOptions = {}): unknown {
    const mode = options.mode ?? "legacy";
    if (parsed.isSingleExpression) {
      const expression = parsed.parts[0];
      if (expression.type !== "expression") return parsed.source;
      const resolved = readPath(scope, expression.path.segments);
      if (resolved.found) return resolved.value;
      if (mode === "legacy") return "";
      throw new ExpressionError({
        code: EXPRESSION_ERROR_CODES.pathNotFound,
        message: `Expression path "${expression.raw}" was not found`,
        path: expression.raw,
        expression: expression.raw,
        namespace: expression.path.namespace
      });
    }
    let output = "";
    for (const part of parsed.parts) {
      if (part.type === "text") {
        output += part.value;
        continue;
      }
      const resolved = readPath(scope, part.path.segments);
      if (!resolved.found || resolved.value === undefined || resolved.value === null) {
        if (mode === "legacy") {
          output += "";
          continue;
        }
        throw new ExpressionError({
          code: EXPRESSION_ERROR_CODES.pathNotFound,
          message: `Expression path "${part.raw}" was not found`,
          path: part.raw,
          expression: part.raw,
          namespace: part.path.namespace
        });
      }
      output += stringifyInterpolated(resolved.value);
    }
    return output;
  }
}

export function readPath(source: unknown, segments: string[]): { found: boolean; value?: unknown } {
  let current = source;
  for (const segment of segments) {
    if (Array.isArray(current) && /^[0-9]+$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function stringifyInterpolated(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}
