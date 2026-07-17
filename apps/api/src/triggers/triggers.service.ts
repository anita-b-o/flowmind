import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWebhookTriggerDto, UpdateWebhookTriggerDto } from "./dto/create-webhook-trigger.dto";
import { WebhookTokenService } from "./webhook-token.service";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ConnectionCryptoService } from "../secrets/connection-crypto.service";

const DEFAULT_SIGNATURE = {
  enabled: false,
  algorithm: "HMAC-SHA256",
  signatureHeader: "x-flowmind-signature",
  timestampHeader: "x-flowmind-timestamp",
  nonceHeader: "x-flowmind-nonce",
  toleranceSeconds: 300
};

@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: WebhookTokenService,
    private readonly crypto: ConnectionCryptoService,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async createWebhookTrigger(organizationId: string, userId: string, workflowId: string, dto: CreateWebhookTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const token = this.tokenService.generateToken();
    const signatureSecret = dto.signature?.enabled ? this.tokenService.generateToken() : undefined;
    const config = this.normalizeConfig(dto, signatureSecret);
    const trigger = await this.prisma.trigger.create({
      data: {
        organizationId,
        workflowId,
        type: "webhook",
        httpMethod: dto.httpMethod ?? "POST",
        tokenHash: this.tokenService.hashToken(token),
        tokenPreview: this.tokenService.previewToken(token),
        configJson: toJson(config),
        enabled: true
      }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "webhook.trigger.created",
      resourceType: "Trigger",
      resourceId: trigger.id,
      metadata: { workflowId, type: "webhook" }
    });

    return this.withOneTimeToken(trigger, token, signatureSecret);
  }

  async list(organizationId: string, workflowId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const triggers = await this.prisma.trigger.findMany({
      where: { organizationId, workflowId, deletedAt: null },
      orderBy: { createdAt: "desc" }
    });
    return triggers.map((trigger) => this.summary(trigger));
  }

  async get(organizationId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const trigger = await this.prisma.trigger.findFirst({ where: { id: triggerId, organizationId, workflowId, deletedAt: null } });
    if (!trigger) throw new NotFoundException("Trigger not found");
    return this.summary(trigger);
  }

  async update(organizationId: string, userId: string, workflowId: string, triggerId: string, dto: UpdateWebhookTriggerDto) {
    await this.assertWorkflow(organizationId, workflowId);
    const current = await this.prisma.trigger.findFirst({ where: { id: triggerId, organizationId, workflowId, type: "webhook", deletedAt: null } });
    if (!current) throw new NotFoundException("Trigger not found");
    const currentConfig = normalizeStoredConfig(current.configJson);
    const signatureSecret = dto.signature?.enabled && !currentConfig.signature.encryptedSecret ? this.tokenService.generateToken() : undefined;
    const config = this.normalizeConfig(dto, signatureSecret, currentConfig);
    const trigger = await this.prisma.trigger.update({
      where: { id: triggerId },
      data: {
        httpMethod: dto.httpMethod ?? current.httpMethod,
        configJson: toJson(config)
      }
    });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "webhook.trigger.updated",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, type: "webhook", signatureEnabled: config.signature.enabled }
    });
    return signatureSecret ? this.withOneTimeToken(trigger, undefined, signatureSecret) : this.summary(trigger);
  }

  async rotate(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const token = this.tokenService.generateToken();
    const trigger = await this.prisma.trigger.updateMany({
      where: { id: triggerId, organizationId, workflowId, type: "webhook", deletedAt: null },
      data: {
        tokenHash: this.tokenService.hashToken(token),
        tokenPreview: this.tokenService.previewToken(token),
        rotatedAt: new Date()
      }
    });
    if (trigger.count !== 1) {
      throw new NotFoundException("Trigger not found");
    }
    const updated = await this.prisma.trigger.findFirstOrThrow({ where: { id: triggerId, organizationId, workflowId } });
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "webhook.trigger.rotated",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, type: "webhook" }
    });
    return this.withOneTimeToken(updated, token);
  }

  async setEnabled(organizationId: string, userId: string, workflowId: string, triggerId: string, enabled: boolean) {
    await this.assertWorkflow(organizationId, workflowId);
    const updated = await this.prisma.trigger.updateMany({
      where: { id: triggerId, organizationId, workflowId, type: "webhook", deletedAt: null },
      data: { enabled }
    });
    if (updated.count !== 1) throw new NotFoundException("Trigger not found");
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: enabled ? "webhook.trigger.enabled" : "webhook.trigger.disabled",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, type: "webhook" }
    });
    const trigger = await this.prisma.trigger.findFirstOrThrow({ where: { id: triggerId, organizationId, workflowId } });
    return this.summary(trigger);
  }

  async delete(organizationId: string, userId: string, workflowId: string, triggerId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const token = this.tokenService.generateToken();
    const updated = await this.prisma.trigger.updateMany({
      where: { id: triggerId, organizationId, workflowId, type: "webhook", deletedAt: null },
      data: {
        enabled: false,
        deletedAt: new Date(),
        tokenHash: this.tokenService.hashToken(token),
        tokenPreview: null
      }
    });
    if (updated.count !== 1) throw new NotFoundException("Trigger not found");
    await this.auditLogs?.record({
      organizationId,
      actorUserId: userId,
      action: "webhook.trigger.deleted",
      resourceType: "Trigger",
      resourceId: triggerId,
      metadata: { workflowId, type: "webhook" }
    });
    return { deleted: true };
  }

  private async assertWorkflow(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId } });
    if (!workflow) {
      throw new NotFoundException("Workflow not found");
    }
    return workflow;
  }

  private normalizeConfig(dto: CreateWebhookTriggerDto | UpdateWebhookTriggerDto, signatureSecret?: string, current = normalizeStoredConfig({})) {
    const signature = {
      ...current.signature,
      ...DEFAULT_SIGNATURE,
      ...(dto.signature ?? {}),
      algorithm: "HMAC-SHA256",
      ...(signatureSecret ? this.crypto.encrypt(signatureSecret) : {})
    } as Record<string, unknown>;
    if (dto.signature?.enabled === false) {
      delete signature.encryptedValue;
      delete signature.encryptedSecret;
    }
    if ("encryptedValue" in signature) {
      signature.encryptedSecret = signature.encryptedValue;
      delete signature.encryptedValue;
    }
    delete signature.token;
    delete signature.secret;
    return {
      name: dto.name ?? current.name ?? "Webhook",
      idempotencyHeader: normalizeHeaderName(dto.idempotencyHeader ?? current.idempotencyHeader ?? "Idempotency-Key"),
      payloadLimits: { ...defaultLimits(), ...current.payloadLimits, ...(dto.payloadLimits ?? {}) },
      signature,
      metadata: dto.metadata ?? current.metadata ?? {}
    };
  }

  private summary(trigger: {
    id: string;
    type: string;
    workflowId: string;
    httpMethod: string;
    enabled: boolean;
    tokenPreview: string | null;
    configJson: unknown;
    createdAt: Date;
    rotatedAt: Date | null;
    lastReceivedAt: Date | null;
    lastExecutionId: string | null;
  }) {
    const config = normalizeStoredConfig(trigger.configJson);
    return {
      id: trigger.id,
      type: trigger.type,
      workflowId: trigger.workflowId,
      enabled: trigger.enabled,
      method: trigger.httpMethod,
      httpMethod: trigger.httpMethod,
      tokenPreview: trigger.tokenPreview,
      maskedWebhookUrl: this.tokenService.buildMaskedWebhookUrl(trigger.id, trigger.tokenPreview),
      tokenAvailable: false,
      createdAt: trigger.createdAt,
      rotatedAt: trigger.rotatedAt,
      lastReceivedAt: trigger.lastReceivedAt,
      lastExecutionId: trigger.lastExecutionId,
      config: publicConfig(config)
    };
  }

  private withOneTimeToken(
    trigger: {
      id: string;
      type: string;
      workflowId: string;
      httpMethod: string;
      enabled: boolean;
      tokenPreview: string | null;
      configJson: unknown;
      createdAt: Date;
      rotatedAt: Date | null;
      lastReceivedAt: Date | null;
      lastExecutionId: string | null;
    },
    token?: string,
    signatureSecret?: string
  ) {
    return {
      ...this.summary(trigger),
      ...(token
        ? {
            webhookUrl: this.tokenService.buildWebhookUrl(trigger.id, token),
            token,
            tokenAvailable: true
          }
        : { tokenAvailable: false }),
      ...(signatureSecret ? { signatureSecret, signatureSecretAvailable: true } : {})
    };
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function normalizeStoredConfig(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
  const signature = record.signature && typeof record.signature === "object" && !Array.isArray(record.signature) ? record.signature : {};
  return {
    name: typeof record.name === "string" ? record.name : "Webhook",
    idempotencyHeader: normalizeHeaderName(record.idempotencyHeader ?? "Idempotency-Key"),
    payloadLimits: { ...defaultLimits(), ...(record.payloadLimits ?? {}) },
    signature: {
      ...DEFAULT_SIGNATURE,
      ...signature,
      encryptedSecret: signature.encryptedSecret ?? signature.encryptedValue
    },
    metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? record.metadata : {}
  };
}

function defaultLimits() {
  return {
    maxBytes: Number(process.env.WEBHOOK_PAYLOAD_MAX_BYTES ?? 1_048_576),
    maxDepth: Number(process.env.WEBHOOK_PAYLOAD_MAX_DEPTH ?? 8),
    maxKeys: Number(process.env.WEBHOOK_PAYLOAD_MAX_KEYS ?? 1_000),
    maxArrayLength: Number(process.env.WEBHOOK_PAYLOAD_MAX_ARRAY_LENGTH ?? 200),
    maxStringLength: Number(process.env.WEBHOOK_PAYLOAD_MAX_STRING_LENGTH ?? 16_384),
    requireBody: true
  };
}

function normalizeHeaderName(value: unknown) {
  const header = typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value.trim()) ? value.trim() : "Idempotency-Key";
  return header;
}

function publicConfig(config: ReturnType<typeof normalizeStoredConfig>) {
  return {
    name: config.name,
    idempotencyHeader: config.idempotencyHeader,
    payloadLimits: config.payloadLimits,
    signature: {
      enabled: Boolean(config.signature.enabled),
      algorithm: config.signature.algorithm,
      signatureHeader: config.signature.signatureHeader,
      timestampHeader: config.signature.timestampHeader,
      nonceHeader: config.signature.nonceHeader,
      toleranceSeconds: config.signature.toleranceSeconds,
      secretAvailable: Boolean(config.signature.encryptedSecret)
    },
    metadata: config.metadata
  };
}
