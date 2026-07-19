export type ExecutionTriggerType = "manual" | "webhook" | "scheduled" | "event" | "subworkflow" | "retry" | "replay";
export type ExecutionReplayModeValue = "FULL_REPLAY" | "RETRY_FROM_FAILURE";
export type ReplaySafetyClass = "PURE" | "READ_ONLY" | "SIDE_EFFECT" | "WAITING_CONTROL";
export interface ReplayStepSummary { stepKey: string; stepType: string; executionPath: string; iterationIndex: number | null; safety: ReplaySafetyClass; }
export interface ExecutionReplayPreview {
  possible: boolean;
  mode: ExecutionReplayModeValue;
  sourceExecutionId: string;
  originalExecutionId: string;
  workflowVersionId: string | null;
  startingPoint: { stepKey: string; executionPath: string; iterationIndex: number | null } | null;
  startingStep: { stepKey: string; executionPath: string; iterationIndex: number | null } | null;
  reusedSteps: ReplayStepSummary[];
  reexecutedSteps: ReplayStepSummary[];
  sideEffects: ReplayStepSummary[];
  sideEffectWarnings: string[];
  warnings: string[];
  missingCheckpointData: string[];
  blockedReasons: string[];
  reason: string | null;
}
export type ExecutionRelationship = "root" | "child";

export interface SafeExecutionError {
  category: string;
  code: string;
  messageSafe: string;
}

export interface ExecutionTimelineEvent {
  id: string;
  type: string;
  timestamp: string;
  status?: string;
  stepExecutionId?: string;
  stepKey?: string;
  executionPath?: string;
  iterationIndex?: number | null;
  attempt?: number;
  durationMs?: number | null;
  waitReason?: string | null;
  relatedExecutionId?: string;
  approvalId?: string;
  reusedFromExecutionId?: string;
  reusedFromStepExecutionId?: string;
  message: string;
}

export interface SafeEventCausality {
  eventType: string;
  correlationId: string;
  rootEventId: string;
  causationId: string | null;
  depth: number;
  deliveryStatus: string;
  triggerId: string;
}

export interface SafeNotificationSummary {
  id: string;
  type: string;
  channel: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  sentAt: string | null;
  failedAt: string | null;
  errorCategory: string | null;
  errorMessageSafe: string | null;
}
