"use client";

import { buildVariableCatalog, ExpressionResolver, validateExpressionString, type VariableCatalogEntry } from "@automation/expression-engine";
import type { StepFormValue } from "./workflow-builder";

const resolver = new ExpressionResolver();

export function catalogForSteps(steps: StepFormValue[], beforeIndex: number): VariableCatalogEntry[] {
  return buildVariableCatalog({
    steps: steps.slice(0, beforeIndex).map((step) => ({ key: step.key, name: step.name, type: step.type, config: step.config }))
  });
}

export function validateExpressionPreview(value: string, availableStepKeys: string[]) {
  if (!value.includes("{{")) return { valid: true, result: value };
  const validation = validateExpressionString(value, { availableStepKeys, allowConnection: true, allowMetadata: true });
  if (!validation.valid) return { valid: false, issues: validation.issues };
  try {
    return { valid: true, result: resolver.resolveString(value, previewScope(), { mode: "legacy" }) };
  } catch (error: any) {
    return { valid: false, issues: [typeof error?.toJSON === "function" ? error.toJSON() : { code: "EXPRESSION_PREVIEW_FAILED", message: error?.message ?? String(error) }] };
  }
}

function previewScope() {
  return {
    trigger: { body: { email: "ada@example.com", name: "Ada", priority: "high", region: "us" }, headers: {} },
    workflow: { id: "workflow-preview", versionId: "version-preview", name: "Preview workflow", variables: { region: "us" } },
    steps: {
      step_1: { status: "COMPLETED", output: { ok: true, status: 200, body: { id: "item_1" }, category: "high", summary: "Short summary", passed: true } }
    },
    execution: { id: "execution-preview", correlationId: "correlation-preview", retryOfExecutionId: null, startedAt: new Date(0).toISOString() },
    organization: { id: "organization-preview", slug: "acme", variables: { tier: "pro" } },
    connection: { id: "connection-preview", name: "Primary connection", type: "HTTP", authScheme: "API_KEY" },
    metadata: { executionId: "execution-preview" }
  };
}
