export type ExecutionTriggerType = "manual" | "webhook" | "scheduled" | "event" | "subworkflow" | "retry";
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
