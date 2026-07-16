export enum OrganizationRole {
  Owner = "owner",
  Admin = "admin",
  Editor = "editor",
  Viewer = "viewer"
}

export enum WorkflowStatus {
  Draft = "DRAFT",
  Active = "ACTIVE",
  Paused = "PAUSED",
  Archived = "ARCHIVED"
}

export enum WorkflowVersionStatus {
  Draft = "DRAFT",
  Active = "ACTIVE",
  Archived = "ARCHIVED"
}

export enum ExecutionStatus {
  Pending = "PENDING",
  Queued = "QUEUED",
  Running = "RUNNING",
  Retrying = "RETRYING",
  Completed = "COMPLETED",
  Failed = "FAILED",
  Cancelled = "CANCELLED"
}

export enum StepExecutionStatus {
  Pending = "PENDING",
  Running = "RUNNING",
  Completed = "COMPLETED",
  Failed = "FAILED",
  Skipped = "SKIPPED",
  Retrying = "RETRYING"
}

export enum StepType {
  WebhookTrigger = "webhook_trigger",
  HttpRequest = "http_request",
  AiClassification = "ai_classification",
  AiStructuredExtraction = "ai_structured_extraction",
  AiSummary = "ai_summary",
  Conditional = "conditional",
  EmailNotification = "email_notification",
  DatabaseRecord = "database_record"
}

export type JsonObject = Record<string, unknown>;

export interface RetryPolicyDefinition {
  maxAttempts: number;
  backoffMs: number;
  strategy: "fixed" | "exponential";
}

export interface WorkflowStepDefinition {
  id?: string;
  key: string;
  name: string;
  type: StepType;
  position: number;
  config: JsonObject;
  retryPolicy?: RetryPolicyDefinition;
  timeoutSeconds?: number;
}

export interface WorkflowDefinition {
  trigger: WorkflowStepDefinition;
  steps: WorkflowStepDefinition[];
}

export interface ExecutionContext {
  trigger: JsonObject;
  steps: Record<string, { output: unknown; status: StepExecutionStatus }>;
  metadata: JsonObject;
}

export interface StepResult {
  status: StepExecutionStatus.Completed | StepExecutionStatus.Skipped;
  output: unknown;
  control?: {
    skipNext?: boolean;
  };
}

export interface ExecutionJobPayload {
  organizationId: string;
  executionId: string;
  workflowId: string;
  workflowVersionId: string;
  requestId: string;
}
