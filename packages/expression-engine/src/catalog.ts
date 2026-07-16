import type { ExpressionValueType, VariableCatalogEntry, WorkflowStepLike } from "./types";

export function buildVariableCatalog(input: { steps?: WorkflowStepLike[]; includeMetadata?: boolean } = {}): VariableCatalogEntry[] {
  const entries: VariableCatalogEntry[] = [
    entry("trigger.body", "object", "Webhook body", "Incoming webhook JSON body", "trigger"),
    entry("trigger.headers", "object", "Webhook headers", "Sanitized incoming webhook headers", "trigger"),
    entry("workflow.id", "string", "Workflow ID", undefined, "workflow"),
    entry("workflow.versionId", "string", "Workflow version ID", undefined, "workflow"),
    entry("workflow.name", "string", "Workflow name", undefined, "workflow"),
    entry("workflow.variables", "object", "Workflow variables", "Non-secret workflow variables", "workflow"),
    entry("execution.id", "string", "Execution ID", undefined, "execution"),
    entry("execution.correlationId", "string", "Correlation ID", undefined, "execution"),
    entry("execution.retryOfExecutionId", "string", "Retry source execution ID", undefined, "execution"),
    entry("execution.startedAt", "string", "Execution start time", undefined, "execution"),
    entry("organization.id", "string", "Organization ID", undefined, "organization"),
    entry("organization.slug", "string", "Organization slug", undefined, "organization"),
    entry("organization.variables", "object", "Organization variables", "Non-secret organization variables", "organization"),
    entry("connection.id", "string", "Connection ID", "Metadata only", "connection"),
    entry("connection.name", "string", "Connection name", "Metadata only", "connection"),
    entry("connection.type", "string", "Connection type", "Metadata only", "connection")
  ];
  if (input.includeMetadata) entries.push(entry("metadata.executionId", "string", "Legacy execution ID", "Legacy compatibility alias", "metadata"));
  for (const step of input.steps ?? []) {
    entries.push(...stepOutputEntries(step));
  }
  return entries;
}

function stepOutputEntries(step: WorkflowStepLike): VariableCatalogEntry[] {
  const base = `steps.${step.key}`;
  const common = [entry(`${base}.status`, "string", `${step.name ?? step.key} status`, undefined, "steps")];
  switch (step.type) {
    case "http_request":
      return [...common, entry(`${base}.output.status`, "number", `${step.name ?? step.key} HTTP status`, undefined, "steps"), entry(`${base}.output.ok`, "boolean", `${step.name ?? step.key} OK`, undefined, "steps"), entry(`${base}.output.body`, "unknown", `${step.name ?? step.key} body`, undefined, "steps")];
    case "ai_classification":
      return [...common, entry(`${base}.output.category`, "string", `${step.name ?? step.key} category`, undefined, "steps"), entry(`${base}.output.confidence`, "number", `${step.name ?? step.key} confidence`, undefined, "steps"), entry(`${base}.output.raw`, "unknown", `${step.name ?? step.key} raw output`, undefined, "steps")];
    case "ai_structured_extraction":
      return [...common, entry(`${base}.output.data`, "object", `${step.name ?? step.key} extracted data`, undefined, "steps")];
    case "ai_summary":
      return [...common, entry(`${base}.output.summary`, "string", `${step.name ?? step.key} summary`, undefined, "steps")];
    case "conditional":
      return [...common, entry(`${base}.output.passed`, "boolean", `${step.name ?? step.key} passed`, undefined, "steps")];
    case "database_record":
      return [...common, entry(`${base}.output.recordId`, "string", `${step.name ?? step.key} record ID`, undefined, "steps"), entry(`${base}.output.collection`, "string", `${step.name ?? step.key} collection`, undefined, "steps"), entry(`${base}.output.createdAt`, "string", `${step.name ?? step.key} created at`, undefined, "steps")];
    case "email_notification":
      return [...common, entry(`${base}.output.messageId`, "string", `${step.name ?? step.key} message ID`, undefined, "steps"), entry(`${base}.output.accepted`, "array", `${step.name ?? step.key} accepted recipients`, undefined, "steps")];
    default:
      return [...common, entry(`${base}.output`, "unknown", `${step.name ?? step.key} output`, undefined, "steps")];
  }
}

function entry(path: string, type: ExpressionValueType, label: string, description: string | undefined, namespace: VariableCatalogEntry["namespace"]): VariableCatalogEntry {
  return { path, type, label, description, namespace };
}
