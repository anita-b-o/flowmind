import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConnectionType, HttpAuthLocation, OrganizationRole } from "@automation/shared-types";
import nodemailer from "nodemailer";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConnectionCryptoService } from "../secrets/connection-crypto.service";
import { CreateConnectionDto } from "./dto/create-connection.dto";
import { RotateConnectionSecretDto } from "./dto/rotate-connection-secret.dto";
import { TestConnectionDto } from "./dto/test-connection.dto";
import { UpdateConnectionDto } from "./dto/update-connection.dto";
import { connectionInUse, connectionNotFound, connectionTestFailed, invalidConnectionConfig, insufficientConnectionRole } from "./connection-errors";
import { mapConnection, toPrismaConnectionType } from "./connection-mapper";
import { SafeConnectionTestClient } from "./safe-connection-test-client";

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "cookie", "proxy-authorization"]);
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const TEST_LIMIT_WINDOW_MS = 60_000;
const TEST_LIMIT_MAX = 20;
const testCounters = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ConnectionCryptoService,
    private readonly testClient: SafeConnectionTestClient,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async list(organizationId: string, userId: string) {
    const role = await this.roleFor(organizationId, userId);
    assertCanList(role);
    const connections = await this.prisma.connection.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { updatedAt: "desc" }
    });
    return connections.map(mapConnection);
  }

  async detail(organizationId: string, userId: string, connectionId: string) {
    const role = await this.roleFor(organizationId, userId);
    assertCanList(role);
    const connection = await this.findConnection(organizationId, connectionId);
    return mapConnection(connection);
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
          status: "ACTIVE"
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
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.created",
          resourceType: "Connection",
          resourceId: created.id,
          metadata: { connectionId: created.id, type: normalized.type, status: "ACTIVE" }
        },
        tx
      );
      return created;
    });
    return mapConnection(connection);
  }

  async update(organizationId: string, userId: string, connectionId: string, dto: UpdateConnectionDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const existing = await this.findConnection(organizationId, connectionId);
    const type = existing.type === "http_api_key" ? ConnectionType.HttpApiKey : ConnectionType.Smtp;
    const config = updateConfig(type, asRecord(existing.configJson), dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.connection.update({
        where: { id: connectionId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          configJson: toJson(config)
        }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.updated",
          resourceType: "Connection",
          resourceId: connectionId,
          metadata: { connectionId, type, status: next.status }
        },
        tx
      );
      return next;
    });
    return mapConnection(updated);
  }

  async rotate(organizationId: string, userId: string, connectionId: string, dto: RotateConnectionSecretDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    const existing = await this.findConnection(organizationId, connectionId);
    if (existing.status !== "ACTIVE") throw invalidConnectionConfig("Only active connections can be rotated");
    const encrypted = this.crypto.encrypt(dto.secretValue);
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
      const next = await tx.connection.update({ where: { id: connectionId }, data: { rotatedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.rotated",
          resourceType: "Connection",
          resourceId: connectionId,
          metadata: { connectionId, type: existing.type, status: next.status }
        },
        tx
      );
      return next;
    });
    return mapConnection(updated);
  }

  async revoke(organizationId: string, userId: string, connectionId: string) {
    const role = await this.roleFor(organizationId, userId);
    assertCanManage(role);
    await this.findConnection(organizationId, connectionId);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.secret.updateMany({ where: { organizationId, connectionId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
      const next = await tx.connection.update({ where: { id: connectionId }, data: { status: "REVOKED", revokedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.revoked",
          resourceType: "Connection",
          resourceId: connectionId,
          metadata: { connectionId, type: next.type, status: next.status }
        },
        tx
      );
      return next;
    });
    return mapConnection(updated);
  }

  async delete(organizationId: string, userId: string, connectionId: string) {
    const role = await this.roleFor(organizationId, userId);
    if (role !== OrganizationRole.Owner) throw insufficientConnectionRole();
    const connection = await this.findConnection(organizationId, connectionId);
    if (await this.isUsedByActiveVersion(organizationId, connectionId)) {
      throw connectionInUse();
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.secret.updateMany({ where: { organizationId, connectionId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now } });
      await tx.connection.update({ where: { id: connectionId }, data: { status: "DELETED", deletedAt: now } });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "connection.deleted",
          resourceType: "Connection",
          resourceId: connectionId,
          metadata: { connectionId, type: connection.type, status: "DELETED" }
        },
        tx
      );
    });
    return null;
  }

  async test(organizationId: string, userId: string, connectionId: string, dto: TestConnectionDto) {
    const role = await this.roleFor(organizationId, userId);
    assertCanUse(role);
    rateLimitTest(organizationId, userId);
    const connection = await this.findConnection(organizationId, connectionId);
    const secret = await this.activeSecret(organizationId, connectionId);
    const plaintext = this.crypto.decrypt(secret.encryptedValue);
    const started = Date.now();
    try {
      const type = connection.type === "http_api_key" ? ConnectionType.HttpApiKey : ConnectionType.Smtp;
      const result = type === ConnectionType.HttpApiKey ? await this.testHttp(asRecord(connection.configJson), plaintext, dto) : await this.testSmtp(asRecord(connection.configJson), plaintext);
      await this.auditLogs?.record({
        organizationId,
        actorUserId: userId,
        action: "connection.tested",
        resourceType: "Connection",
        resourceId: connectionId,
        metadata: { connectionId, type, status: connection.status, testOutcome: "success" }
      });
      return result;
    } catch {
      await this.auditLogs?.record({
        organizationId,
        actorUserId: userId,
        action: "connection.tested",
        resourceType: "Connection",
        resourceId: connectionId,
        metadata: { connectionId, type: connection.type, status: connection.status, testOutcome: "failed" }
      });
      throw connectionTestFailed(`Connection test failed after ${Date.now() - started} ms`);
    }
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
    let url = resolveHttpUrl(config, dto.url);
    const headers = applyHttpSecret(config, secret, {});
    if (config.authLocation === HttpAuthLocation.Query) {
      const next = new URL(url);
      next.searchParams.set(String(config.authName), secret);
      url = next.toString();
    }
    const result = await this.testClient.request({ url, headers, timeoutMs: Number(process.env.CONNECTION_TEST_TIMEOUT_MS ?? 5000) });
    return { success: result.ok, durationMs: result.durationMs, status: result.status };
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
    return { success: true, durationMs: Date.now() - started };
  }

  private async isUsedByActiveVersion(organizationId: string, connectionId: string) {
    const versions = await this.prisma.workflowVersion.findMany({
      where: { organizationId, status: "ACTIVE" },
      include: { steps: true }
    });
    return versions.some((version) => version.steps.some((step) => asRecord(step.configJson).connectionId === connectionId));
  }

  private async roleFor(organizationId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: "ACTIVE" },
      select: { role: true }
    });
    if (!membership) throw insufficientConnectionRole();
    return membership.role as OrganizationRole;
  }
}

function normalizeCreateDto(dto: CreateConnectionDto) {
  if (dto.type === ConnectionType.HttpApiKey) {
    if (!dto.authLocation || !dto.authName || !dto.secretValue) throw invalidConnectionConfig();
    const config = normalizeHttpConfig(dto);
    return { type: dto.type, name: dto.name, description: dto.description, config, secret: dto.secretValue };
  }
  if (!dto.host || !dto.port || !dto.username || !dto.password || !dto.fromEmail) throw invalidConnectionConfig();
  return {
    type: dto.type,
    name: dto.name,
    description: dto.description,
    config: {
      host: dto.host,
      port: dto.port,
      secure: dto.secure === true,
      username: dto.username,
      fromName: dto.fromName,
      fromEmail: dto.fromEmail
    },
    secret: dto.password
  };
}

function updateConfig(type: ConnectionType, current: Record<string, unknown>, dto: UpdateConnectionDto) {
  if (type === ConnectionType.HttpApiKey) {
    return normalizeHttpConfig({ ...current, ...dto, type, name: dto.name ?? "connection", secretValue: "not-used" } as CreateConnectionDto);
  }
  return {
    ...current,
    ...(dto.host !== undefined ? { host: dto.host } : {}),
    ...(dto.port !== undefined ? { port: Number(dto.port) } : {}),
    ...(dto.secure !== undefined ? { secure: dto.secure === true } : {}),
    ...(dto.username !== undefined ? { username: dto.username } : {}),
    ...(dto.fromName !== undefined ? { fromName: dto.fromName } : {}),
    ...(dto.fromEmail !== undefined ? { fromEmail: dto.fromEmail } : {})
  };
}

function normalizeHttpConfig(dto: CreateConnectionDto) {
  const additionalHeaders = dto.additionalHeaders ?? {};
  for (const [name, value] of Object.entries(additionalHeaders)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || SENSITIVE_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("x-forwarded-")) {
      throw invalidConnectionConfig(`Header ${name} is not allowed`);
    }
    if (typeof value !== "string") throw invalidConnectionConfig("Additional headers must be strings");
  }
  if (dto.baseUrl) assertHttpUrl(dto.baseUrl, true);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(dto.authName))) throw invalidConnectionConfig("authName is invalid");
  return {
    baseUrl: dto.baseUrl || undefined,
    authLocation: dto.authLocation,
    authName: dto.authName,
    additionalHeaders
  };
}

function resolveHttpUrl(config: Record<string, unknown>, inputUrl?: string) {
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  const target = inputUrl || baseUrl;
  if (!target) throw new BadRequestException("Test URL is required");
  if (baseUrl && target.startsWith("/")) return new URL(target, baseUrl).toString();
  assertHttpUrl(target, false);
  return target;
}

function applyHttpSecret(config: Record<string, unknown>, secret: string, stepHeaders: Record<string, string>) {
  const headers = { ...asStringRecord(config.additionalHeaders), ...stepHeaders };
  if (config.authLocation === HttpAuthLocation.Header) {
    headers[String(config.authName)] = secret;
  }
  return headers;
}

function assertHttpUrl(value: string, allowNoPath: boolean) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (!allowNoPath && !url.href)) throw new Error("invalid");
  } catch {
    throw invalidConnectionConfig("URL is invalid");
  }
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
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
