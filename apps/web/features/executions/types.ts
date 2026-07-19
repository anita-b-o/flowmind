export type ExecutionStatus = "PENDING" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type PublicExecutionStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type StepStatus = ExecutionStatus | "SKIPPED" | "RETRYING" | "REUSED";
export type ExecutionReplayMode = "FULL_REPLAY" | "RETRY_FROM_FAILURE";
export interface ReplayStepSummary { stepKey: string; stepType: string; executionPath: string; iterationIndex: number | null; safety: "PURE" | "READ_ONLY" | "SIDE_EFFECT" | "WAITING_CONTROL"; }
export interface ExecutionReplayPreview { possible: boolean; mode: ExecutionReplayMode; sourceExecutionId: string; originalExecutionId: string; workflowVersionId: string | null; startingPoint: { stepKey: string; executionPath: string; iterationIndex: number | null } | null; startingStep: { stepKey: string; executionPath: string; iterationIndex: number | null } | null; reusedSteps: ReplayStepSummary[]; reexecutedSteps: ReplayStepSummary[]; sideEffects: ReplayStepSummary[]; warnings: string[]; sideEffectWarnings: string[]; missingCheckpointData: string[]; blockedReasons: string[]; reason: string | null; }

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
  waitReason?: string | null;
  triggerType?: "manual" | "webhook" | "scheduled" | "event" | "subworkflow" | "retry" | "replay";
  replayOfExecutionId?: string | null;
  replayMode?: ExecutionReplayMode | null;
  replayFromStepKey?: string | null;
  replayFromExecutionPath?: string | null;
  replayFromIterationIndex?: number | null;
  relationship?: "root" | "child";
  parentExecutionId?: string | null;
  rootExecutionId?: string;
  depth?: number;
  failedStep?: { stepKey: string; errorHandled: boolean; errorCategory: string | null } | null;
}

export interface ExecutionListResponse {
  items: ExecutionSummary[];
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface StepExecutionDetail {
  id: string;
  workflowStepId: string;
  stepKey: string;
  stepType: string;
  executionPath: string;
  iterationIndex: number | null;
  status: StepStatus;
  errorHandled: boolean;
  publicStatus?: string;
  attempt: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  effectStatus: string | null;
  errorCategory: string | null;
  error: unknown;
  artifact?: unknown;
  payloads?: unknown;
  startedAt: string | null;
  completedAt: string | null;
  finishedAt?: string | null;
  durationMs: number | null;
  reused?: boolean;
  reusedFromExecutionId?: string;
  reusedFromStepExecutionId?: string;
}

export interface ExecutionDetail extends ExecutionSummary {
  workflow: { id: string; name: string; status: string };
  workflowVersion: { id: string; versionNumber: number; status: string; createdAt: string; definitionSchemaVersion?: number } | null;
  workflowSnapshot: { workflowVersionId: string; versionNumber: number; definitionSchemaVersion: number } | null;
  payloads: unknown;
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
  replayOfExecution: ExecutionRelation | null;
  replayExecutions: ExecutionRelation[];
  deadLetter: ExecutionDeadLetter | null;
  deadLetters: ExecutionDeadLetter[];
  steps: StepExecutionDetail[];
  parentExecutionId: string | null;
  parentStepExecutionId: string | null;
  rootExecutionId: string;
  depth: number;
  parentExecution: { id: string; status: ExecutionStatus; workflowId: string; completedAt: string | null } | null;
  parentStepExecution: { id: string; stepKey: string; executionPath: string } | null;
  childExecutions: Array<{ id: string; status: ExecutionStatus; workflowId: string; workflowVersionId: string; depth: number; createdAt: string; startedAt: string | null; completedAt: string | null }>;
  approvals: Array<{ id: string; status: string; title: string; requestedAt: string; expiresAt: string | null; decidedAt: string | null; decidedByUserId: string | null; stepKey: string; executionPath: string; iterationIndex: number | null }>;
  eventCausality: { eventType: string; correlationId: string; rootEventId: string; causationId: string | null; depth: number; deliveryStatus: string; triggerId: string } | null;
  notifications: Array<{ id: string; type: string; channel: string; status: string; attempts: number; createdAt: string; updatedAt: string; lastAttemptAt: string | null; sentAt: string | null; failedAt: string | null; errorCategory: string | null; errorMessageSafe: string | null }>;
}

export interface ExecutionTimelineEvent { id: string; type: string; timestamp: string; status?: string; stepExecutionId?: string; stepKey?: string; executionPath?: string; iterationIndex?: number | null; attempt?: number; durationMs?: number | null; waitReason?: string | null; relatedExecutionId?: string; approvalId?: string; reusedFromExecutionId?: string; reusedFromStepExecutionId?: string; message: string }
export interface ExecutionTimelineResponse { items: ExecutionTimelineEvent[]; nextCursor: string | null; hasMore: boolean }

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
