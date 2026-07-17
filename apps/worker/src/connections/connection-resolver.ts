import { Injectable } from "@nestjs/common";
import { ConnectionType, HttpAuthLocation, HttpAuthScheme } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { NonRetryableStepError } from "../engine/step-errors";
import { ConnectionCryptoService } from "./connection-crypto.service";

export type ResolvedHttpConnection = {
  id: string;
  type: ConnectionType.Http;
  authScheme: HttpAuthScheme;
  baseUrl?: string;
  authLocation?: HttpAuthLocation;
  authName?: string;
  username?: string;
  secretValue?: string;
  secretHeaders?: Record<string, string>;
  additionalHeaders: Record<string, string>;
};

export type ResolvedSmtpConnection = {
  id: string;
  type: ConnectionType.Smtp;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName?: string;
  fromEmail: string;
};

@Injectable()
export class ConnectionResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ConnectionCryptoService
  ) {}

  async resolveHttp(organizationId: string, connectionId: string): Promise<ResolvedHttpConnection> {
    const { connection, secret } = await this.load(organizationId, connectionId, "http_api_key");
    const config = asRecord(connection.configJson);
    const authScheme = httpAuthScheme(config);
    const plaintext = this.decrypt(secret.encryptedValue);
    const resolved: ResolvedHttpConnection = {
      id: connection.id,
      type: ConnectionType.Http,
      authScheme,
      baseUrl: typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl : undefined,
      additionalHeaders: asStringRecord(config.additionalHeaders)
    };
    if (authScheme === HttpAuthScheme.ApiKey) {
      resolved.authLocation = config.authLocation === HttpAuthLocation.Query ? HttpAuthLocation.Query : HttpAuthLocation.Header;
      resolved.authName = stringField(config.authName, "HTTP connection authName is invalid");
      resolved.secretValue = plaintext;
    } else if (authScheme === HttpAuthScheme.BearerToken) {
      resolved.secretValue = plaintext;
    } else if (authScheme === HttpAuthScheme.BasicAuth) {
      resolved.username = stringField(config.username, "HTTP Basic username is invalid");
      resolved.secretValue = plaintext;
    } else if (authScheme === HttpAuthScheme.CustomHeaders) {
      resolved.secretHeaders = parseSecretHeaders(plaintext);
    } else {
      throw new NonRetryableStepError("CONNECTION_TYPE_MISMATCH");
    }
    return resolved;
  }

  async resolveHttpApiKey(organizationId: string, connectionId: string): Promise<ResolvedHttpConnection> {
    return this.resolveHttp(organizationId, connectionId);
  }

  async resolveSmtp(organizationId: string, connectionId: string): Promise<ResolvedSmtpConnection> {
    const { connection, secret } = await this.load(organizationId, connectionId, "smtp");
    const config = asRecord(connection.configJson);
    return {
      id: connection.id,
      type: ConnectionType.Smtp,
      host: stringField(config.host, "SMTP host is invalid"),
      port: Number(config.port),
      secure: config.secure === true,
      username: stringField(config.username, "SMTP username is invalid"),
      password: this.decrypt(secret.encryptedValue),
      fromName: typeof config.fromName === "string" ? config.fromName : undefined,
      fromEmail: stringField(config.fromEmail, "SMTP fromEmail is invalid")
    };
  }

  private async load(organizationId: string, connectionId: string, type: "http_api_key" | "smtp") {
    const connection = await this.prisma.connection.findFirst({ where: { id: connectionId, organizationId, deletedAt: null } });
    if (!connection) throw new NonRetryableStepError("CONNECTION_NOT_FOUND");
    if (connection.status !== "ACTIVE") throw new NonRetryableStepError("CONNECTION_REVOKED");
    if (connection.type !== type) throw new NonRetryableStepError("CONNECTION_TYPE_MISMATCH");
    const secret = await this.prisma.secret.findFirst({ where: { organizationId, connectionId, status: "ACTIVE" } });
    if (!secret) throw new NonRetryableStepError("INVALID_CONNECTION_CONFIG");
    return { connection, secret };
  }

  private decrypt(encryptedValue: string) {
    try {
      return this.crypto.decrypt(encryptedValue);
    } catch {
      throw new NonRetryableStepError("CONNECTION_DECRYPTION_FAILED");
    }
  }
}

function httpAuthScheme(config: Record<string, unknown>) {
  const value = String(config.authScheme ?? "");
  if (Object.values(HttpAuthScheme).includes(value as HttpAuthScheme)) return value as HttpAuthScheme;
  if (value === "BEARER_TOKEN") return HttpAuthScheme.BearerToken;
  if (value === "BASIC_AUTH") return HttpAuthScheme.BasicAuth;
  return HttpAuthScheme.ApiKey;
}

function parseSecretHeaders(secret: string) {
  try {
    return asStringRecord(JSON.parse(secret));
  } catch {
    throw new NonRetryableStepError("INVALID_CONNECTION_CONFIG");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringField(value: unknown, message: string) {
  if (typeof value !== "string" || !value) throw new NonRetryableStepError(message);
  return value;
}
