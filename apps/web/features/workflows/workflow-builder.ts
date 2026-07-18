import { z } from "zod";
import { normalizeApprovalConfig, validateTransformStepConfig } from "@automation/shared-types";
import type { RetryPolicyDto, StepType, WorkflowDefinitionDto, WorkflowStepDto, WorkflowVersion } from "./types";
import { buildGraph } from "./graph-builder";

export const STEP_TYPES: Array<{ value: StepType; label: string }> = [
  { value: "http_request", label: "HTTP Request" },
  { value: "ai_classification", label: "AI Classification" },
  { value: "ai_structured_extraction", label: "AI Structured Extraction" },
  { value: "ai_summary", label: "AI Summary" },
  { value: "email_notification", label: "Email" },
  { value: "database_record", label: "Database Record" },
  { value: "data_store_get_record", label: "Data Store: Get" },
  { value: "data_store_upsert_record", label: "Data Store: Upsert" },
  { value: "data_store_delete_record", label: "Data Store: Delete" },
  { value: "data_store_exists_record", label: "Data Store: Exists" },
  { value: "data_store_count_records", label: "Data Store: Count" },
  { value: "data_store_list_records", label: "Data Store: List" },
  { value: "set_variable", label: "Set Variable" },
  { value: "get_variable", label: "Get Variable" },
  { value: "delete_variable", label: "Delete Variable" },
  { value: "increment_variable", label: "Increment Variable" },
  { value: "append_variable", label: "Append Variable" },
  { value: "transform", label: "Transform" },
  { value: "if", label: "If" },
  { value: "switch", label: "Switch" },
  { value: "for_each", label: "For Each" },
  { value: "try_catch", label: "Try / Catch" },
  { value: "execute_workflow", label: "Execute Workflow" },
  { value: "return_workflow_output", label: "Return Workflow Output" },
  { value: "delay", label: "Delay" },
  { value: "wait_until", label: "Wait Until" },
  { value: "approval", label: "Approval" },
  { value: "conditional", label: "Conditional" }
];

export const DEFAULT_RETRY: RetryPolicyDto = { maxAttempts: 1, backoffMs: 1000, strategy: "fixed" };

export type StepFormValue = {
  id: string;
  key: string;
  name: string;
  type: StepType;
  expanded: boolean;
  config: Record<string, unknown>;
  retryPolicy: RetryPolicyDto;
  timeoutSeconds: number;
};

export type WorkflowEditorFormValue = {
  name: string;
  description: string;
  steps: StepFormValue[];
};

const retrySchema = z.object({
  maxAttempts: z.coerce.number().int().min(1, "Max attempts must be at least 1.").max(5, "Max attempts cannot exceed 5."),
  backoffMs: z.coerce.number().int().min(100, "Backoff must be at least 100 ms.").max(60000, "Backoff cannot exceed 60000 ms."),
  strategy: z.enum(["fixed", "exponential"])
});

export const workflowEditorSchema: z.ZodType<WorkflowEditorFormValue> = z
  .object({
    name: z.string().trim().min(2, "Workflow name is required."),
    description: z.string(),
    steps: z.array(
      z.object({
        id: z.string(),
        key: z.string().trim().min(1, "Step key is required."),
        name: z.string().trim().min(1, "Step name is required."),
        type: z.enum([
          "http_request",
          "ai_classification",
          "ai_structured_extraction",
          "ai_summary",
          "email_notification",
          "database_record",
          "data_store_get_record",
          "data_store_upsert_record",
          "data_store_delete_record",
          "data_store_exists_record",
          "data_store_count_records",
          "data_store_list_records",
          "set_variable",
          "get_variable",
          "delete_variable",
          "increment_variable",
          "append_variable",
          "transform",
          "conditional",
          "if",
          "switch",
          "for_each",
          "try_catch",
          "execute_workflow",
          "return_workflow_output",
          "delay",
          "wait_until",
          "approval"
        ]),
        expanded: z.boolean(),
        config: z.record(z.unknown()),
        retryPolicy: retrySchema,
        timeoutSeconds: z.coerce.number().int().min(1, "Timeout must be at least 1 second.").max(120, "Timeout cannot exceed 120 seconds.")
      })
    )
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    value.steps.forEach((step, index) => {
      if (keys.has(step.key)) {
        ctx.addIssue({ code: "custom", path: ["steps", index, "key"], message: "Step key must be unique." });
      }
      keys.add(step.key);
      validateStepConfig(step, index, ctx);
      validateRouting(value.steps, step, index, ctx);
    });
  });

function validateStepConfig(step: StepFormValue, index: number, ctx: z.RefinementCtx) {
  const config = step.config;
  if (step.type === "http_request") {
    if (config.legacyConnectionMode !== true) {
      requiredString(config.connectionId, ctx, index, "connectionId", "Connection is required.");
    }
    requiredString(config.url, ctx, index, "url", "URL is required.");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(config.method ?? ""))) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "method"], message: "Method is invalid." });
    }
    optionalJsonObject(config.headers, ctx, index, "headers", "Headers must be a JSON object.");
    optionalJson(config.body, ctx, index, "body", "Body must be valid JSON.");
  }
  if (step.type.startsWith("ai_")) {
    requiredString(config.text, ctx, index, "text", "Prompt is required.");
    if (step.type === "ai_structured_extraction") {
      optionalJsonObject(config.schema, ctx, index, "schema", "Schema must be a JSON object.");
    }
  }
  if (step.type === "email_notification") {
    if (config.legacyConnectionMode !== true) {
      requiredString(config.connectionId, ctx, index, "connectionId", "Connection is required.");
    }
    requiredString(config.to, ctx, index, "to", "Recipient is required.");
    requiredString(config.subject, ctx, index, "subject", "Subject is required.");
    requiredString(config.text, ctx, index, "text", "Body is required.");
  }
  if (step.type === "database_record") {
    requiredString(config.collection, ctx, index, "collection", "Collection is required.");
    if (typeof config.collection === "string" && !/^[a-zA-Z0-9_-]{1,64}$/.test(config.collection)) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "collection"], message: "Use letters, numbers, _ or - only." });
    }
    requiredJsonObject(config.data, ctx, index, "data", "Data must be a JSON object.");
  }
  if (step.type.startsWith("data_store_")) {
    requiredString(config.dataStoreName || config.dataStoreId, ctx, index, "dataStoreName", "Data Store is required.");
    if (["data_store_get_record", "data_store_upsert_record", "data_store_delete_record", "data_store_exists_record"].includes(step.type)) {
      requiredString(config.key, ctx, index, "key", "Key is required.");
    }
    if (step.type === "data_store_upsert_record") {
      optionalJson(config.value, ctx, index, "value", "Value must be valid JSON.");
      optionalJsonObject(config.metadata, ctx, index, "metadata", "Metadata must be a JSON object.");
    }
  }
  if (step.type === "transform") {
    const issues = validateTransformStepConfig(safeSerializeStepConfig(step));
    for (const issue of issues) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", fieldFromIssuePath(issue.path)], message: issue.message });
    }
  }
  if (step.type === "conditional") {
    requiredString(config.left, ctx, index, "left", "Expression is required.");
    if (!["equals", "not_equals", "contains"].includes(String(config.operator ?? ""))) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "operator"], message: "Operator is invalid." });
    }
  }
  if (step.type === "if") {
    requiredString(config.left, ctx, index, "left", "Expression is required.");
    if (!["equals", "not_equals", "contains"].includes(String(config.operator ?? ""))) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "operator"], message: "Operator is invalid." });
    }
    requiredString(config.trueStepKey, ctx, index, "trueStepKey", "True branch is required.");
    requiredString(config.falseStepKey, ctx, index, "falseStepKey", "False branch is required.");
  }
  if (step.type === "switch") {
    requiredString(config.value, ctx, index, "value", "Switch value is required.");
    const cases = Array.isArray(config.cases) ? config.cases : [];
    if (!cases.length) ctx.addIssue({ code: "custom", path: ["steps", index, "config", "cases"], message: "At least one case is required." });
    requiredString(config.defaultStepKey, ctx, index, "defaultStepKey", "Default branch is required.");
  }
  if (step.type === "for_each") {
    requiredString(config.source, ctx, index, "source", "Source is required.");
    if (config.mode !== "SEQUENTIAL") ctx.addIssue({ code: "custom", path: ["steps", index, "config", "mode"], message: "Only sequential mode is supported." });
    if (Number(config.concurrency) !== 1) ctx.addIssue({ code: "custom", path: ["steps", index, "config", "concurrency"], message: "Concurrency must be 1." });
  }
  if (step.type === "try_catch") {
    requiredString(config.bodyStepKey, ctx, index, "bodyStepKey", "Body is required.");
    requiredString(config.catchStepKey, ctx, index, "catchStepKey", "Catch is required.");
    requiredString(config.doneStepKey, ctx, index, "doneStepKey", "Done is required.");
  }
  if (step.type === "execute_workflow") {
    requiredString(config.workflowId, ctx, index, "workflowId", "Workflow is required.");
    if (!["PUBLISHED", "PINNED_VERSION"].includes(String(config.versionPolicy ?? ""))) ctx.addIssue({ code: "custom", path: ["steps", index, "config", "versionPolicy"], message: "Version policy is invalid." });
    if (config.versionPolicy === "PINNED_VERSION") requiredString(config.workflowVersionId, ctx, index, "workflowVersionId", "Version is required.");
  }
  if (step.type === "delay") {
    requiredString(config.duration, ctx, index, "duration", "Duration is required.");
    if (typeof config.duration === "string" && !config.duration.includes("{{") && !/^\s*[1-9][0-9]*\s+(second|seconds|minute|minutes|hour|hours)\s*$/i.test(config.duration)) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "duration"], message: "Use values like 30 seconds, 5 minutes, or 2 hours." });
    }
  }
  if (step.type === "wait_until") {
    requiredString(config.timestamp, ctx, index, "timestamp", "Timestamp is required.");
    if (typeof config.timestamp === "string" && !config.timestamp.includes("{{") && Number.isNaN(Date.parse(config.timestamp))) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", "timestamp"], message: "Timestamp must be valid." });
    }
  }
  if (step.type === "approval") {
    try { normalizeApprovalConfig(config); } catch (error) { ctx.addIssue({ code: "custom", path: ["steps", index, "config", "title"], message: error instanceof Error ? error.message : "Approval configuration is invalid." }); }
  }
}

function validateRouting(steps: StepFormValue[], step: StepFormValue, index: number, ctx: z.RefinementCtx) {
  const keyToIndex = new Map(steps.map((entry, entryIndex) => [entry.key, entryIndex]));
  const assertForward = (target: unknown, field: string) => {
    if (typeof target !== "string" || !target.trim()) return;
    const targetIndex = keyToIndex.get(target);
    if (targetIndex === undefined) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", field], message: "Target step does not exist." });
      return;
    }
  };
  assertForward(step.config.nextStepKey, "nextStepKey");
  if (step.type === "if") {
    assertForward(step.config.trueStepKey, "trueStepKey");
    assertForward(step.config.falseStepKey, "falseStepKey");
  }
  if (step.type === "switch") {
    assertForward(step.config.defaultStepKey, "defaultStepKey");
    const cases = Array.isArray(step.config.cases) ? (step.config.cases as Array<Record<string, unknown>>) : [];
    cases.forEach((entry, caseIndex) => assertForward(entry.stepKey, `cases.${caseIndex}.stepKey`));
  }
  if (step.type === "for_each") {
    assertForward(step.config.bodyStepKey, "bodyStepKey");
    assertForward(step.config.doneStepKey, "doneStepKey");
  }
  if (step.type === "try_catch") {
    assertForward(step.config.bodyStepKey, "bodyStepKey");
    assertForward(step.config.catchStepKey, "catchStepKey");
    assertForward(step.config.finallyStepKey, "finallyStepKey");
    assertForward(step.config.doneStepKey, "doneStepKey");
  }
}

function requiredString(value: unknown, ctx: z.RefinementCtx, index: number, key: string, message: string) {
  if (typeof value !== "string" || !value.trim()) {
    ctx.addIssue({ code: "custom", path: ["steps", index, "config", key], message });
  }
}

function optionalJson(value: unknown, ctx: z.RefinementCtx, index: number, key: string, message: string) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  try {
    JSON.parse(String(value));
  } catch {
    ctx.addIssue({ code: "custom", path: ["steps", index, "config", key], message });
  }
}

function optionalJsonObject(value: unknown, ctx: z.RefinementCtx, index: number, key: string, message: string) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "config", key], message });
    }
  } catch {
    ctx.addIssue({ code: "custom", path: ["steps", index, "config", key], message });
  }
}

function requiredJsonObject(value: unknown, ctx: z.RefinementCtx, index: number, key: string, message: string) {
  if (value === undefined || value === null || value === "") {
    ctx.addIssue({ code: "custom", path: ["steps", index, "config", key], message });
    return;
  }
  optionalJsonObject(value, ctx, index, key, message);
}

export function emptyStep(index: number, type: StepType = "http_request"): StepFormValue {
  return {
    id: crypto.randomUUID(),
    key: `step_${index + 1}`,
    name: STEP_TYPES.find((stepType) => stepType.value === type)?.label ?? "Step",
    type,
    expanded: true,
    config: defaultConfig(type),
    retryPolicy: { ...DEFAULT_RETRY },
    timeoutSeconds: defaultTimeout(type)
  };
}

export function defaultTimeout(type: StepType) {
  return type.startsWith("ai_") ? 60 : type === "http_request" ? 15 : 30;
}

export function defaultConfig(type: StepType): Record<string, unknown> {
  switch (type) {
    case "http_request":
      return { connectionId: "", method: "GET", url: "", headers: "{}", body: "" };
    case "ai_classification":
      return { text: "", labels: "high, normal, low", provider: "fake" };
    case "ai_structured_extraction":
      return { text: "", schema: "{}", provider: "fake" };
    case "ai_summary":
      return { text: "", max_words: 80, provider: "fake" };
    case "email_notification":
      return { connectionId: "", to: "", subject: "", text: "" };
    case "database_record":
      return { collection: "", data: "{}" };
    case "data_store_get_record":
      return { dataStoreId: "", dataStoreName: "", key: "", failIfMissing: false };
    case "data_store_upsert_record":
      return { dataStoreId: "", dataStoreName: "", key: "", value: "{}", metadata: "{}", ttlSeconds: "", mode: "replace", optimisticConcurrency: false, expectedVersion: "" };
    case "data_store_delete_record":
      return { dataStoreId: "", dataStoreName: "", key: "" };
    case "data_store_exists_record":
      return { dataStoreId: "", dataStoreName: "", key: "" };
    case "data_store_count_records":
      return { dataStoreId: "", dataStoreName: "", keyPrefix: "" };
    case "data_store_list_records":
      return { dataStoreId: "", dataStoreName: "", keyPrefix: "", limit: 20, offset: 0, sortBy: "key", direction: "asc" };
    case "set_variable":
      return { scope: "execution", name: "value", valueKind: "literal", valueType: "string", value: "", expression: "" };
    case "get_variable":
    case "delete_variable":
      return { scope: "execution", name: "value" };
    case "increment_variable":
      return { scope: "execution", name: "counter", amount: 1, amountExpression: "" };
    case "append_variable":
      return { scope: "execution", name: "items", valueKind: "literal", valueType: "string", value: "", expression: "" };
    case "transform":
      return { mode: "OBJECT", fields: "{\n  \"result\": \"{{trigger.body}}\"\n}", source: "{{trigger.body}}", paths: "id,name", template: "{\n  \"item\": \"{{item}}\",\n  \"index\": \"{{index}}\"\n}", condition: "{{item.active}}", mergeSources: "[\"{{trigger.body}}\", \"{{steps.previous.output}}\"]", conflictPolicy: "LAST_WINS", outputType: "AUTO" };
    case "conditional":
      return { left: "", operator: "equals", right: "", skipNextOnFalse: true };
    case "if":
      return { left: "", operator: "equals", right: "", trueStepKey: "", falseStepKey: "" };
    case "switch":
      return { value: "", cases: [{ key: "case_1", label: "Case 1", match: "", stepKey: "" }], defaultStepKey: "" };
    case "for_each":
      return { source: "{{steps.previous.output}}", itemVariable: "", indexVariable: "", mode: "SEQUENTIAL", concurrency: 1, continueOnError: false, maxItems: 100, collectResults: true, maxResults: 20, bodyStepKey: "", doneStepKey: "" };
    case "try_catch":
      return { bodyStepKey: "", catchStepKey: "", finallyStepKey: "", doneStepKey: "" };
    case "execute_workflow":
      return { workflowId: "", versionPolicy: "PUBLISHED", workflowVersionId: "", input: "{}", timeoutSeconds: 120 };
    case "return_workflow_output":
      return { output: "{}" };
    case "delay":
      return { duration: "30 seconds" };
    case "wait_until":
      return { timestamp: "" };
    case "approval":
      return { title: "Approval required", description: "", summary: "", expirationSeconds: "", assigneePolicy: "ANY_AUTHORIZED_USER", allowedRoles: ["editor", "admin", "owner"], approvedStepKey: "", rejectedStepKey: "", expiredStepKey: "" };
  }
}

export function keepCompatibleConfig(type: StepType, current: Record<string, unknown>) {
  const defaults = defaultConfig(type);
  const kept: Record<string, unknown> = { ...defaults };
  Object.keys(defaults).forEach((key) => {
    if (key in current) {
      kept[key] = current[key];
    }
  });
  return kept;
}

export function formFromVersion(workflow: { name: string; description?: string | null }, version?: WorkflowVersion): WorkflowEditorFormValue {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    steps: (version?.steps ?? [])
      .filter((step) => step.type !== "webhook_trigger")
      .map((step) => ({
        id: step.id,
        key: step.key,
        name: step.name,
        type: step.type as StepType,
        expanded: true,
        config: configToForm(step.type as StepType, step.configJson),
        retryPolicy: retryToForm(step.retryPolicyJson),
        timeoutSeconds: step.timeoutSeconds ?? defaultTimeout(step.type as StepType)
      }))
  };
}

function configToForm(type: StepType, config: Record<string, unknown>) {
  const defaults = defaultConfig(type);
  if (type === "http_request") {
    return {
      ...defaults,
      ...config,
      legacyConnectionMode: !config.connectionId,
      headers: JSON.stringify(config.headers ?? {}, null, 2),
      body: config.body === undefined ? "" : JSON.stringify(config.body, null, 2)
    };
  }
  if (type === "database_record") {
    return { ...defaults, ...config, data: JSON.stringify(config.data ?? {}, null, 2) };
  }
  if (type === "data_store_upsert_record") {
    return { ...defaults, ...config, value: JSON.stringify(config.value ?? {}, null, 2), metadata: JSON.stringify(config.metadata ?? {}, null, 2) };
  }
  if (type === "transform") {
    return {
      ...defaults,
      ...config,
      fields: JSON.stringify(config.fields ?? {}, null, 2),
      paths: Array.isArray(config.paths) ? config.paths.join(",") : defaults.paths,
      template: JSON.stringify(config.template ?? {}, null, 2),
      mergeSources: JSON.stringify(config.mergeSources ?? [], null, 2)
    };
  }
  if (type === "ai_structured_extraction") {
    return { ...defaults, ...config, schema: JSON.stringify(config.schema ?? {}, null, 2) };
  }
  if (type === "ai_classification") {
    return { ...defaults, ...config, labels: Array.isArray(config.labels) ? config.labels.join(", ") : defaults.labels };
  }
  if (type === "email_notification") {
    return { ...defaults, ...config, legacyConnectionMode: !config.connectionId };
  }
  if (type === "execute_workflow") return { ...defaults, ...config, input: JSON.stringify(config.input ?? {}, null, 2) };
  if (type === "return_workflow_output") return { ...defaults, ...config, output: JSON.stringify(config.output ?? null, null, 2) };
  return { ...defaults, ...config };
}

function retryToForm(value: Record<string, unknown> | null | undefined): RetryPolicyDto {
  const retry = value && typeof value.retry === "object" && value.retry ? (value.retry as Record<string, unknown>) : value;
  return {
    maxAttempts: Number(retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts),
    backoffMs: Number(retry?.backoffMs ?? DEFAULT_RETRY.backoffMs),
    strategy: retry?.strategy === "exponential" ? "exponential" : "fixed"
  };
}

export function toWorkflowDefinition(values: WorkflowEditorFormValue): WorkflowDefinitionDto {
  const graph = buildGraph(values.steps);
  return {
    expressionMode: "strict",
    workflowDefinitionSchemaVersion: graph ? 2 : 1,
    ...(graph ? { graph } : {}),
    workflowVariables: {},
    environmentVariables: {},
    trigger: values.steps.some((step) => step.type === "return_workflow_output")
      ? { key: "subworkflow", name: "Subworkflow Input", type: "subworkflow_trigger", config: {} }
      : { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
    steps: values.steps.map((step, index) => stepFormToDto(step, index))
  };
}

export function stepFormToDto(step: StepFormValue, index: number): WorkflowStepDto {
  return {
    key: step.key.trim() || `step_${index + 1}`,
    name: step.name.trim(),
    type: step.type,
    config: serializeStepConfig(step),
    retryPolicy: {
      maxAttempts: Number(step.retryPolicy.maxAttempts),
      backoffMs: Number(step.retryPolicy.backoffMs),
      strategy: step.retryPolicy.strategy
    },
    timeoutSeconds: Number(step.timeoutSeconds)
  };
}

export function serializeStepConfig(step: StepFormValue) {
  const config = step.config;
  switch (step.type) {
    case "http_request":
      return {
        method: String(config.method ?? "GET"),
        ...(config.connectionId ? { connectionId: String(config.connectionId) } : {}),
        url: String(config.url ?? "").trim(),
        headers: parseJsonObject(config.headers, {}),
        ...(config.body ? { body: JSON.parse(String(config.body)) } : {})
      };
    case "ai_classification":
      return {
        text: String(config.text ?? ""),
        labels: String(config.labels ?? "")
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        provider: String(config.provider ?? "fake")
      };
    case "ai_structured_extraction":
      return { text: String(config.text ?? ""), schema: parseJsonObject(config.schema, {}), provider: String(config.provider ?? "fake") };
    case "ai_summary":
      return { text: String(config.text ?? ""), max_words: Number(config.max_words ?? 80), provider: String(config.provider ?? "fake") };
    case "email_notification":
      return {
        ...(config.connectionId ? { connectionId: String(config.connectionId) } : {}),
        to: String(config.to ?? ""),
        subject: String(config.subject ?? ""),
        text: String(config.text ?? "")
      };
    case "database_record":
      return { collection: String(config.collection ?? ""), data: parseJsonObject(config.data, {}) };
    case "data_store_get_record":
      return dataStoreBaseConfig(config, { key: String(config.key ?? ""), failIfMissing: config.failIfMissing === true || config.failIfMissing === "true" });
    case "data_store_upsert_record":
      return dataStoreBaseConfig(config, {
        key: String(config.key ?? ""),
        value: parseJson(config.value, {}),
        metadata: parseJsonObject(config.metadata, {}),
        ...(config.ttlSeconds !== "" && config.ttlSeconds !== undefined ? { ttlSeconds: Number(config.ttlSeconds) } : {}),
        mode: config.mode === "merge" ? "merge" : "replace",
        optimisticConcurrency: config.optimisticConcurrency === true || config.optimisticConcurrency === "true",
        ...(config.expectedVersion !== "" && config.expectedVersion !== undefined ? { expectedVersion: Number(config.expectedVersion) } : {})
      });
    case "data_store_delete_record":
    case "data_store_exists_record":
      return dataStoreBaseConfig(config, { key: String(config.key ?? "") });
    case "data_store_count_records":
      return dataStoreBaseConfig(config, { keyPrefix: String(config.keyPrefix ?? "") });
    case "data_store_list_records":
      return dataStoreBaseConfig(config, { keyPrefix: String(config.keyPrefix ?? ""), limit: Number(config.limit ?? 20), offset: Number(config.offset ?? 0), sortBy: String(config.sortBy ?? "key"), direction: String(config.direction ?? "asc") });
    case "set_variable":
      return variableValueConfig(config);
    case "get_variable":
    case "delete_variable":
      return variableBaseConfig(config);
    case "increment_variable":
      return {
        ...variableBaseConfig(config),
        ...(config.amountExpression ? { amountExpression: String(config.amountExpression) } : { amount: Number(config.amount ?? 1) })
      };
    case "append_variable":
      return variableValueConfig(config);
    case "transform":
      return serializeTransformConfig(config);
    case "conditional":
      return {
        left: String(config.left ?? ""),
        operator: String(config.operator ?? "equals"),
        right: String(config.right ?? ""),
        skipNextOnFalse: config.skipNextOnFalse === true || config.skipNextOnFalse === "true"
      };
    case "if":
      return {
        left: String(config.left ?? ""),
        operator: String(config.operator ?? "equals"),
        right: String(config.right ?? ""),
        trueStepKey: String(config.trueStepKey ?? ""),
        falseStepKey: String(config.falseStepKey ?? "")
      };
    case "switch":
      return {
        value: String(config.value ?? ""),
        cases: Array.isArray(config.cases)
          ? (config.cases as Array<Record<string, unknown>>).map((entry) => ({
              key: String(entry.key ?? ""),
              label: String(entry.label ?? entry.key ?? ""),
              match: entry.match ?? "",
              stepKey: String(entry.stepKey ?? "")
            }))
          : [],
        defaultStepKey: String(config.defaultStepKey ?? "")
      };
    case "for_each":
      return {
        source: config.source,
        itemVariable: String(config.itemVariable ?? ""),
        indexVariable: String(config.indexVariable ?? ""),
        mode: "SEQUENTIAL",
        concurrency: 1,
        continueOnError: config.continueOnError === true,
        maxItems: Number(config.maxItems ?? 100),
        collectResults: config.collectResults !== false,
        maxResults: Number(config.maxResults ?? 20),
        bodyStepKey: String(config.bodyStepKey ?? ""),
        doneStepKey: String(config.doneStepKey ?? "")
      };
    case "try_catch":
      return { bodyStepKey: String(config.bodyStepKey ?? ""), catchStepKey: String(config.catchStepKey ?? ""), ...(config.finallyStepKey ? { finallyStepKey: String(config.finallyStepKey) } : {}), doneStepKey: String(config.doneStepKey ?? "") };
    case "execute_workflow":
      return { workflowId: String(config.workflowId ?? ""), versionPolicy: String(config.versionPolicy ?? "PUBLISHED"), ...(config.versionPolicy === "PINNED_VERSION" ? { workflowVersionId: String(config.workflowVersionId ?? "") } : {}), input: parseJsonOrExpression(config.input, null), timeoutSeconds: Number(config.timeoutSeconds ?? 120) };
    case "return_workflow_output":
      return { output: parseJsonOrExpression(config.output, null) };
    case "delay":
      return { duration: String(config.duration ?? "") };
    case "wait_until":
      return { timestamp: String(config.timestamp ?? "") };
    case "approval":
      return { title: String(config.title ?? ""), description: String(config.description ?? ""), summary: String(config.summary ?? ""), ...(config.expirationSeconds ? { expirationSeconds: Number(config.expirationSeconds) } : {}), assigneePolicy: "ANY_AUTHORIZED_USER", allowedRoles: Array.isArray(config.allowedRoles) ? config.allowedRoles : ["editor", "admin", "owner"] };
  }
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown>) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = JSON.parse(String(value));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

function safeSerializeStepConfig(step: StepFormValue) {
  try {
    return serializeStepConfig(step);
  } catch {
    return {};
  }
}

function serializeTransformConfig(config: Record<string, unknown>) {
  const mode = String(config.mode ?? "OBJECT");
  const base = {
    configVersion: 1,
    mode,
    outputType: String(config.outputType ?? "AUTO")
  };
  if (mode === "OBJECT") return { ...base, fields: parseJsonObject(config.fields, {}) };
  if (mode === "PICK" || mode === "OMIT") return { ...base, source: String(config.source ?? ""), paths: parsePaths(config.paths) };
  if (mode === "MAP_ARRAY") return { ...base, source: String(config.source ?? ""), template: parseJson(config.template, {}), itemVariable: "item" };
  if (mode === "FILTER_ARRAY") return { ...base, source: String(config.source ?? ""), condition: String(config.condition ?? ""), itemVariable: "item" };
  if (mode === "MERGE") return { ...base, mergeSources: parseJsonArray(config.mergeSources, []), conflictPolicy: String(config.conflictPolicy ?? "LAST_WINS") };
  return base;
}

function parseJson(value: unknown, fallback: unknown) {
  if (value === undefined || value === null || value === "") return fallback;
  return JSON.parse(String(value));
}

function parseJsonOrExpression(value: unknown, fallback: unknown) {
  try { return parseJson(value, fallback); }
  catch (error) { if (typeof value === "string" && value.includes("{{")) return value; throw error; }
}

function parseJsonArray(value: unknown, fallback: unknown[]) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

function dataStoreBaseConfig(config: Record<string, unknown>, extra: Record<string, unknown>) {
  return {
    ...(config.dataStoreId ? { dataStoreId: String(config.dataStoreId) } : {}),
    ...(config.dataStoreName ? { dataStoreName: String(config.dataStoreName) } : {}),
    ...extra
  };
}

function variableBaseConfig(config: Record<string, unknown>) {
  return {
    scope: config.scope === "workflow" ? "workflow" : "execution",
    name: String(config.name ?? "")
  };
}

function variableValueConfig(config: Record<string, unknown>) {
  const base = variableBaseConfig(config);
  if (config.valueKind === "expression" || config.expression) return { ...base, expression: String(config.expression ?? "") };
  return { ...base, value: parseVariableLiteral(config.value, String(config.valueType ?? "string")) };
}

function parseVariableLiteral(value: unknown, type: string) {
  if (type === "number") return Number(value ?? 0);
  if (type === "boolean") return value === true || value === "true";
  if (type === "null") return null;
  if (type === "json") return parseJson(value, {});
  return String(value ?? "");
}

function parsePaths(value: unknown) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fieldFromIssuePath(path: string) {
  if (path.includes("fields")) return "fields";
  if (path.includes("paths")) return "paths";
  if (path.includes("source")) return "source";
  if (path.includes("template")) return "template";
  if (path.includes("condition")) return "condition";
  if (path.includes("mergeSources")) return "mergeSources";
  if (path.includes("conflictPolicy")) return "conflictPolicy";
  return "mode";
}
