export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  activeVersionId?: string | null;
  activeVersion?: WorkflowVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type StepType =
  | "http_request"
  | "ai_classification"
  | "ai_structured_extraction"
  | "ai_summary"
  | "conditional"
  | "if"
  | "switch"
  | "delay"
  | "wait_until"
  | "email_notification"
  | "database_record"
  | "transform"
  | "data_store_get_record"
  | "data_store_upsert_record"
  | "data_store_delete_record"
  | "data_store_exists_record"
  | "data_store_count_records"
  | "data_store_list_records"
  | "set_variable"
  | "get_variable"
  | "delete_variable"
  | "increment_variable"
  | "append_variable"
  | "for_each"
  | "try_catch"
  | "execute_workflow"
  | "return_workflow_output"
  | "approval";

export type WorkflowVersionStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface WorkflowVersionSummary {
  id: string;
  versionNumber: number;
  status: WorkflowVersionStatus;
  createdAt: string;
  activatedAt?: string | null;
}

export interface WorkflowVersionHistoryItem extends WorkflowVersionSummary {
  publishedAt?: string | null;
  isActive: boolean;
  createdBy?: { id: string; email: string; name?: string | null };
  restoredFromVersion?: { id: string; versionNumber: number } | null;
  triggerHistoryAvailable: boolean;
}
export interface WorkflowVersionHistoryResponse { items: WorkflowVersionHistoryItem[]; pageSize: number; nextCursor: string | null; hasMore: boolean; }
export interface WorkflowFieldChange { fieldPath: string; changeType: "ADDED" | "REMOVED" | "MODIFIED"; before?: unknown; after?: unknown; sensitive?: boolean; changed?: true; }
export interface WorkflowVersionDiff { fromVersion: WorkflowVersionSummary; toVersion: WorkflowVersionSummary; triggerHistoryAvailable: boolean; summary: { maxSeverity: "SAFE" | "WARNING" | "BREAKING"; totalChanges: number; heuristic: true }; findings: Array<{ severity: "SAFE" | "WARNING" | "BREAKING"; code: string; message: string; stepKey?: string }>; groups: Record<string, unknown[]>; }
export interface WorkflowRestorePreview { possible: boolean; publishable: boolean; sourceVersion: WorkflowVersionSummary; currentActiveVersion: WorkflowVersionSummary | null; diffSummary: WorkflowVersionDiff["summary"] | null; breakingWarnings: WorkflowVersionDiff["findings"]; missingDependencies: Array<Record<string, unknown>>; invalidReferences: Array<Record<string, unknown>>; unverifiableReferences: Array<Record<string, unknown>>; triggerHistoryAvailable: boolean; }

export interface WorkflowStep {
  id: string;
  key: string;
  name: string;
  type: StepType | "webhook_trigger" | "subworkflow_trigger";
  position: number;
  configJson: Record<string, unknown>;
  retryPolicyJson?: Record<string, unknown> | null;
  timeoutSeconds?: number | null;
}

export interface WorkflowVersion extends WorkflowVersionSummary {
  definitionJson: WorkflowDefinitionDto;
  createdBy?: { id: string; email: string; name?: string | null };
  steps: WorkflowStep[];
}

export interface WorkflowDetail extends Workflow {
  versions: WorkflowVersion[];
}

export interface InvocableWorkflow {
  id: string;
  name: string;
  activeVersion: { id: string; versionNumber: number } | null;
  versions: Array<{ id: string; versionNumber: number; status: WorkflowVersionStatus }>;
}

export interface RetryPolicyDto {
  maxAttempts: number;
  backoffMs: number;
  strategy: "fixed" | "exponential";
}

export interface WorkflowStepDto {
  key: string;
  name: string;
  type: StepType | "webhook_trigger" | "subworkflow_trigger";
  config: Record<string, unknown>;
  retryPolicy?: RetryPolicyDto;
  timeoutSeconds?: number;
}

export interface WorkflowDefinitionDto {
  trigger: WorkflowStepDto;
  steps: WorkflowStepDto[];
  workflowDefinitionSchemaVersion?: 1 | 2;
  graph?: WorkflowGraphDto;
  ui?: WorkflowDefinitionUiDto;
  expressionMode?: "legacy" | "strict";
  workflowVariables?: Record<string, unknown>;
  environmentVariables?: Record<string, unknown>;
}

export interface WorkflowGraphDto {
  entryStepKey: string;
  edges: Array<{ from: string; to: string; kind: "next" | "if_true" | "if_false" | "switch_case" | "switch_default" | "for_each_body" | "for_each_done" | "try_body" | "try_catch" | "try_finally" | "try_done" | "approval_approved" | "approval_rejected" | "approval_expired"; label?: string; caseKey?: string }>;
  terminalStepKeys?: string[];
}

export interface WorkflowDefinitionUiDto {
  nodes?: Record<string, { x: number; y: number; collapsed?: boolean }>;
  viewport?: { x: number; y: number; zoom: number };
}

export type TestExternalMode = "mock" | "real";
export type WorkflowTestRunSource = "version" | "draft";
export type TestMockBehavior = "manual" | "simulated_success" | "simulated_error" | "simulated_timeout";
export type DebugNodeStatus = "active" | "completed" | "pending" | "skipped" | "failed" | "retrying" | "waiting" | "dlq";
export type DebugTimelineStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "RETRYING" | "WAITING" | "SKIPPED" | "FAILED" | "DLQ" | "CANCELLED";

export interface TestStepMock {
  behavior: TestMockBehavior;
  output?: unknown;
  error?: { message: string; code?: string };
  timeoutMs?: number;
  http?: { status: number; headers?: Record<string, string>; body?: unknown };
  ai?: { response: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface CreateWorkflowTestRunDto {
  workflowVersionId?: string;
  draftDefinition?: WorkflowDefinitionDto;
  payload: { trigger: Record<string, unknown>; metadata?: Record<string, unknown> };
  externalMode: TestExternalMode;
  stepMocks?: Record<string, TestStepMock>;
  compareWithLastReal?: boolean;
  realModeConfirmed?: boolean;
}

export interface DebugTimelineEvent {
  id: string;
  status: DebugTimelineStatus;
  stepKey?: string;
  timestamp: string;
  durationMs?: number | null;
  attempt?: number | null;
  message: string;
  nextRetryAt?: string | null;
}

export interface DebugStepInspector {
  stepKey: string;
  stepType: string;
  executionPath: string;
  iterationIndex: number | null;
  status: string;
  errorHandled: boolean;
  input: unknown;
  resolvedVariables: Array<{ path: string; original?: unknown; resolved: unknown; origin: string }>;
  expressions: Array<{ expression: string; result: unknown; type: string }>;
  resolvedConfig: unknown;
  output: unknown;
  durationMs: number | null;
  retry: { attempt: number; attemptCount: number; maxAttempts: number; nextRetryAt: string | null };
  error: unknown;
  connection: { id?: string; name?: string; type?: string; status?: string } | null;
  variable?: { operation?: string; scope?: string; name?: string; type?: string; exists?: boolean; summary?: unknown } | null;
}

export interface WorkflowTestRunSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string | null;
  executionId: string;
  status: string;
  externalMode: TestExternalMode;
  source: WorkflowTestRunSource;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdBy?: { id: string; email: string; name?: string | null };
}

export interface WorkflowTestRunDetail extends WorkflowTestRunSummary {
  payload: unknown;
  stepMocks: Record<string, TestStepMock>;
  sideEffectNodes: Array<{ key: string; name: string; type: string; realModeAllowed: boolean }>;
  timeline: DebugTimelineEvent[];
  graph: Record<string, DebugNodeStatus>;
  inspector: Record<string, DebugStepInspector>;
  comparison?: WorkflowTestRunComparison | null;
}

export interface WorkflowTestRunListResponse {
  items: WorkflowTestRunSummary[];
  total: number;
}

export interface WorkflowTestRunComparison {
  testRunId: string;
  realExecutionId: string | null;
  statusChanged: boolean;
  durationDeltaMs: number | null;
  steps: Array<{ stepKey: string; testStatus: string | null; realStatus: string | null; durationDeltaMs: number | null; outputShapeChanged: boolean }>;
}

export interface CreateWorkflowDto {
  name: string;
  description?: string;
}
