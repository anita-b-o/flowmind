import { Injectable } from "@nestjs/common";
import { ConnectionType, HttpAuthLocation } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { NonRetryableStepError } from "../engine/step-errors";
import { ConnectionCryptoService } from "./connection-crypto.service";

export type ResolvedHttpApiKeyConnection = {
  id: string;
  type: ConnectionType.HttpApiKey;
  baseUrl?: string;
  authLocation: HttpAuthLocation;
  authName: string;
  secretValue: string;
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

  async resolveHttpApiKey(organizationId: string, connectionId: string): Promise<ResolvedHttpApiKeyConnection> {
    const { connection, secret } = await this.load(organizationId, connectionId, "http_api_key");
    const config = asRecord(connection.configJson);
    const authLocation = config.authLocation === HttpAuthLocation.Query ? HttpAuthLocation.Query : HttpAuthLocation.Header;
    const authName = stringField(config.authName, "HTTP connection authName is invalid");
    return {
      id: connection.id,
      type: ConnectionType.HttpApiKey,
      baseUrl: typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl : undefined,
      authLocation,
      authName,
      secretValue: this.decrypt(secret.encryptedValue),
      additionalHeaders: asStringRecord(config.additionalHeaders)
    };
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
    const connection = await this.prisma.connection.findFirst({
      where: { id: connectionId, organizationId, deletedAt: null }
    });
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
