export type ExecutionStatus = "PENDING" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type StepStatus = ExecutionStatus | "SKIPPED" | "RETRYING";

export const EXECUTION_STATUSES: ExecutionStatus[] = ["PENDING", "QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"];

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string;
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
  steps: StepExecutionDetail[];
}
