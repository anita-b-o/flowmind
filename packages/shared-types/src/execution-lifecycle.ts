export type PublicExecutionStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type ExecutionStatusValue = "PENDING" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELLED";

const ExecutionStatusValues = {
  Pending: "PENDING",
  Queued: "QUEUED",
  Running: "RUNNING",
  Retrying: "RETRYING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED"
} as const;

export const ACTIVE_EXECUTION_STATUSES = [
  ExecutionStatusValues.Pending,
  ExecutionStatusValues.Queued,
  ExecutionStatusValues.Running,
  ExecutionStatusValues.Retrying
] as const;

export const TERMINAL_EXECUTION_STATUSES = [
  ExecutionStatusValues.Completed,
  ExecutionStatusValues.Failed,
  ExecutionStatusValues.Cancelled
] as const;

export const CANCELABLE_EXECUTION_STATUSES = ACTIVE_EXECUTION_STATUSES;
export const RETRYABLE_EXECUTION_STATUSES = [ExecutionStatusValues.Failed] as const;

const VALID_TRANSITIONS: Record<ExecutionStatusValue, ExecutionStatusValue[]> = {
  PENDING: ["QUEUED", "RUNNING", "FAILED", "CANCELLED"],
  QUEUED: ["RUNNING", "RETRYING", "FAILED", "CANCELLED"],
  RUNNING: ["RETRYING", "COMPLETED", "FAILED", "CANCELLED", "QUEUED"],
  RETRYING: ["QUEUED", "RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
};

export function publicExecutionStatus(status: ExecutionStatusValue | string): PublicExecutionStatus {
  switch (status) {
    case "PENDING":
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "RETRYING":
      return "waiting";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "failed";
  }
}

export function executionStatusFromPublic(status: PublicExecutionStatus | ExecutionStatusValue | string): ExecutionStatusValue | undefined {
  switch (status) {
    case "queued":
    case "PENDING":
    case "QUEUED":
      return "QUEUED";
    case "running":
    case "RUNNING":
      return "RUNNING";
    case "waiting":
    case "RETRYING":
      return "RETRYING";
    case "completed":
    case "COMPLETED":
      return "COMPLETED";
    case "failed":
    case "FAILED":
      return "FAILED";
    case "cancelled":
    case "CANCELLED":
      return "CANCELLED";
    default:
      return undefined;
  }
}

export function isTerminalExecutionStatus(status: ExecutionStatusValue | string) {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function isActiveExecutionStatus(status: ExecutionStatusValue | string) {
  return (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function isCancelableExecutionStatus(status: ExecutionStatusValue | string) {
  return (CANCELABLE_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function isRetryableExecutionStatus(status: ExecutionStatusValue | string) {
  return (RETRYABLE_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function canTransitionExecution(from: ExecutionStatusValue | string, to: ExecutionStatusValue | string) {
  return VALID_TRANSITIONS[from as ExecutionStatusValue]?.includes(to as ExecutionStatusValue) ?? false;
}
