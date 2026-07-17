export type ConnectionType = "HTTP" | "SMTP" | "HTTP_API_KEY";
export type HttpAuthScheme = "API_KEY" | "BEARER" | "BASIC" | "CUSTOM_HEADERS";
export type ConnectionStatus = "ACTIVE" | "DISABLED" | "REVOKED" | "DELETED";

export interface ConnectionUsage {
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  versionNumber: number;
  stepKey: string;
  stepName: string;
}

export interface ConnectionSummary {
  id: string;
  type: ConnectionType;
  authScheme?: HttpAuthScheme;
  name: string;
  description?: string | null;
  status: ConnectionStatus;
  maskedCredential: string;
  credential?: string;
  config?: Record<string, unknown>;
  usageCount: number;
  usage?: ConnectionUsage[];
  lastTest?: {
    testedAt: string;
    status: string;
    statusCode?: number;
    durationMs?: number;
    message?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string | null;
}

export interface CreateHttpConnectionDto {
  type: "HTTP";
  authScheme: HttpAuthScheme;
  name: string;
  description?: string;
  baseUrl?: string;
  authLocation?: "HEADER" | "QUERY";
  authName?: string;
  username?: string;
  secretValue?: string;
  secretHeaders?: Record<string, string>;
  additionalHeaders?: Record<string, string>;
}

export interface CreateSmtpConnectionDto {
  type: "SMTP";
  name: string;
  description?: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName?: string;
  fromEmail: string;
}

export type CreateConnectionDto = CreateHttpConnectionDto | CreateSmtpConnectionDto;
