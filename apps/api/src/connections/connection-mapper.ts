import { ConnectionStatus, ConnectionType, HttpAuthLocation, HttpAuthScheme } from "@automation/shared-types";

export type ConnectionUsage = {
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  versionNumber: number;
  stepKey: string;
  stepName: string;
};

export function toPrismaConnectionType(type: ConnectionType) {
  return type === ConnectionType.Smtp ? "smtp" : "http_api_key";
}

export function fromPrismaConnectionType(type: string) {
  return type === "smtp" ? ConnectionType.Smtp : ConnectionType.Http;
}

export function httpAuthScheme(configJson: unknown) {
  const config = asRecord(configJson);
  const value = String(config.authScheme ?? "");
  if (Object.values(HttpAuthScheme).includes(value as HttpAuthScheme)) return value as HttpAuthScheme;
  if (value === "BEARER_TOKEN") return HttpAuthScheme.BearerToken;
  if (value === "BASIC_AUTH") return HttpAuthScheme.BasicAuth;
  return HttpAuthScheme.ApiKey;
}

export function mapConnection(
  connection: {
    id: string;
    type: string;
    name: string;
    description: string | null;
    status: string;
    configJson: unknown;
    createdAt: Date;
    updatedAt: Date;
    rotatedAt: Date | null;
    lastTestedAt?: Date | null;
    lastTestStatus?: string | null;
    lastTestStatusCode?: number | null;
    lastTestDurationMs?: number | null;
    lastTestMessage?: string | null;
  },
  usage: ConnectionUsage[] = []
) {
  const type = fromPrismaConnectionType(connection.type);
  const config = asRecord(connection.configJson);
  const authScheme = type === ConnectionType.Http ? httpAuthScheme(config) : undefined;
  return {
    id: connection.id,
    type,
    authScheme,
    name: connection.name,
    description: connection.description,
    status: connection.status as ConnectionStatus,
    maskedCredential: maskedCredential(type, authScheme, config),
    credential: maskedCredential(type, authScheme, config),
    config: safeConfig(type, config),
    usageCount: usage.length,
    usage,
    lastTest: connection.lastTestedAt
      ? {
          testedAt: connection.lastTestedAt,
          status: connection.lastTestStatus ?? "UNKNOWN",
          statusCode: connection.lastTestStatusCode ?? undefined,
          durationMs: connection.lastTestDurationMs ?? undefined,
          message: connection.lastTestMessage ?? undefined
        }
      : null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    rotatedAt: connection.rotatedAt
  };
}

function safeConfig(type: ConnectionType, config: Record<string, unknown>) {
  if (type === ConnectionType.Smtp) {
    return {
      host: stringOrUndefined(config.host),
      port: typeof config.port === "number" ? config.port : Number(config.port || 0) || undefined,
      secure: config.secure === true,
      username: stringOrUndefined(config.username),
      fromName: stringOrUndefined(config.fromName),
      fromEmail: stringOrUndefined(config.fromEmail)
    };
  }
  const authScheme = httpAuthScheme(config);
  return {
    authScheme,
    baseUrl: stringOrUndefined(config.baseUrl),
    authLocation: config.authLocation === HttpAuthLocation.Query ? HttpAuthLocation.Query : HttpAuthLocation.Header,
    authName: stringOrUndefined(config.authName),
    username: authScheme === HttpAuthScheme.BasicAuth ? stringOrUndefined(config.username) : undefined,
    publicHeaders: asStringRecord(config.additionalHeaders),
    secretHeaderNames: Object.keys(asStringRecord(config.secretHeaderPreviews))
  };
}

function maskedCredential(type: ConnectionType, authScheme: HttpAuthScheme | undefined, config: Record<string, unknown>) {
  if (type === ConnectionType.Smtp) return maskEmail(String(config.fromEmail ?? config.username ?? "smtp"));
  if (authScheme === HttpAuthScheme.BearerToken) return `Authorization: Bearer ${secretPreview(config.secretPreview)}`;
  if (authScheme === HttpAuthScheme.BasicAuth) return `${String(config.username ?? "user")}: ${secretPreview(config.secretPreview)}`;
  if (authScheme === HttpAuthScheme.CustomHeaders) {
    const previews = asStringRecord(config.secretHeaderPreviews);
    const names = Object.keys(previews);
    return names.length ? names.map((name) => `${name}: ${previews[name]}`).join(", ") : "Custom headers: ********";
  }
  return `${String(config.authName ?? "api key")}: ${secretPreview(config.secretPreview)}`;
}

function secretPreview(value: unknown) {
  return typeof value === "string" && value ? value : "********";
}

function maskEmail(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "********";
  return `${local.slice(0, 2)}****@${domain}`;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
