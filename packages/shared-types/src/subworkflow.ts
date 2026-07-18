import { assertVariableValue, WORKFLOW_VARIABLE_LIMITS } from "./workflow-variables";

export const SUBWORKFLOW_LIMITS = {
  maxDepth: 8,
  maxChildrenPerRoot: 1_000,
  maxInputBytes: WORKFLOW_VARIABLE_LIMITS.maxValueBytes,
  maxOutputBytes: WORKFLOW_VARIABLE_LIMITS.maxValueBytes,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 120,
  defaultTimeoutSeconds: 120,
  recheckMilliseconds: 2_000
} as const;

export type SubworkflowVersionPolicy = "PUBLISHED" | "PINNED_VERSION";

export type ExecuteWorkflowConfig = {
  workflowId: string;
  versionPolicy: SubworkflowVersionPolicy;
  workflowVersionId?: string;
  input: unknown;
  timeoutSeconds?: number;
};

export type SubworkflowExecutionOutput = {
  output: unknown;
  childExecutionId: string;
  workflowId: string;
  workflowVersionId: string;
  status: "COMPLETED";
  durationMs: number | null;
  depth: number;
};

export function assertSubworkflowJson(value: unknown, label: "input" | "output") {
  const checked = assertVariableValue(value, `subworkflow ${label}`);
  const bytes = JSON.stringify(checked).length;
  const maximum = label === "input" ? SUBWORKFLOW_LIMITS.maxInputBytes : SUBWORKFLOW_LIMITS.maxOutputBytes;
  if (bytes > maximum) throw new Error(`Subworkflow ${label} exceeds maximum size.`);
  return checked;
}

export function normalizeExecuteWorkflowConfig(value: unknown): ExecuteWorkflowConfig {
  if (!isRecord(value)) throw new Error("EXECUTE_WORKFLOW config must be an object");
  const workflowId = typeof value.workflowId === "string" ? value.workflowId.trim() : "";
  const versionPolicy = value.versionPolicy === "PINNED_VERSION" ? "PINNED_VERSION" : value.versionPolicy === "PUBLISHED" ? "PUBLISHED" : undefined;
  const workflowVersionId = typeof value.workflowVersionId === "string" ? value.workflowVersionId.trim() : undefined;
  const timeoutSeconds = value.timeoutSeconds === undefined ? SUBWORKFLOW_LIMITS.defaultTimeoutSeconds : Number(value.timeoutSeconds);
  if (!workflowId) throw new Error("EXECUTE_WORKFLOW workflowId is required");
  if (!versionPolicy) throw new Error("EXECUTE_WORKFLOW versionPolicy is invalid");
  if (versionPolicy === "PINNED_VERSION" && !workflowVersionId) throw new Error("EXECUTE_WORKFLOW workflowVersionId is required for PINNED_VERSION");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < SUBWORKFLOW_LIMITS.minTimeoutSeconds || timeoutSeconds > SUBWORKFLOW_LIMITS.maxTimeoutSeconds) {
    throw new Error(`EXECUTE_WORKFLOW timeoutSeconds must be between ${SUBWORKFLOW_LIMITS.minTimeoutSeconds} and ${SUBWORKFLOW_LIMITS.maxTimeoutSeconds}`);
  }
  return { workflowId, versionPolicy, ...(workflowVersionId ? { workflowVersionId } : {}), input: value.input ?? null, timeoutSeconds };
}

export class SubworkflowExecutionError extends Error {
  readonly retryable: boolean;
  constructor(readonly details: { childExecutionId?: string; workflowId: string; status: string; category: string; code: string; safeMessage: string }, retryable = false) {
    super(details.safeMessage);
    this.name = "SubworkflowExecutionError";
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
