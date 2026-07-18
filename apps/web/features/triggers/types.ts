export interface TriggerSummary {
  id: string;
  type: string;
  workflowId: string;
  enabled: boolean;
  method: string;
  httpMethod: string;
  tokenPreview: string | null;
  maskedWebhookUrl: string;
  tokenAvailable: false;
  createdAt: string;
  rotatedAt: string | null;
  lastReceivedAt: string | null;
  lastExecutionId: string | null;
  config: WebhookTriggerConfig;
}

export interface TriggerSecret extends Omit<TriggerSummary, "tokenAvailable"> {
  tokenAvailable: true;
  token: string;
  webhookUrl: string;
  signatureSecret?: string;
  signatureSecretAvailable?: boolean;
}

export interface WebhookTriggerConfig {
  name: string;
  idempotencyHeader: string;
  payloadLimits: {
    maxBytes: number;
    maxDepth: number;
    maxKeys: number;
    maxArrayLength: number;
    maxStringLength: number;
    requireBody: boolean;
  };
  signature: {
    enabled: boolean;
    algorithm: string;
    signatureHeader: string;
    timestampHeader: string;
    nonceHeader: string;
    toleranceSeconds: number;
    secretAvailable: boolean;
  };
  metadata?: Record<string, unknown>;
}

export type UpdateWebhookTriggerInput = Partial<{
  name: string;
  idempotencyHeader: string;
  payloadLimits: Partial<WebhookTriggerConfig["payloadLimits"]>;
  signature: Partial<Omit<WebhookTriggerConfig["signature"], "algorithm" | "secretAvailable">>;
}>;

export interface ScheduledTriggerSummary {
  id: string;
  type: "scheduled";
  workflowId: string;
  enabled: boolean;
  paused: boolean;
  cron: string;
  timezone: string;
  executionPolicy: "skip_if_running";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastExecutionId: string | null;
}

export interface ScheduledTriggerInput {
  cron: string;
  timezone: string;
  enabled?: boolean;
  paused?: boolean;
  executionPolicy?: "skip_if_running";
  metadata?: Record<string, unknown>;
}

export interface ScheduledTriggerPreview {
  cron: string;
  timezone: string;
  nextRuns: string[];
}

export type InternalEventType = "DATA_STORE_RECORD_CREATED" | "DATA_STORE_RECORD_UPDATED" | "DATA_STORE_RECORD_DELETED" | "EXECUTION_COMPLETED" | "EXECUTION_FAILED" | "APPROVAL_APPROVED" | "APPROVAL_REJECTED" | "APPROVAL_EXPIRED";
export interface EventTriggerSummary {
  id: string; type: "event"; workflowId: string; eventType: InternalEventType; enabled: boolean; name: string;
  filters: { dataStoreId?: string; keyPrefix?: string; workflowId?: string; origin?: "manual" | "webhook" | "scheduled" | "event" | "subworkflow" | "retry" };
  createdAt: string; updatedAt: string; lastReceivedAt: string | null; lastExecutionId: string | null;
}
export interface EventTriggerInput { name: string; eventType: InternalEventType; enabled?: boolean; filters?: EventTriggerSummary["filters"]; }
