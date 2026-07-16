export type ExecutionStatus = "PENDING" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type StepStatus = ExecutionStatus | "SKIPPED" | "RETRYING";

export const EXECUTION_STATUSES: ExecutionStatus[] = ["PENDING", "QUEUED", "RUNNING", "RETRYING", "COMPLETED", "FAILED", "CANCELLED"];

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  correlationId?: string | null;
  status: ExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
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
  status: StepStatus;
  attempt: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  effectStatus: string | null;
  errorCategory: string | null;
  output: unknown;
  error: unknown;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  workflow: { id: string; name: string; status: string };
  workflowVersion: { id: string; versionNumber: number; status: string; createdAt: string };
  input: unknown;
  context: unknown;
  error: unknown;
  updatedAt: string;
  durationMs: number | null;
  retryOfExecutionId: string | null;
  retryOfExecution: ExecutionRelation | null;
  retryExecutions: ExecutionRelation[];
  retryRequestedAt: string | null;
  retryReason: string | null;
  deadLetter: ExecutionDeadLetter | null;
  deadLetters: ExecutionDeadLetter[];
  steps: StepExecutionDetail[];
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
