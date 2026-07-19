import { parseTemplate } from "./parser";

export type ExpressionReference = { raw: string; namespace: string; segments: string[]; valuePath: string };

export function extractExpressionReferences(value: unknown): ExpressionReference[] {
  const references: ExpressionReference[] = [];
  visit(value, "$", (source, valuePath) => {
    if (!source.includes("{{")) return;
    try {
      for (const part of parseTemplate(source).parts) {
        if (part.type === "expression") references.push({ raw: part.path.raw, namespace: part.path.namespace, segments: [...part.path.segments], valuePath });
      }
    } catch {
      // Validation reports malformed expressions; dependency analysis remains best-effort.
    }
  });
  return references;
}

function visit(value: unknown, path: string, fn: (source: string, path: string) => void) {
  if (typeof value === "string") return fn(value, path);
  if (Array.isArray(value)) return value.forEach((entry, index) => visit(entry, `${path}.${index}`, fn));
  if (value && typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => visit(entry, `${path}.${key}`, fn));
}
