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
