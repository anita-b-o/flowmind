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

export enum ExecutionMode {
  Real = "REAL",
  Test = "TEST"
}

export enum StepType {
  WebhookTrigger = "webhook_trigger",
  HttpRequest = "http_request",
  AiClassification = "ai_classification",
  AiStructuredExtraction = "ai_structured_extraction",
  AiSummary = "ai_summary",
  Conditional = "conditional",
  If = "if",
  Switch = "switch",
  Delay = "delay",
  WaitUntil = "wait_until",
  EmailNotification = "email_notification",
  DatabaseRecord = "database_record",
  Transform = "transform",
  DataStoreGetRecord = "data_store_get_record",
  DataStoreUpsertRecord = "data_store_upsert_record",
  DataStoreDeleteRecord = "data_store_delete_record",
  DataStoreExistsRecord = "data_store_exists_record",
  DataStoreCountRecords = "data_store_count_records",
  DataStoreListRecords = "data_store_list_records",
  SetVariable = "set_variable",
  GetVariable = "get_variable",
  DeleteVariable = "delete_variable",
  IncrementVariable = "increment_variable",
  AppendVariable = "append_variable"
}

export enum ConnectionType {
  Http = "HTTP",
  HttpApiKey = "HTTP_API_KEY",
  Smtp = "SMTP"
}

export enum ConnectionStatus {
  Active = "ACTIVE",
  Disabled = "DISABLED",
  Revoked = "REVOKED",
  Deleted = "DELETED"
}

export enum HttpAuthLocation {
  Header = "HEADER",
  Query = "QUERY"
}

export enum HttpAuthScheme {
  ApiKey = "API_KEY",
  BearerToken = "BEARER",
  BasicAuth = "BASIC",
  CustomHeaders = "CUSTOM_HEADERS"
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
  workflowDefinitionSchemaVersion?: 1 | 2;
  graph?: WorkflowGraphDefinition;
  ui?: WorkflowDefinitionUi;
}

export type WorkflowGraphEdgeKind = "next" | "if_true" | "if_false" | "switch_case" | "switch_default";

export interface WorkflowGraphEdgeDefinition {
  from: string;
  to: string;
  kind: WorkflowGraphEdgeKind;
  label?: string;
  caseKey?: string;
}

export interface WorkflowGraphDefinition {
  entryStepKey: string;
  edges: WorkflowGraphEdgeDefinition[];
  terminalStepKeys?: string[];
}

export interface WorkflowDefinitionUi {
  nodes?: Record<string, { x: number; y: number; collapsed?: boolean }>;
  viewport?: { x: number; y: number; zoom: number };
}

export interface ExecutionContext {
  trigger: JsonObject;
  steps: Record<string, { output: unknown; status: StepExecutionStatus }>;
  variables?: JsonObject;
  metadata: JsonObject;
  workflow?: JsonObject;
  execution?: JsonObject;
  organization?: JsonObject;
  connection?: JsonObject;
  system?: JsonObject;
  timestamp?: string;
  item?: unknown;
  index?: number;
}

export type ExpressionMode = "legacy" | "strict";

export interface WorkflowDefinitionMetadata {
  workflowDefinitionSchemaVersion?: 1 | 2;
  expressionMode?: ExpressionMode;
  workflowVariables?: JsonObject;
  environmentVariables?: JsonObject;
  graph?: WorkflowGraphDefinition;
  ui?: WorkflowDefinitionUi;
}

export interface StepResult {
  status: StepExecutionStatus.Completed | StepExecutionStatus.Skipped;
  output: unknown;
  control?: {
    skipNext?: boolean;
    nextStepKey?: string;
    waitUntil?: string;
    waitReason?: "delay" | "wait_until";
  };
}

export interface ExecutionJobPayload {
  organizationId: string;
  executionId: string;
  workflowId: string;
  workflowVersionId?: string;
  requestId: string;
  correlationId: string;
  enqueuedAt: string;
  executionMode?: ExecutionMode | "REAL" | "TEST";
  testRunId?: string;
}

export interface ScheduledTriggerJobPayload {
  organizationId: string;
  triggerId: string;
}

export * from "./test-runs";
export * from "./graph-validation";
export * from "./execution-lifecycle";
export * from "./transform-step";
export * from "./data-store";
export * from "./workflow-variables";
