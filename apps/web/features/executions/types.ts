export type ExecutionStatus = "PENDING" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type PublicExecutionStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type StepStatus = ExecutionStatus | "SKIPPED" | "RETRYING";

export const EXECUTION_STATUSES: ExecutionStatus[] = ["PENDING", "QUEUED", "RUNNING", "RETRYING", "COMPLETED", "FAILED", "CANCELLED"];

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  correlationId?: string | null;
  status: ExecutionStatus;
  publicStatus: PublicExecutionStatus;
  workflowName?: string | null;
  workflow?: { id: string; name: string; status?: string } | null;
  workflowVersion?: { id: string; versionNumber: number; status?: string; createdAt?: string } | null;
  versionNumber?: number | null;
  mode?: "REAL" | "TEST";
  startedAt: string | null;
  completedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  durationMs?: number | null;
  initiator?: ExecutionActor | null;
  startedBy?: ExecutionActor | null;
  stepCount?: number;
  completedStepCount?: number;
  failedStepCount?: number;
  attempts?: number;
  cancelled?: boolean;
}

export interface ExecutionListResponse {
  items: ExecutionSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface StepExecutionDetail {
  id: string;
  workflowStepId: string;
  stepKey: string;
  stepType: string;
  executionPath: string;
  iterationIndex: number | null;
  status: StepStatus;
  publicStatus?: string;
  attempt: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  effectStatus: string | null;
  errorCategory: string | null;
  output: unknown;
  input?: unknown;
  error: unknown;
  providerMetadata?: unknown;
  startedAt: string | null;
  completedAt: string | null;
  finishedAt?: string | null;
  durationMs: number | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  workflow: { id: string; name: string; status: string };
  workflowVersion: { id: string; versionNumber: number; status: string; createdAt: string; definitionSchemaVersion?: number } | null;
  workflowSnapshot: { workflowVersionId: string; versionNumber: number; definitionSchemaVersion: number } | null;
  input: unknown;
  context: unknown;
  error: unknown;
  updatedAt: string;
  durationMs: number | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelRequestedBy: ExecutionActor | null;
  retryOfExecutionId: string | null;
  retryOfExecution: ExecutionRelation | null;
  retryExecutions: ExecutionRelation[];
  retryRequestedAt: string | null;
  retryReason: string | null;
  deadLetter: ExecutionDeadLetter | null;
  deadLetters: ExecutionDeadLetter[];
  steps: StepExecutionDetail[];
}

export interface ExecutionActor {
  id: string;
  display: string;
  email?: string | null;
  name?: string | null;
}

export interface ManualExecutionResponse {
  accepted: boolean;
  executionId: string;
  recoverable?: boolean;
  execution: {
    id: string;
    status: ExecutionStatus;
    publicStatus: PublicExecutionStatus;
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    correlationId: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
}

export interface CancelExecutionResponse {
  execution: {
    id: string;
    status: ExecutionStatus;
    publicStatus: PublicExecutionStatus;
    cancelledAt: string | null;
    cancelRequestedAt: string | null;
    finishedAt: string | null;
  };
}

export interface ExecutionRelation {
  id: string;
  status: ExecutionStatus;
  createdAt: string;
  completedAt: string | null;
  correlationId: string | null;
}

export interface ExecutionDeadLetter {
  id: string;
  reason: string;
  failedStepKey: string | null;
  attempts: number;
  active: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  retryExecutionId: string | null;
}
