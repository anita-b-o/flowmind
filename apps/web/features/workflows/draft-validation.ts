import { graphAvailableStepKeys, validateGraphV2, validateTransformStepConfig } from "@automation/shared-types";
import { validateExpressionsInValue } from "@automation/expression-engine";
import type { DraftEdge, DraftValidationIssue, WorkflowDraftModel } from "./draft-model";
import { caseKeyFromHandle, handleToGraphKind } from "./draft-model";
import { serializeStepConfig } from "./workflow-builder";

const STEP_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const COLLECTION_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const OPERATORS = new Set(["equals", "not_equals", "contains"]);

export function validateDraft(draft: WorkflowDraftModel) {
  const issues: DraftValidationIssue[] = [];
  const graph = draftToGraphLike(draft);
  const steps = draft.stepOrder.map((key) => draft.stepsByKey[key]).filter(Boolean);

  issues.push(
    ...validateGraphV2(
      steps.map((step) => ({ id: step.id, key: step.key, type: step.type, config: safeSerializeConfig(step) })),
      graph
    ).map((issue) => ({ ...issue, severity: issue.severity }))
  );

  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const key of draft.stepOrder) {
    const step = draft.stepsByKey[key];
    if (!step) {
      issues.push(error("missing_step", `Step "${key}" is missing from the draft.`, key));
      continue;
    }
    if (!STEP_KEY_PATTERN.test(key)) issues.push(error("invalid_step_key", "Step key may only contain letters, numbers, _ or -.", key));
    if (seenKeys.has(step.key)) issues.push(error("duplicate_step_key", "Step key must be unique.", step.key));
    seenKeys.add(step.key);
    if (seenIds.has(step.id)) issues.push(error("duplicate_step_id", "Step ID must be unique.", step.key));
    seenIds.add(step.id);
    validateStepConfig(step, issues);
    validateStepExpressions(step.key, safeSerializeConfig(step), draft, issues);
  }

  return dedupeIssues({ issues });
}

export function wouldCreateCycle(draft: WorkflowDraftModel, edge: DraftEdge) {
  const graph = draftToGraphLike({ ...draft, edges: [...draft.edges, edge] });
  return validateGraphV2(
    draft.stepOrder.map((key) => {
      const step = draft.stepsByKey[key];
      return { id: step.id, key: step.key, type: step.type, config: safeSerializeConfig(step) };
    }),
    graph
  ).some((issue) => issue.code === "cycle" || issue.code === "self_loop");
}

function validateStepConfig(step: NonNullable<WorkflowDraftModel["stepsByKey"][string]>, issues: DraftValidationIssue[]) {
  const config = step.config;
  if (step.type === "http_request") {
    if (config.legacyConnectionMode !== true) requiredString(config.connectionId, issues, step.key, "Connection is required.");
    requiredString(config.url, issues, step.key, "URL is required.");
    if (!HTTP_METHODS.has(String(config.method ?? ""))) issues.push(error("invalid_http_method", "HTTP method is invalid.", step.key));
    optionalJsonObject(config.headers, issues, step.key, "Headers must be a JSON object.");
    optionalJson(config.body, issues, step.key, "Body must be valid JSON.");
  }
  if (step.type.startsWith("ai_")) {
    requiredString(config.text, issues, step.key, "Prompt is required.");
    if (step.type === "ai_structured_extraction") optionalJsonObject(config.schema, issues, step.key, "Schema must be a JSON object.");
  }
  if (step.type === "email_notification") {
    if (config.legacyConnectionMode !== true) requiredString(config.connectionId, issues, step.key, "Connection is required.");
    requiredString(config.to, issues, step.key, "Recipient is required.");
    requiredString(config.subject, issues, step.key, "Subject is required.");
    requiredString(config.text, issues, step.key, "Body is required.");
  }
  if (step.type === "database_record") {
    requiredString(config.collection, issues, step.key, "Collection is required.");
    if (typeof config.collection === "string" && config.collection && !COLLECTION_PATTERN.test(config.collection)) issues.push(error("invalid_collection", "Collection may only contain letters, numbers, _ or -.", step.key));
    requiredJsonObject(config.data, issues, step.key, "Data must be a JSON object.");
  }
  if (step.type === "transform") {
    const serialized = safeSerializeConfig(step);
    for (const transformIssue of validateTransformStepConfig(serialized)) {
      issues.push(error(transformIssue.code, transformIssue.message, step.key));
    }
  }
  if (step.type === "conditional" || step.type === "if") {
    requiredString(config.left, issues, step.key, "Expression is required.");
    if (!OPERATORS.has(String(config.operator ?? ""))) issues.push(error("invalid_operator", "Operator is invalid.", step.key));
  }
  if (step.type === "switch") {
    requiredString(config.value, issues, step.key, "Switch value is required.");
    const cases = Array.isArray(config.cases) ? (config.cases as Array<Record<string, unknown>>) : [];
    if (!cases.length) issues.push(error("missing_switch_cases", "At least one switch case is required.", step.key));
    for (const entry of cases) {
      requiredString(entry.match, issues, step.key, "Switch case match is required.", `case:${String(entry.key ?? "")}`);
    }
  }
}

function validateStepExpressions(stepKey: string, serializedConfig: Record<string, unknown>, draft: WorkflowDraftModel, issues: DraftValidationIssue[]) {
  const available = graphAvailableStepKeys(
    stepKey,
    draft.stepOrder.map((key) => {
      const step = draft.stepsByKey[key];
      return { id: step.id, key: step.key, type: step.type, config: safeSerializeConfig(step) };
    }),
    draftToGraphLike(draft)
  );
  const result = validateExpressionsInValue(serializedConfig, { availableStepKeys: available, currentStepKey: stepKey, allowConnection: true, allowMetadata: true, localNamespaces: serializedConfig.mode ? ["item", "index"] : undefined });
  for (const expressionIssue of result.issues) {
    issues.push(error("invalid_expression", expressionIssue.message, stepKey));
  }
}

function draftToGraphLike(draft: WorkflowDraftModel) {
  return {
    entryStepKey: draft.stepOrder[0] ?? "",
    edges: draft.edges.map((edge) => {
      const kind = handleToGraphKind(edge.sourceHandle);
      return {
        from: edge.source,
        to: edge.target,
        kind,
        ...(edge.sourceHandle === "true" ? { label: "true" } : {}),
        ...(edge.sourceHandle === "false" ? { label: "false" } : {}),
        ...(edge.sourceHandle === "default" ? { label: "default" } : {}),
        ...(kind === "switch_case" ? { caseKey: caseKeyFromHandle(edge.sourceHandle), label: caseKeyFromHandle(edge.sourceHandle) } : {})
      };
    })
  };
}

function safeSerializeConfig(step: NonNullable<WorkflowDraftModel["stepsByKey"][string]>) {
  try {
    return serializeStepConfig(step);
  } catch {
    return { ...step.config };
  }
}

function requiredString(value: unknown, issues: DraftValidationIssue[], stepKey: string, message: string, handle?: string) {
  if (typeof value !== "string" || !value.trim()) issues.push(error("required_config", message, stepKey, handle));
}

function optionalJson(value: unknown, issues: DraftValidationIssue[], stepKey: string, message: string) {
  if (value === undefined || value === null || value === "") return;
  try {
    JSON.parse(String(value));
  } catch {
    issues.push(error("invalid_json", message, stepKey));
  }
}

function optionalJsonObject(value: unknown, issues: DraftValidationIssue[], stepKey: string, message: string) {
  if (value === undefined || value === null || value === "") return;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) issues.push(error("invalid_json_object", message, stepKey));
  } catch {
    issues.push(error("invalid_json_object", message, stepKey));
  }
}

function requiredJsonObject(value: unknown, issues: DraftValidationIssue[], stepKey: string, message: string) {
  if (value === undefined || value === null || value === "") {
    issues.push(error("required_config", message, stepKey));
    return;
  }
  optionalJsonObject(value, issues, stepKey, message);
}

function error(code: string, message: string, stepKey?: string, handle?: string): DraftValidationIssue {
  return { code, message, severity: "error", ...(stepKey ? { stepKey } : {}), ...(handle ? { handle } : {}) };
}

function dedupeIssues(result: { issues: DraftValidationIssue[] }) {
  const seen = new Set<string>();
  return {
    issues: result.issues.filter((issue) => {
      const key = `${issue.code}:${issue.stepKey ?? ""}:${issue.edgeId ?? ""}:${issue.handle ?? ""}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  };
}
