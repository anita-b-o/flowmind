import type { DeadLetterReason } from "./reasons";

export type DeadLetterStatusFilter = "active" | "resolved" | "";

export interface DeadLetterSummary {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  workflowVersionId: string;
  failedStepKey: string | null;
  reason: DeadLetterReason;
  attempts: number;
  active: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  retryExecutionId: string | null;
  correlationId: string | null;
}

export interface DeadLetterListResponse {
  items: DeadLetterSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PublicError {
  category: string;
  code: string;
  message: string;
}

export interface DeadLetterDetail extends DeadLetterSummary {
  failedStepExecutionId: string | null;
  workflow: { id: string; name: string; status: string };
  workflowVersion: { id: string; versionNumber: number; status: string; createdAt: string };
  execution: {
    id: string;
    status: string;
    workflowId: string;
    workflowVersionId: string;
    correlationId: string | null;
    retryOfExecutionId: string | null;
    retryRequestedAt: string | null;
    retryReason: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    createdAt: string;
    updatedAt: string;
  };
  lastError: PublicError;
  lastErrorMetadata: unknown;
  retryExecution: {
    id: string;
    status: string;
    retryOfExecutionId: string | null;
    correlationId: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
}

export interface RetryExecutionResponse {
  execution: {
    id: string;
    status: string;
    retryOfExecutionId: string;
    correlationId: string | null;
  };
}
