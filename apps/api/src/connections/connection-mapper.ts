import { ConnectionStatus, ConnectionType } from "@automation/shared-types";

export function toPrismaConnectionType(type: ConnectionType) {
  return type === ConnectionType.HttpApiKey ? "http_api_key" : "smtp";
}

export function fromPrismaConnectionType(type: string) {
  return type === "http_api_key" ? ConnectionType.HttpApiKey : ConnectionType.Smtp;
}

export function mapConnection(connection: {
  id: string;
  type: string;
  name: string;
  description: string | null;
  status: string;
  configJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}) {
  const type = fromPrismaConnectionType(connection.type);
  const config = asRecord(connection.configJson);
  return {
    id: connection.id,
    type,
    name: connection.name,
    description: connection.description,
    status: connection.status as ConnectionStatus,
    credential: maskedCredential(type, config),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    rotatedAt: connection.rotatedAt
  };
}

function maskedCredential(type: ConnectionType, config: Record<string, unknown>) {
  if (type === ConnectionType.HttpApiKey) {
    return `${String(config.authName ?? "api key")}: ****`;
  }
  return maskEmail(String(config.fromEmail ?? config.username ?? "smtp"));
}

function maskEmail(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "****";
  return `${local.slice(0, 2)}****@${domain}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
