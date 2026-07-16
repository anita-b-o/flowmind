export type ConnectionType = "HTTP_API_KEY" | "SMTP";
export type ConnectionStatus = "ACTIVE" | "DISABLED" | "REVOKED" | "DELETED";

export interface ConnectionSummary {
  id: string;
  type: ConnectionType;
  name: string;
  description?: string | null;
  status: ConnectionStatus;
  credential: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string | null;
}

export interface CreateHttpApiKeyConnectionDto {
  type: "HTTP_API_KEY";
  name: string;
  description?: string;
  baseUrl?: string;
  authLocation: "HEADER" | "QUERY";
  authName: string;
  secretValue: string;
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

export type CreateConnectionDto = CreateHttpApiKeyConnectionDto | CreateSmtpConnectionDto;
