import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConnectionStatus, ConnectionType, HttpAuthLocation, HttpAuthScheme, OrganizationRole } from "@automation/shared-types";
import nodemailer from "nodemailer";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConnectionCryptoService } from "../secrets/connection-crypto.service";
import { CreateConnectionDto } from "./dto/create-connection.dto";
import { ListConnectionsQueryDto } from "./dto/list-connections-query.dto";
import { RotateConnectionSecretDto } from "./dto/rotate-connection-secret.dto";
import { TestConnectionDto } from "./dto/test-connection.dto";
import { UpdateConnectionDto } from "./dto/update-connection.dto";
import { connectionInUse, connectionNotFound, connectionTestFailed, invalidConnectionConfig, insufficientConnectionRole } from "./connection-errors";
import { httpAuthScheme, mapConnection, toPrismaConnectionType, type ConnectionUsage } from "./connection-mapper";
import { SafeConnectionTestClient } from "./safe-connection-test-client";

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-authenticate"
]);
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const TEST_LIMIT_WINDOW_MS = 60_000;
const TEST_LIMIT_MAX = 20;
const testCounters = new Map<string, { count: number; resetAt: number }>();

type NormalizedConnection = {
  type: ConnectionType.Http | ConnectionType.Smtp;
  authScheme?: HttpAuthScheme;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  secret: string;
};

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ConnectionCryptoService,
    private readonly testClient: SafeConnectionTestClient,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async list(organizationId: string, userId: string, query: ListConnectionsQueryDto = {}) {
    const role = await this.roleFor(organizationId, userId);
    assertCanList(role);
    const where: Prisma.ConnectionWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.type ? { type: toPrismaConnectionType(query.type) as any } : {}),
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { description: { contains: query.q, mode: "insensitive" } }
            ]
          }
        : {})
    };
    const [connections, usageByConnection] = await Promise.all([
      this.prisma.connection.findMany({ where, orderBy: { updatedAt: "desc" } }),
      this.usageByConnection(organizationId)
    ]);
    return connections
      .filter((connection) => !query.authScheme || (connection.type === "http_api_key" && httpAuthScheme(connection.configJson) === query.authScheme))
      .map((connection) => mapConnection(connection, usageByConnection.get(connection.id) ?? []));
  }

  async detail(organizationId: string, userId: string, connectionId: string) {
    const role = await this.roleFor(organizationId, userId);
    assertCanList(role);
    const [connection, usageByConnection] = await Promise.all([this.findConnection(organizationId, connectionId), this.usageByConnection(organizationId)]);
    return mapConnection(connection, usageByConnection.get(connectionId) ?? []);
  }

  async create(organizationId: string, userId: string, dto: CreateConnectionDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const normalized = normalizeCreateDto(dto);
    const encrypted = this.crypto.encrypt(normalized.secret);
    const connection = await this.prisma.$transaction(async (tx) => {
      const created = await tx.connection.create({
        data: {
          organizationId,
          createdByUserId: userId,
          name: normalized.name,
          description: normalized.description,
          type: toPrismaConnectionType(normalized.type) as any,
          configJson: toJson(normalized.config),
          status: ConnectionStatus.Active
        }
      });
      await tx.secret.create({
        data: {
          organizationId,
          connectionId: created.id,
          name: "primary",
          encryptedValue: encrypted.encryptedValue,
          encryptionVersion: encrypted.encryptionVersion,
          keyId: encrypted.keyId,
          status: "ACTIVE"
        }
      });
      await this.recordAudit(tx, organizationId, userId, "connection.created", created.id, normalized.type, normalized.authScheme, ConnectionStatus.Active);
      return created;
    });
    return mapConnection(connection);
  }

  async update(organizationId: string, userId: string, connectionId: string, dto: UpdateConnectionDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const existing = await this.findConnection(organizationId, connectionId);
    const config = updateConfig(existing.type === "smtp" ? ConnectionType.Smtp : ConnectionType.Http, asRecord(existing.configJson), dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.connection.update({
        where: { id: connectionId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          configJson: toJson(config)
        }
      });
      await this.recordAudit(tx, organizationId, userId, "connection.updated", connectionId, existing.type, httpAuthScheme(config), next.status);
      return next;
    });
    return mapConnection(updated, (await this.usageByConnection(organizationId)).get(connectionId) ?? []);
  }

  async rotate(organizationId: string, userId: string, connectionId: string, dto: RotateConnectionSecretDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const existing = await this.findConnection(organizationId, connectionId);
    if (existing.status !== ConnectionStatus.Active) throw invalidConnectionConfig("Only active connections can be rotated");
    const currentConfig = asRecord(existing.configJson);
    const secret = normalizeRotationSecret(existing.type === "smtp" ? ConnectionType.Smtp : ConnectionType.Http, currentConfig, dto);
    const encrypted = this.crypto.encrypt(secret.plaintext);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.secret.updateMany({ where: { organizationId, connectionId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
      await tx.secret.create({
        data: {
          organizationId,
          connectionId,
          name: "primary",
          encryptedValue: encrypted.encryptedValue,
          encryptionVersion: encrypted.encryptionVersion,
          keyId: encrypted.keyId,
          status: "ACTIVE",
          rotatedAt: now
        }
      });
      const next = await tx.connection.update({
        where: { id: connectionId },
        data: { rotatedAt: now, configJson: toJson({ ...currentConfig, ...secret.configPatch }) }
      });
      await this.recordAudit(tx, organizationId, userId, "connection.rotated", connectionId, existing.type, httpAuthScheme(next.configJson), next.status);
      return next;
    });
    return mapConnection(updated, (await this.usageByConnection(organizationId)).get(connectionId) ?? []);
  }

  async enable(organizationId: string, userId: string, connectionId: string) {
    return this.setEnabled(organizationId, userId, connectionId, true);
  }

  async disable(organizationId: string, userId: string, connectionId: string) {
    return this.setEnabled(organizationId, userId, connectionId, false);
  }

  async revoke(organizationId: string, userId: string, connectionId: string) {
    return this.disable(organizationId, userId, connectionId);
  }

  async delete(organizationId: string, userId: string, connectionId: string) {
    const role = await this.roleFor(organizationId, userId);
    if (role !== OrganizationRole.Owner) throw insufficientConnectionRole();
    const connection = await this.findConnection(organizationId, connectionId);
    const usage = (await this.usageByConnection(organizationId)).get(connectionId) ?? [];
    if (usage.length) throw connectionInUse();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.secret.updateMany({ where: { organizationId, connectionId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
      await tx.connection.update({ where: { id: connectionId }, data: { status: ConnectionStatus.Deleted, deletedAt: now } });
      await this.recordAudit(tx, organizationId, userId, "connection.deleted", connectionId, connection.type, httpAuthScheme(connection.configJson), ConnectionStatus.Deleted);
    });
    return null;
  }

  async test(organizationId: string, userId: string, connectionId: string, dto: TestConnectionDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanUse(role);
    rateLimitTest(organizationId, userId);
    const connection = await this.findConnection(organizationId, connectionId);
    if (connection.status !== ConnectionStatus.Active) throw invalidConnectionConfig("Only active connections can be tested");
    const secret = await this.activeSecret(organizationId, connectionId);
    const plaintext = this.crypto.decrypt(secret.encryptedValue);
    const started = Date.now();
    try {
      const result =
        connection.type === "smtp"
          ? await this.testSmtp(asRecord(connection.configJson), plaintext)
          : await this.testHttp(asRecord(connection.configJson), plaintext, dto);
      const statusCode = optionalStatusCode(result);
      await this.updateLastTest(organizationId, userId, connectionId, connection, {
        status: result.success ? "SUCCESS" : "FAILED",
        statusCode,
        durationMs: result.durationMs,
        message: result.message ?? (result.success ? "Connection test succeeded" : "Connection test failed")
      });
      if (!result.success) throw connectionTestFailed(result.message ?? (statusCode ? `HTTP ${statusCode}` : "Connection test failed"));
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const message = publicTestMessage(error);
      await this.updateLastTest(organizationId, userId, connectionId, connection, {
        status: "FAILED",
        durationMs,
        message
      });
      throw connectionTestFailed(`${message} after ${durationMs} ms`);
    }
  }

  private async setEnabled(organizationId: string, userId: string, connectionId: string, enabled: boolean) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const existing = await this.findConnection(organizationId, connectionId);
    if (existing.status === ConnectionStatus.Deleted || existing.status === ConnectionStatus.Revoked) throw invalidConnectionConfig("Connection cannot be enabled");
    const status = enabled ? ConnectionStatus.Active : ConnectionStatus.Disabled;
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.connection.update({ where: { id: connectionId }, data: { status, revokedAt: enabled ? null : new Date() } });
      await this.recordAudit(tx, organizationId, userId, enabled ? "connection.enabled" : "connection.disabled", connectionId, existing.type, httpAuthScheme(existing.configJson), status);
      return next;
    });
    return mapConnection(updated, (await this.usageByConnection(organizationId)).get(connectionId) ?? []);
  }

  private findConnection(organizationId: string, connectionId: string) {
    return this.prisma.connection.findFirst({ where: { id: connectionId, organizationId, deletedAt: null } }).then((connection) => {
      if (!connection) throw connectionNotFound();
      return connection;
    });
  }

  private activeSecret(organizationId: string, connectionId: string) {
    return this.prisma.secret.findFirst({ where: { organizationId, connectionId, status: "ACTIVE" } }).then((secret) => {
      if (!secret) throw invalidConnectionConfig("Connection has no active secret");
      return secret;
    });
  }

  private async testHttp(config: Record<string, unknown>, secret: string, dto: TestConnectionDto) {
    const prepared = prepareHttpRequest(config, secret, dto.url);
    const result = await this.testClient.request({ url: prepared.url, headers: prepared.headers, timeoutMs: Number(process.env.CONNECTION_TEST_TIMEOUT_MS ?? 5000) });
    return {
      success: result.ok,
      durationMs: result.durationMs,
      status: result.status,
      message: result.ok ? "HTTP request succeeded" : `HTTP request returned ${result.status}`
    };
  }

  private async testSmtp(config: Record<string, unknown>, password: string) {
    const started = Date.now();
    const transporter = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port),
      secure: config.secure === true,
      auth: { user: String(config.username), pass: password }
    });
    await transporter.verify();
    return { success: true, durationMs: Date.now() - started, message: "SMTP verify succeeded" };
  }

  private async updateLastTest(
    organizationId: string,
    userId: string,
    connectionId: string,
    connection: { type: string; configJson: unknown; status: string },
    result: { status: string; statusCode?: number; durationMs: number; message: string }
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.connection.update({
        where: { id: connectionId },
        data: {
          lastTestedAt: new Date(),
          lastTestStatus: result.status,
          lastTestStatusCode: result.statusCode,
          lastTestDurationMs: result.durationMs,
          lastTestMessage: result.message.slice(0, 240)
        }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.tested",
          resourceType: "Connection",
          resourceId: connectionId,
          metadata: {
            connectionId,
            type: connection.type,
            authScheme: httpAuthScheme(connection.configJson),
            status: connection.status,
            testOutcome: result.status,
            statusCode: result.statusCode
          }
        },
        tx
      );
    });
  }

  private async usageByConnection(organizationId: string) {
    const versions = await this.prisma.workflowVersion.findMany({
      where: { organizationId },
      include: { workflow: { select: { id: true, name: true } }, steps: true }
    });
    const usage = new Map<string, ConnectionUsage[]>();
    const seen = new Set<string>();
    for (const version of versions) {
      for (const step of version.steps) {
        addUsage(usage, seen, version, step.key, step.name, asRecord(step.configJson).connectionId);
      }
      const definition = asRecord(version.definitionJson);
      for (const step of definitionSteps(definition)) {
        addUsage(usage, seen, version, stringFieldOr(step.key, "step"), stringFieldOr(step.name, stringFieldOr(step.key, "Step")), asRecord(step.config).connectionId);
      }
    }
    return usage;
  }

  private async roleFor(organizationId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({ where: { organizationId, userId, status: "ACTIVE" }, select: { role: true } });
    if (!membership) throw insufficientConnectionRole();
    return membership.role as OrganizationRole;
  }

  private recordAudit(tx: Prisma.TransactionClient, organizationId: string, userId: string, action: string, connectionId: string, type: string, authScheme: unknown, status: string) {
    return this.auditLogs?.record(
      {
        organizationId,
        actorUserId: userId,
        action,
        resourceType: "Connection",
        resourceId: connectionId,
        metadata: { connectionId, type, authScheme: type === "smtp" ? undefined : authScheme, status }
      },
      tx
    );
  }
}

function normalizeCreateDto(dto: CreateConnectionDto): NormalizedConnection {
  const publicType = dto.type === ConnectionType.Smtp ? ConnectionType.Smtp : ConnectionType.Http;
  if (publicType === ConnectionType.Smtp) {
    if (!dto.host || !dto.port || !dto.username || !dto.password || !dto.fromEmail) throw invalidConnectionConfig();
    return {
      type: ConnectionType.Smtp,
      name: dto.name,
      description: dto.description,
      config: normalizeSmtpConfig(dto),
      secret: dto.password
    };
  }
  const authScheme = dto.authScheme ?? HttpAuthScheme.ApiKey;
  const { config, secret } = normalizeHttpConfig({ ...dto, authScheme }, true);
  return { type: ConnectionType.Http, authScheme, name: dto.name, description: dto.description, config, secret };
}

function updateConfig(type: ConnectionType, current: Record<string, unknown>, dto: UpdateConnectionDto) {
  if (dto.secretValue !== undefined || dto.secretHeaders !== undefined) {
    throw invalidConnectionConfig("Connection secrets must be changed with the rotate endpoint");
  }
  if (type === ConnectionType.Smtp) {
    return normalizeSmtpConfig({ ...current, ...dto, type: ConnectionType.Smtp, name: "connection" } as CreateConnectionDto);
  }
  if (dto.authScheme && canonicalHttpAuthScheme(dto.authScheme) !== httpAuthScheme(current)) {
    throw invalidConnectionConfig("Changing HTTP auth scheme requires creating or rotating connection credentials explicitly");
  }
  return normalizeHttpConfig({ ...current, ...dto, type: ConnectionType.Http, name: "connection" } as CreateConnectionDto, false).config;
}

function normalizeRotationSecret(type: ConnectionType, config: Record<string, unknown>, dto: RotateConnectionSecretDto) {
  if (type === ConnectionType.Smtp) {
    if (!dto.secretValue) throw invalidConnectionConfig("SMTP password is required");
    return { plaintext: dto.secretValue, configPatch: { secretPreview: previewSecret(dto.secretValue) } };
  }
  const scheme = httpAuthScheme(config);
  if (scheme === HttpAuthScheme.CustomHeaders) {
    if (!dto.secretHeaders) throw invalidConnectionConfig("Secret headers are required");
    validateHeaders(dto.secretHeaders, { allowAuthorization: true, allowSensitive: true });
    return { plaintext: JSON.stringify(dto.secretHeaders), configPatch: { secretHeaderPreviews: previewHeaders(dto.secretHeaders) } };
  }
  if (!dto.secretValue) throw invalidConnectionConfig("Secret value is required");
  return { plaintext: dto.secretValue, configPatch: { secretPreview: previewSecret(dto.secretValue) } };
}

function normalizeHttpConfig(dto: CreateConnectionDto, requireSecret: boolean) {
  const authScheme = canonicalHttpAuthScheme(dto.authScheme);
  const additionalHeaders = dto.additionalHeaders ?? {};
  validateHeaders(additionalHeaders, { allowAuthorization: false, allowSensitive: false });
  if (dto.baseUrl) assertHttpUrl(dto.baseUrl, true);
  const base = {
    authScheme,
    baseUrl: dto.baseUrl || undefined,
    additionalHeaders
  };
  if (authScheme === HttpAuthScheme.ApiKey) {
    if (requireSecret) rejectFields(dto, ["username", "secretHeaders", "password", "host", "port", "secure", "fromName", "fromEmail"]);
    if (!dto.authLocation || !dto.authName || (requireSecret && !dto.secretValue)) throw invalidConnectionConfig();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(dto.authName))) throw invalidConnectionConfig("authName is invalid");
    return {
      config: { ...base, authLocation: dto.authLocation, authName: dto.authName, secretPreview: dto.secretValue ? previewSecret(dto.secretValue) : dto.secretValue === "" ? undefined : (dto as any).secretPreview },
      secret: dto.secretValue ?? "not-used"
    };
  }
  if (authScheme === HttpAuthScheme.BearerToken) {
    if (requireSecret) rejectFields(dto, ["authLocation", "authName", "username", "secretHeaders", "password", "host", "port", "secure", "fromName", "fromEmail"]);
    if (requireSecret && !dto.secretValue) throw invalidConnectionConfig("Bearer token is required");
    return { config: { ...base, authLocation: HttpAuthLocation.Header, authName: "Authorization", secretPreview: dto.secretValue ? previewSecret(dto.secretValue) : (dto as any).secretPreview }, secret: dto.secretValue ?? "not-used" };
  }
  if (authScheme === HttpAuthScheme.BasicAuth) {
    if (requireSecret) rejectFields(dto, ["authLocation", "authName", "secretHeaders", "password", "host", "port", "secure", "fromName", "fromEmail"]);
    if (!dto.username || (requireSecret && !dto.secretValue)) throw invalidConnectionConfig("Basic auth username and password are required");
    return { config: { ...base, username: dto.username, secretPreview: dto.secretValue ? previewSecret(dto.secretValue) : (dto as any).secretPreview }, secret: dto.secretValue ?? "not-used" };
  }
  if (authScheme === HttpAuthScheme.CustomHeaders) {
    if (requireSecret) rejectFields(dto, ["authLocation", "authName", "username", "secretValue", "password", "host", "port", "secure", "fromName", "fromEmail"]);
    const secretHeaders = dto.secretHeaders ?? {};
    if (requireSecret && !Object.keys(secretHeaders).length) throw invalidConnectionConfig("At least one secret header is required");
    validateHeaders(secretHeaders, { allowAuthorization: true, allowSensitive: true });
    return {
      config: { ...base, secretHeaderPreviews: Object.keys(secretHeaders).length ? previewHeaders(secretHeaders) : asRecord((dto as any).secretHeaderPreviews) },
      secret: Object.keys(secretHeaders).length ? JSON.stringify(secretHeaders) : "not-used"
    };
  }
  throw invalidConnectionConfig("Unsupported HTTP auth scheme");
}

function normalizeSmtpConfig(dto: CreateConnectionDto) {
  if (!dto.host || !dto.port || !dto.username || !dto.fromEmail) throw invalidConnectionConfig();
  return {
    host: dto.host,
    port: Number(dto.port),
    secure: dto.secure === true,
    username: dto.username,
    fromName: dto.fromName || undefined,
    fromEmail: dto.fromEmail,
    secretPreview: dto.password ? previewSecret(dto.password) : (dto as any).secretPreview
  };
}

function prepareHttpRequest(config: Record<string, unknown>, secret: string, inputUrl?: string) {
  let url = resolveHttpUrl(config, inputUrl);
  const headers = { ...asStringRecord(config.additionalHeaders) };
  const scheme = httpAuthScheme(config);
  if (scheme === HttpAuthScheme.ApiKey) {
    if (config.authLocation === HttpAuthLocation.Query) {
      const next = new URL(url);
      next.searchParams.set(String(config.authName), secret);
      url = next.toString();
    } else {
      headers[String(config.authName)] = secret;
    }
  } else if (scheme === HttpAuthScheme.BearerToken) {
    headers.Authorization = `Bearer ${secret}`;
  } else if (scheme === HttpAuthScheme.BasicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${String(config.username)}:${secret}`, "utf8").toString("base64")}`;
  } else if (scheme === HttpAuthScheme.CustomHeaders) {
    Object.assign(headers, parseSecretHeaders(secret));
  }
  return { url, headers };
}

function resolveHttpUrl(config: Record<string, unknown>, inputUrl?: string) {
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  const target = inputUrl || baseUrl;
  if (!target) throw new BadRequestException("Test URL is required");
  if (baseUrl && target.startsWith("/")) return resolveRelativeUrl(baseUrl, target);
  assertHttpUrl(target, false);
  return target;
}

function resolveRelativeUrl(baseUrl: string, path: string) {
  const base = new URL(baseUrl);
  const next = new URL(path, base);
  for (const [key, value] of base.searchParams.entries()) {
    if (!next.searchParams.has(key)) next.searchParams.append(key, value);
  }
  return next.toString();
}

function assertHttpUrl(value: string, allowNoPath: boolean) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (!allowNoPath && !url.href)) throw new Error("invalid");
  } catch {
    throw invalidConnectionConfig("URL is invalid");
  }
}

function validateHeaders(headers: Record<string, string>, options: { allowAuthorization: boolean; allowSensitive: boolean }) {
  if (Object.keys(headers).length > 32) throw invalidConnectionConfig("Too many headers");
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,120}$/.test(name)) throw invalidConnectionConfig(`Header ${name} is invalid`);
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("x-forwarded-")) throw invalidConnectionConfig(`Header ${name} is not allowed`);
    if (!options.allowAuthorization && lower === "authorization") throw invalidConnectionConfig("Authorization must be generated from the connection secret");
    if (!options.allowSensitive && SENSITIVE_HEADERS.has(lower)) throw invalidConnectionConfig(`Header ${name} must be configured as a connection secret`);
    if (typeof value !== "string" || value.length > 4096) throw invalidConnectionConfig(`Header ${name} is invalid`);
  }
}

function canonicalHttpAuthScheme(value: unknown) {
  if (value === "BEARER_TOKEN") return HttpAuthScheme.BearerToken;
  if (value === "BASIC_AUTH") return HttpAuthScheme.BasicAuth;
  if (Object.values(HttpAuthScheme).includes(value as HttpAuthScheme)) return value as HttpAuthScheme;
  return HttpAuthScheme.ApiKey;
}

function rejectFields(dto: object, fields: string[]) {
  const record = dto as Record<string, unknown>;
  const present = fields.find((field) => record[field] !== undefined);
  if (present) throw invalidConnectionConfig(`Field ${present} is not allowed for this HTTP auth scheme`);
}

function parseSecretHeaders(secret: string) {
  try {
    const parsed = JSON.parse(secret);
    return asStringRecord(parsed);
  } catch {
    throw invalidConnectionConfig("Secret headers are invalid");
  }
}

function previewSecret(value: string) {
  return `********${value.slice(-4)}`;
}

function previewHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, previewSecret(value)]));
}

function publicTestMessage(error: unknown) {
  if (error instanceof Error && /timed out|timeout|aborted/i.test(error.message)) return "Connection test timed out";
  if (error instanceof Error && /dns|ENOTFOUND|getaddrinfo/i.test(error.message)) return "DNS lookup failed";
  if (error instanceof Error && /certificate|TLS|SSL/i.test(error.message)) return "TLS validation failed";
  if (error instanceof Error && /private|reserved|metadata|internal host|SSRF/i.test(error.message)) return "Target URL is blocked by outbound safety rules";
  return "Connection test failed";
}

function optionalStatusCode(value: unknown) {
  const record = asRecord(value);
  return typeof record.status === "number" ? record.status : undefined;
}

function definitionSteps(definition: Record<string, unknown>) {
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  return steps.map(asRecord);
}

function addUsage(
  usage: Map<string, ConnectionUsage[]>,
  seen: Set<string>,
  version: { id: string; versionNumber: number; workflow: { id: string; name: string } },
  stepKey: string,
  stepName: string,
  connectionIdValue: unknown
) {
  if (typeof connectionIdValue !== "string" || !connectionIdValue) return;
  const dedupeKey = `${connectionIdValue}:${version.id}:${stepKey}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  usage.set(connectionIdValue, [
    ...(usage.get(connectionIdValue) ?? []),
    {
      workflowId: version.workflow.id,
      workflowName: version.workflow.name,
      workflowVersionId: version.id,
      versionNumber: version.versionNumber,
      stepKey,
      stepName
    }
  ]);
}

function stringFieldOr(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function assertCanList(role: OrganizationRole) {
  if (![OrganizationRole.Owner, OrganizationRole.Admin, OrganizationRole.Editor].includes(role)) throw insufficientConnectionRole();
}

function assertCanManage(role: OrganizationRole) {
  if (![OrganizationRole.Owner, OrganizationRole.Admin].includes(role)) throw insufficientConnectionRole();
}

function assertCanUse(role: OrganizationRole) {
  if (![OrganizationRole.Owner, OrganizationRole.Admin, OrganizationRole.Editor].includes(role)) throw insufficientConnectionRole();
}

function rateLimitTest(organizationId: string, userId: string) {
  const key = `${organizationId}:${userId}`;
  const now = Date.now();
  const current = testCounters.get(key);
  if (!current || current.resetAt < now) {
    testCounters.set(key, { count: 1, resetAt: now + TEST_LIMIT_WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count > TEST_LIMIT_MAX) throw new BadRequestException("Too many connection tests");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
