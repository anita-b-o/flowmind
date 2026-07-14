export interface TriggerSummary {
  id: string;
  type: string;
  workflowId: string;
  enabled: boolean;
  tokenAvailable: false;
  createdAt: string;
  rotatedAt: string | null;
}

export interface TriggerSecret extends Omit<TriggerSummary, "tokenAvailable"> {
  tokenAvailable: true;
  token: string;
  webhookUrl: string;
}
