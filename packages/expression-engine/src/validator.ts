import { EXPRESSION_ERROR_CODES, ExpressionError } from "./errors";
import { parseTemplate } from "./parser";
import type { ExpressionNamespace, ExpressionValidationContext, ExpressionValidationIssue, ExpressionValidationResult } from "./types";

const NAMESPACES = new Set<ExpressionNamespace>(["trigger", "workflow", "steps", "execution", "organization", "connection", "metadata"]);
const CONNECTION_ALLOWED = new Set(["connection.id", "connection.name", "connection.type"]);
const CONNECTION_BLOCKED = new Set(["secret", "secretValue", "password", "apiKey", "encryptedValue", "headers", "additionalHeaders", "authName"]);

export function validateExpressionString(value: string, context: ExpressionValidationContext = {}): ExpressionValidationResult {
  const issues: ExpressionValidationIssue[] = [];
  try {
    const parsed = parseTemplate(value, context);
    for (const part of parsed.parts) {
      if (part.type !== "expression") continue;
      const path = part.path;
      const namespace = path.namespace;
      if (!NAMESPACES.has(namespace as ExpressionNamespace)) {
        issues.push(issue(EXPRESSION_ERROR_CODES.namespaceUnknown, `Unknown expression namespace "${namespace}"`, path.raw, namespace));
        continue;
      }
      if (namespace === "metadata" && context.allowMetadata === false) {
        issues.push(issue(EXPRESSION_ERROR_CODES.accessDenied, "metadata.* is legacy-only and is not available here", path.raw, namespace));
      }
      if (namespace === "connection") {
        if (context.allowConnection === false || !CONNECTION_ALLOWED.has(path.raw) || path.segments.some((segment) => CONNECTION_BLOCKED.has(segment))) {
          issues.push(issue(EXPRESSION_ERROR_CODES.accessDenied, `Expression path "${path.raw}" is not allowed`, path.raw, namespace));
        }
      }
      if (namespace === "steps") {
        validateStepPath(path.segments, path.raw, context, issues);
      }
      if (
        namespace === "trigger" &&
        !["trigger.body", "trigger.headers", "trigger.query", "trigger.method", "trigger.receivedAt"].some((prefix) => path.raw === prefix || path.raw.startsWith(`${prefix}.`))
      ) {
        issues.push(issue(EXPRESSION_ERROR_CODES.accessDenied, "trigger expressions must use trigger.body.*, trigger.headers.*, trigger.query.*, trigger.method, or trigger.receivedAt", path.raw, namespace));
      }
    }
  } catch (error) {
    if (error instanceof ExpressionError) issues.push(error.toJSON());
    else issues.push(issue(EXPRESSION_ERROR_CODES.syntaxInvalid, error instanceof Error ? error.message : String(error), value));
  }
  return { valid: issues.length === 0, issues };
}

export function validateExpressionsInValue(value: unknown, context: ExpressionValidationContext = {}, at = "$"): ExpressionValidationResult {
  const issues: ExpressionValidationIssue[] = [];
  visit(value, at, (candidate, path) => {
    if (!candidate.includes("{{")) return;
    const result = validateExpressionString(candidate, context);
    issues.push(...result.issues.map((entry) => ({ ...entry, path: entry.path ?? path })));
  });
  return { valid: issues.length === 0, issues };
}

function validateStepPath(segments: string[], raw: string, context: ExpressionValidationContext, issues: ExpressionValidationIssue[]) {
  const stepKey = segments[1];
  if (!stepKey) {
    issues.push(issue(EXPRESSION_ERROR_CODES.syntaxInvalid, "steps expressions must include a step key", raw, "steps"));
    return;
  }
  const available = context.availableStepKeys ?? [];
  if (!available.includes(stepKey)) {
    issues.push(issue(EXPRESSION_ERROR_CODES.stepNotAvailable, `Step "${stepKey}" is not available for this expression`, raw, "steps"));
  }
  if (stepKey === context.currentStepKey) {
    issues.push(issue(EXPRESSION_ERROR_CODES.stepNotAvailable, "A step cannot reference its own output", raw, "steps"));
  }
  if (segments[2] && !["output", "status"].includes(segments[2])) {
    issues.push(issue(EXPRESSION_ERROR_CODES.accessDenied, "steps expressions must use output.* or status", raw, "steps"));
  }
}

function visit(value: unknown, path: string, fn: (value: string, path: string) => void) {
  if (typeof value === "string") {
    fn(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}.${index}`, fn));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => visit(entry, `${path}.${key}`, fn));
  }
}

function issue(code: string, message: string, expression: string, namespace?: string): ExpressionValidationIssue {
  return { code, message, expression, namespace, path: expression };
}
