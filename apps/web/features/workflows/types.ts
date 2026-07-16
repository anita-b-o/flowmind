export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  activeVersionId?: string | null;
  activeVersion?: WorkflowVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type StepType =
  | "http_request"
  | "ai_classification"
  | "ai_structured_extraction"
  | "ai_summary"
  | "conditional"
  | "if"
  | "switch"
  | "delay"
  | "wait_until"
  | "email_notification"
  | "database_record";

export type WorkflowVersionStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface WorkflowVersionSummary {
  id: string;
  versionNumber: number;
  status: WorkflowVersionStatus;
  createdAt: string;
  activatedAt?: string | null;
}

export interface WorkflowStep {
  id: string;
  key: string;
  name: string;
  type: StepType | "webhook_trigger";
  position: number;
  configJson: Record<string, unknown>;
  retryPolicyJson?: Record<string, unknown> | null;
  timeoutSeconds?: number | null;
}

export interface WorkflowVersion extends WorkflowVersionSummary {
  definitionJson: WorkflowDefinitionDto;
  createdBy?: { id: string; email: string; name?: string | null };
  steps: WorkflowStep[];
}

export interface WorkflowDetail extends Workflow {
  versions: WorkflowVersion[];
}

export interface RetryPolicyDto {
  maxAttempts: number;
  backoffMs: number;
  strategy: "fixed" | "exponential";
}

export interface WorkflowStepDto {
  key: string;
  name: string;
  type: StepType | "webhook_trigger";
  config: Record<string, unknown>;
  retryPolicy?: RetryPolicyDto;
  timeoutSeconds?: number;
}

export interface WorkflowDefinitionDto {
  trigger: WorkflowStepDto;
  steps: WorkflowStepDto[];
  workflowDefinitionSchemaVersion?: 1 | 2;
  graph?: WorkflowGraphDto;
  expressionMode?: "legacy" | "strict";
  workflowVariables?: Record<string, unknown>;
}

export interface WorkflowGraphDto {
  entryStepKey: string;
  edges: Array<{ from: string; to: string; kind: "next" | "if_true" | "if_false" | "switch_case" | "switch_default"; label?: string; caseKey?: string }>;
  terminalStepKeys?: string[];
}

export interface CreateWorkflowDto {
  name: string;
  description?: string;
}
