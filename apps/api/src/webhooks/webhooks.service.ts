import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { newTraceId } from "@automation/observability";
import { ExecutionMode, ExecutionStatus } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { WebhookTokenService } from "../triggers/webhook-token.service";
import { normalizeStoredConfig } from "../triggers/triggers.service";
import { WebhookRateLimitService } from "./webhook-rate-limit.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { ConnectionCryptoService } from "../secrets/connection-crypto.service";
import { validateWorkflowGraph } from "../workflows/workflow-graph-validator";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ReceiveWebhookInput {
  publicId: string;
  token: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  sourceIp: string;
  body: unknown;
  rawBody: Buffer;
  query: Record<string, unknown>;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly tokenService: WebhookTokenService,
    private readonly rateLimitService: WebhookRateLimitService,
    private readonly requestContext: RequestContextService,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: ApiMetricsService,
    private readonly crypto: ConnectionCryptoService,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async receive(input: ReceiveWebhookInput) {
    const startedAt = Date.now();
    const requestId = this.requestContext.getRequestId();
    const correlationId = this.requestContext.getCorrelationId();
    await this.assertPreRateLimit(input);

    const resolved = await this.resolveTrigger(input.publicId, input.token);
    if (!resolved) {
      this.metrics.recordWebhook("rejected", "invalid_token");
      throw new UnauthorizedException("Webhook not found");
    }
    const { trigger, workflow } = resolved;
    const config = normalizeStoredConfig(trigger.configJson);

    if (!trigger.enabled || trigger.deletedAt || workflow.status !== "ACTIVE") {
      this.metrics.recordWebhook("rejected", "invalid_token");
      throw new UnauthorizedException("Webhook not found");
    }
    if (input.method.toUpperCase() !== trigger.httpMethod.toUpperCase()) {
      this.metrics.recordWebhook("rejected", "method_not_allowed");
      throw new MethodNotAllowedException(`Webhook expects ${trigger.httpMethod}`);
    }
    try {
      validatePayload(input.body, input.rawBody, config.payloadLimits);
    } catch (error) {
      this.metrics.recordWebhook("rejected", error instanceof PayloadTooLargeException ? "payload_too_large" : "invalid_payload");
      throw error;
    }
    await this.assertSignature(input, trigger, config);
    await this.assertPostRateLimit(input, workflow.organizationId, trigger.id);

    const activeVersion = workflow.activeVersion;
    if (!activeVersion || activeVersion.status !== "ACTIVE") {
      this.metrics.recordWebhook("rejected", "inactive_workflow");
      throw new NotFoundException("Active workflow not found");
    }
    validateVersionDefinition(activeVersion.definitionJson);

    const receivedAt = new Date();
    const sanitizedHeaders = sanitizeHeaders(input.headers);
    const sanitizedQuery = sanitizeQuery(input.query);
    const payload = sanitizePayload(input.body, config.payloadLimits);
    const payloadHash = sha256(input.rawBody);
    const requestHash = sha256(JSON.stringify({ method: input.method.toUpperCase(), query: sanitizedQuery, payloadHash }));
    const idempotencyHeader = config.idempotencyHeader.toLowerCase();
    const headerKey = headerValue(input.headers[idempotencyHeader] ?? input.headers[config.idempotencyHeader]);
    const idempotencyKey = sanitizeIdempotencyKey(headerKey) ?? `auto:${requestHash}`;
    const scope = `webhook:${trigger.id}`;

    const existing = await this.waitForExisting(workflow.organizationId, scope, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.metrics.recordWebhook("rejected", "idempotency_conflict");
        await this.auditLogs?.record({
          organizationId: workflow.organizationId,
          actorUserId: null,
          action: "webhook.idempotency.conflict",
          resourceType: "Trigger",
          resourceId: trigger.id,
          correlationId,
          metadata: { workflowId: workflow.id }
        });
        throw new ConflictException("Idempotency key was already used with a different payload");
      }
      if (existing.responseJson && ["PROCESSING", "ENQUEUED", "FAILED"].includes(existing.status)) {
        this.metrics.recordWebhook("accepted", "idempotency_hit");
        if (existing.status === "FAILED") {
          return this.retryFailedEnqueue(workflow.organizationId, scope, idempotencyKey, existing.responseJson);
        }
        return this.authoritativeResponse(workflow.organizationId, existing.responseJson);
      }
      throw new ConflictException("Webhook request is still being processed");
    }

    const created = await this.createExecutionClaim({
      workflow,
      trigger,
      activeVersion,
      input,
      payload,
      sanitizedHeaders,
      sanitizedQuery,
      receivedAt,
      payloadHash,
      requestHash,
      scope,
      idempotencyKey,
      correlationId,
      requestId
    }).catch(async (error) => {
      if ((error as any)?.code === "P2002") {
        const response = await this.waitForIdempotentResponse(workflow.organizationId, scope, idempotencyKey, requestHash);
        return { execution: { id: response.executionId, correlationId: response.correlationId } };
      }
      throw error;
    });

    try {
      await this.queueService.enqueueExecution({
        organizationId: workflow.organizationId,
        executionId: created.execution.id,
        workflowId: workflow.id,
        workflowVersionId: activeVersion.id,
        requestId,
        correlationId: created.execution.correlationId ?? correlationId,
        enqueuedAt: new Date().toISOString(),
        executionMode: ExecutionMode.Real
      });
      const response = { accepted: true, executionId: created.execution.id, correlationId: created.execution.correlationId ?? correlationId };
      await this.prisma.$transaction(async (tx) => {
        await tx.execution.update({ where: { id: created.execution.id }, data: { status: ExecutionStatus.Queued } });
        await tx.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId: workflow.organizationId, scope, key: idempotencyKey } },
          data: { status: "ENQUEUED", responseJson: toPrismaJson(response), lockedUntil: null }
        });
        await this.auditLogs?.record(
          {
            organizationId: workflow.organizationId,
            actorUserId: null,
            action: "webhook.execution.created",
            resourceType: "Execution",
            resourceId: created.execution.id,
            correlationId,
            metadata: { workflowId: workflow.id, workflowVersionId: activeVersion.id, triggerId: trigger.id }
          },
          tx
        );
      });
      this.logger.info("api.webhook.accepted", {
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        workflowVersionId: activeVersion.id,
        executionId: created.execution.id
      });
      this.metrics.recordWebhook("accepted", "accepted");
      this.metrics.recordWebhookExecutionCreated();
      this.metrics.recordWebhookEnqueueLatency((Date.now() - startedAt) / 1000);
      return response;
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.execution.update({
          where: { id: created.execution.id },
          data: { status: ExecutionStatus.Failed, errorJson: toPrismaJson({ message: "Failed to enqueue execution" }) }
        }),
        this.prisma.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId: workflow.organizationId, scope, key: idempotencyKey } },
          data: { status: "FAILED", responseJson: toPrismaJson({ accepted: false, executionId: created.execution.id, correlationId }), lockedUntil: null }
        })
      ]);
      this.logger.error("api.execution.enqueue_failed", {
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        executionId: created.execution.id
      });
      this.metrics.recordWebhook("rejected", "enqueue_failed");
      this.metrics.recordEnqueueFailure("webhook", classifyError(error));
      throw new ServiceUnavailableException("Execution could not be queued");
    }
  }

  private async assertPreRateLimit(input: ReceiveWebhookInput) {
    try {
      await this.rateLimitService.assertAllowed(`pre:${input.publicId}:${input.sourceIp}`, this.rateLimitService.burstMax());
    } catch (error) {
      this.metrics.recordWebhook("rejected", "rate_limited");
      throw error;
    }
  }

  private async assertPostRateLimit(input: ReceiveWebhookInput, organizationId: string, triggerId: string) {
    try {
      await this.rateLimitService.assertAllowed(`trigger:${organizationId}:${triggerId}`);
      await this.rateLimitService.assertAllowed(`trigger-ip:${organizationId}:${triggerId}:${input.sourceIp}`);
    } catch (error) {
      this.metrics.recordWebhook("rejected", "rate_limited");
      await this.auditLogs?.record({
        organizationId,
        actorUserId: null,
        action: "webhook.request.rate_limited",
        resourceType: "Trigger",
        resourceId: triggerId,
        correlationId: this.requestContext.getCorrelationId(),
        metadata: {}
      });
      throw error;
    }
  }

  private async assertSignature(
    input: ReceiveWebhookInput,
    trigger: NonNullable<Awaited<ReturnType<WebhooksService["resolveTrigger"]>>>["trigger"],
    config: ReturnType<typeof normalizeStoredConfig>
  ) {
    if (!config.signature.enabled) return;
    const encryptedSecret = config.signature.encryptedSecret;
    if (!encryptedSecret || typeof encryptedSecret !== "string") {
      this.metrics.recordWebhook("rejected", "signature_failure");
      throw new UnauthorizedException("Webhook not found");
    }
    const signature = headerValue(input.headers[String(config.signature.signatureHeader).toLowerCase()] ?? input.headers[String(config.signature.signatureHeader)]);
    const timestamp = headerValue(input.headers[String(config.signature.timestampHeader).toLowerCase()] ?? input.headers[String(config.signature.timestampHeader)]);
    const nonce = headerValue(input.headers[String(config.signature.nonceHeader).toLowerCase()] ?? input.headers[String(config.signature.nonceHeader)]);
    const timestampMs = Number(timestamp) * 1000;
    const toleranceMs = Number(config.signature.toleranceSeconds ?? 300) * 1000;
    const validTimestamp = Number.isFinite(timestampMs) && Math.abs(Date.now() - timestampMs) <= toleranceMs;
    if (!signature || !nonce || !validTimestamp) {
      await this.recordSignatureFailure(trigger);
      throw new UnauthorizedException("Webhook not found");
    }
    const secret = this.crypto.decrypt(encryptedSecret);
    const signed = `${timestamp}.${nonce}.${input.rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", secret).update(signed).digest("hex");
    if (!constantTimeEqual(stripSignaturePrefix(signature), expected)) {
      await this.recordSignatureFailure(trigger);
      throw new UnauthorizedException("Webhook not found");
    }
    try {
      await this.prisma.webhookReplayNonce.create({
        data: {
          organizationId: trigger.organizationId,
          triggerId: trigger.id,
          nonce,
          expiresAt: new Date(Date.now() + toleranceMs)
        }
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        await this.recordSignatureFailure(trigger);
        throw new UnauthorizedException("Webhook not found");
      }
      throw error;
    }
  }

  private async recordSignatureFailure(trigger: { id: string; organizationId: string; workflowId: string }) {
    this.metrics.recordWebhook("rejected", "signature_failure");
    await this.auditLogs?.record({
      organizationId: trigger.organizationId,
      actorUserId: null,
      action: "webhook.signature.invalid",
      resourceType: "Trigger",
      resourceId: trigger.id,
      correlationId: this.requestContext.getCorrelationId(),
      metadata: { workflowId: trigger.workflowId }
    });
  }

  private async createExecutionClaim(input: {
    workflow: NonNullable<Awaited<ReturnType<WebhooksService["resolveTrigger"]>>>["workflow"];
    trigger: NonNullable<Awaited<ReturnType<WebhooksService["resolveTrigger"]>>>["trigger"];
    activeVersion: NonNullable<NonNullable<Awaited<ReturnType<WebhooksService["resolveTrigger"]>>>["workflow"]["activeVersion"]>;
    input: ReceiveWebhookInput;
    payload: unknown;
    sanitizedHeaders: Record<string, unknown>;
    sanitizedQuery: Record<string, unknown>;
    receivedAt: Date;
    payloadHash: string;
    requestHash: string;
    scope: string;
    idempotencyKey: string;
    correlationId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.idempotencyKey.create({
        data: {
          organizationId: input.workflow.organizationId,
          scope: input.scope,
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          status: "PROCESSING",
          lockedUntil: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
        }
      });

      const triggerContext = {
        body: input.payload,
        headers: input.sanitizedHeaders,
        query: input.sanitizedQuery,
        method: input.input.method.toUpperCase(),
        receivedAt: input.receivedAt.toISOString()
      };
      const webhookEvent = await tx.webhookEvent.create({
        data: {
          organizationId: input.workflow.organizationId,
          workflowId: input.workflow.id,
          triggerId: input.trigger.id,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
          correlationId: input.correlationId,
          method: input.input.method.toUpperCase(),
          queryJson: toPrismaJson(input.sanitizedQuery),
          requestHeadersJson: toPrismaJson(input.sanitizedHeaders),
          payloadJson: toPrismaJson(input.payload),
          payloadHash: input.payloadHash,
          sourceIp: input.input.sourceIp
        }
      });

      const execution = await tx.execution.create({
        data: {
          organizationId: input.workflow.organizationId,
          workflowId: input.workflow.id,
          workflowVersionId: input.activeVersion.id,
          webhookEventId: webhookEvent.id,
          correlationId: input.correlationId,
          status: ExecutionStatus.Pending,
          executionMode: ExecutionMode.Real,
          inputJson: toPrismaJson({ trigger: triggerContext, metadata: {} }),
          contextJson: toPrismaJson({ trigger: triggerContext, steps: {}, metadata: {} })
        }
      });

      const response = { accepted: true, executionId: execution.id, correlationId: execution.correlationId };
      await tx.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId: input.workflow.organizationId, scope: input.scope, key: input.idempotencyKey } },
        data: { responseJson: toPrismaJson(response) }
      });
      await tx.trigger.update({
        where: { id: input.trigger.id },
        data: { lastReceivedAt: input.receivedAt, lastExecutionId: execution.id }
      });
      await this.auditLogs?.record(
        {
          organizationId: input.workflow.organizationId,
          actorUserId: null,
          action: "webhook.request.accepted",
          resourceType: "Trigger",
          resourceId: input.trigger.id,
          correlationId: input.correlationId,
          metadata: { workflowId: input.workflow.id, workflowVersionId: input.activeVersion.id }
        },
        tx
      );
      return { execution };
    });
  }

  private async retryFailedEnqueue(organizationId: string, scope: string, key: string, response: Prisma.JsonValue) {
    const executionId = (response as any).executionId as string | undefined;
    if (!executionId) throw new ServiceUnavailableException("Idempotent request is not recoverable");
    const execution = await this.prisma.execution.findFirst({ where: { id: executionId, organizationId } });
    if (!execution) throw new ServiceUnavailableException("Execution is not recoverable");
    const correlationId = execution.correlationId ?? (await this.ensureExecutionCorrelationId(execution.id));
    await this.queueService.enqueueExecution({
      organizationId,
      executionId,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId ?? undefined,
      requestId: this.requestContext.getRequestId(),
      correlationId,
      enqueuedAt: new Date().toISOString(),
      executionMode: ExecutionMode.Real
    });
    const accepted = { accepted: true, executionId, correlationId };
    await this.prisma.$transaction([
      this.prisma.execution.update({ where: { id: executionId }, data: { status: ExecutionStatus.Queued, errorJson: Prisma.JsonNull } }),
      this.prisma.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId, scope, key } },
        data: { status: "ENQUEUED", responseJson: toPrismaJson(accepted) }
      })
    ]);
    return accepted;
  }

  private async authoritativeResponse(organizationId: string, response: Prisma.JsonValue) {
    const executionId = (response as any).executionId as string | undefined;
    const fallbackCorrelationId = (response as any).correlationId as string | undefined;
    if (!executionId) return response as any;
    const execution = await this.prisma.execution.findFirst({ where: { id: executionId, organizationId } });
    const correlationId = execution?.correlationId ?? fallbackCorrelationId ?? (execution ? await this.ensureExecutionCorrelationId(execution.id) : this.requestContext.getCorrelationId());
    this.requestContext.setCorrelationId(correlationId);
    return { ...(response as any), accepted: true, executionId, correlationId };
  }

  private async ensureExecutionCorrelationId(executionId: string) {
    const candidate = newTraceId();
    await this.prisma.execution.updateMany({ where: { id: executionId, correlationId: null }, data: { correlationId: candidate } });
    const execution = await this.prisma.execution.findUniqueOrThrow({ where: { id: executionId }, select: { correlationId: true } });
    return execution.correlationId ?? candidate;
  }

  private async waitForIdempotentResponse(organizationId: string, scope: string, key: string, requestHash: string) {
    const existing = await this.waitForExisting(organizationId, scope, key);
    if (!existing) throw new ConflictException("Webhook request is still being processed");
    if (existing.requestHash !== requestHash) throw new ConflictException("Idempotency key was already used with a different payload");
    if (!existing.responseJson) throw new ConflictException("Webhook request is still being processed");
    return this.authoritativeResponse(organizationId, existing.responseJson);
  }

  private async waitForExisting(organizationId: string, scope: string, key: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { organizationId_scope_key: { organizationId, scope, key } }
      });
      if (!existing || existing.responseJson) return existing;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.prisma.idempotencyKey.findUnique({
      where: { organizationId_scope_key: { organizationId, scope, key } }
    });
  }

  private async resolveTrigger(publicId: string, token: string) {
    const trigger = await this.prisma.trigger.findFirst({
      where: { id: publicId, type: "webhook", deletedAt: null },
      include: { workflow: { include: { activeVersion: true } } }
    });
    if (trigger?.tokenHash && this.tokenService.verifyToken(token, trigger.tokenHash)) {
      return { trigger, workflow: trigger.workflow };
    }

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: publicId },
      include: { activeVersion: true, triggers: { where: { type: "webhook", deletedAt: null } } }
    });
    const legacyTrigger = workflow?.triggers.find((candidate) => candidate.tokenHash && this.tokenService.verifyToken(token, candidate.tokenHash));
    return workflow && legacyTrigger ? { trigger: legacyTrigger, workflow } : undefined;
  }
}

function validateVersionDefinition(value: unknown) {
  const definition = isRecord(value) ? value : {};
  if (definition.workflowDefinitionSchemaVersion === 2) {
    validateWorkflowGraph((definition.steps as Array<{ key: string; type: string; config: Record<string, unknown> }>) ?? [], definition.graph as Record<string, unknown>);
  }
}

function validatePayload(body: unknown, rawBody: Buffer, limits: ReturnType<typeof normalizeStoredConfig>["payloadLimits"]) {
  if (rawBody.byteLength > Number(limits.maxBytes)) throwPayload("Webhook payload is too large");
  if (limits.requireBody && (body === undefined || body === null || (isRecord(body) && Object.keys(body).length === 0))) {
    throw new BadRequestException("Webhook payload is required");
  }
  const stats = walkPayload(body, limits);
  if (stats.tooDeep) throw new BadRequestException("Webhook payload exceeds maximum depth");
  if (stats.keys > Number(limits.maxKeys)) throw new BadRequestException("Webhook payload has too many keys");
}

function walkPayload(value: unknown, limits: ReturnType<typeof normalizeStoredConfig>["payloadLimits"], depth = 0): { keys: number; tooDeep: boolean } {
  if (depth > Number(limits.maxDepth)) return { keys: 0, tooDeep: true };
  if (typeof value === "string" && value.length > Number(limits.maxStringLength)) throw new BadRequestException("Webhook payload string is too long");
  if (!value || typeof value !== "object") return { keys: 0, tooDeep: false };
  if (Array.isArray(value)) {
    if (value.length > Number(limits.maxArrayLength)) throw new BadRequestException("Webhook payload array is too long");
    return value.reduce<{ keys: number; tooDeep: boolean }>(
      (acc, entry) => {
        const next = walkPayload(entry, limits, depth + 1);
        return { keys: acc.keys + next.keys, tooDeep: acc.tooDeep || next.tooDeep };
      },
      { keys: 0, tooDeep: false }
    );
  }
  return Object.entries(value as Record<string, unknown>).reduce<{ keys: number; tooDeep: boolean }>(
    (acc, [, entry]) => {
      const next = walkPayload(entry, limits, depth + 1);
      return { keys: acc.keys + 1 + next.keys, tooDeep: acc.tooDeep || next.tooDeep };
    },
    { keys: 0, tooDeep: false }
  );
}

function throwPayload(message: string): never {
  throw new PayloadTooLargeException(message);
}

function sanitizePayload(value: unknown, limits: ReturnType<typeof normalizeStoredConfig>["payloadLimits"], depth = 0): unknown {
  if (depth > Number(limits.maxDepth)) return { truncated: true, reason: "max_depth" };
  if (typeof value === "string") return value.length > Number(limits.maxStringLength) ? value.slice(0, Number(limits.maxStringLength)) : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, Number(limits.maxArrayLength)).map((entry) => sanitizePayload(entry, limits, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>).slice(0, Number(limits.maxKeys));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sanitizePayload(entry, limits, depth + 1)]));
}

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>) {
  const blocked = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-flowmind-signature",
    "x-flowmind-nonce",
    "x-forwarded-authorization"
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => {
        const lower = key.toLowerCase();
        return !blocked.has(lower) && !lower.includes("token") && !lower.includes("secret");
      })
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.slice(0, 10).join(",") : value])
  );
}

function sanitizeQuery(query: Record<string, unknown>) {
  const blocked = /token|secret|password|authorization|cookie|api[-_]?key/i;
  return Object.fromEntries(Object.entries(query ?? {}).filter(([key]) => !blocked.test(key)));
}

function sanitizeIdempotencyKey(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(trimmed) ? trimmed : undefined;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function stripSignaturePrefix(value: string) {
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
