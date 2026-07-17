import { createHash } from "node:crypto";
import { Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { newTraceId } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { ExecutionStatus } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { WebhookTokenService } from "../triggers/webhook-token.service";
import { WebhookRateLimitService } from "./webhook-rate-limit.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";

interface ReceiveWebhookInput {
  workflowId: string;
  token: string;
  headers: Record<string, string | string[] | undefined>;
  sourceIp: string;
  body: unknown;
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
    private readonly metrics: ApiMetricsService
  ) {}

  async receive(input: ReceiveWebhookInput) {
    const requestId = this.requestContext.getRequestId();
    const correlationId = this.requestContext.getCorrelationId();
    try {
      await this.rateLimitService.assertAllowed(`pre:${input.workflowId}:${input.sourceIp}`, this.rateLimitService.burstMax());
    } catch (error) {
      this.metrics.recordWebhook("rejected", "rate_limited");
      throw error;
    }
    const workflow = await this.loadWorkflow(input.workflowId);
    if (!workflow || !workflow.activeVersion) {
      this.metrics.recordWebhook("rejected", "inactive_workflow");
      this.logger.warn("api.webhook.rejected", { workflowId: input.workflowId, reason: "active_workflow_not_found" });
      throw new NotFoundException("Active workflow not found");
    }

    const trigger = workflow.triggers.find((candidate) => this.tokenService.verifyToken(input.token, candidate.tokenHash));
    if (!trigger) {
      this.metrics.recordWebhook("rejected", "invalid_token");
      this.logger.warn("api.webhook.rejected", { workflowId: workflow.id, organizationId: workflow.organizationId, reason: "invalid_token" });
      throw new UnauthorizedException("Invalid webhook token");
    }
    try {
      await this.rateLimitService.assertAllowed(`trigger:${workflow.organizationId}:${workflow.id}:${trigger.id}:${input.sourceIp}`);
    } catch (error) {
      this.metrics.recordWebhook("rejected", "rate_limited");
      throw error;
    }

    const payloadHash = sha256(JSON.stringify(input.body));
    const headerKey = headerValue(input.headers["idempotency-key"]);
    const idempotencyKey = headerKey ?? `${workflow.id}:${payloadHash}`;
    const scope = `webhook:${workflow.id}`;

    const existing = await this.waitForExisting(workflow.organizationId, scope, idempotencyKey);
    if (existing?.responseJson && ["PROCESSING", "ENQUEUED"].includes(existing.status)) {
      this.metrics.recordWebhook("accepted", "duplicate");
      return this.authoritativeResponse(workflow.organizationId, existing.responseJson);
    }
    if (existing?.status === "FAILED" && existing.responseJson) {
      this.metrics.recordWebhook("accepted", "duplicate");
      return this.retryFailedEnqueue(workflow.organizationId, scope, idempotencyKey, existing.responseJson);
    }

    const result = await this.createExecutionClaim(workflow, trigger.id, input, payloadHash, scope, idempotencyKey);

    try {
      await this.queueService.enqueueExecution({
        organizationId: workflow.organizationId,
        executionId: result.execution.id,
        workflowId: workflow.id,
        workflowVersionId: workflow.activeVersion.id,
        requestId,
        correlationId: result.execution.correlationId ?? correlationId,
        enqueuedAt: new Date().toISOString()
      });
      const response = { accepted: true, executionId: result.execution.id, correlationId: result.execution.correlationId ?? correlationId };
      await this.prisma.$transaction([
        this.prisma.execution.update({ where: { id: result.execution.id }, data: { status: ExecutionStatus.Queued } }),
        this.prisma.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId: workflow.organizationId, scope, key: idempotencyKey } },
          data: { status: "ENQUEUED", responseJson: toPrismaJson(response), lockedUntil: null }
        })
      ]);
      this.logger.info("api.webhook.accepted", {
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        workflowVersionId: workflow.activeVersion.id,
        executionId: result.execution.id
      });
      this.metrics.recordWebhook("accepted", "accepted");
      return response;
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.execution.update({
          where: { id: result.execution.id },
          data: { status: ExecutionStatus.Failed, errorJson: toPrismaJson({ message: "Failed to enqueue execution" }) }
        }),
        this.prisma.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId: workflow.organizationId, scope, key: idempotencyKey } },
          data: {
            status: "FAILED",
            responseJson: toPrismaJson({ accepted: false, executionId: result.execution.id }),
            lockedUntil: null
          }
        })
      ]);
      this.logger.error("api.execution.enqueue_failed", {
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        executionId: result.execution.id
      });
      this.metrics.recordWebhook("rejected", "enqueue_failed");
      this.metrics.recordEnqueueFailure("webhook", classifyError(error));
      throw new ServiceUnavailableException("Execution could not be queued");
    }
  }

  private async createExecutionClaim(
    workflow: NonNullable<Awaited<ReturnType<WebhooksService["loadWorkflow"]>>>,
    triggerId: string,
    input: ReceiveWebhookInput,
    payloadHash: string,
    scope: string,
    idempotencyKey: string
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.idempotencyKey.create({
          data: {
            organizationId: workflow.organizationId,
            scope,
            key: idempotencyKey,
            requestHash: payloadHash,
            status: "PROCESSING",
            lockedUntil: new Date(Date.now() + 60_000),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          }
        });

        const webhookEvent = await tx.webhookEvent.create({
          data: {
            organizationId: workflow.organizationId,
            workflowId: workflow.id,
            triggerId,
            idempotencyKey,
            requestId: this.requestContext.getRequestId(),
            correlationId: this.requestContext.getCorrelationId(),
            requestHeadersJson: toPrismaJson(sanitizeHeaders(input.headers)),
            payloadJson: toPrismaJson(input.body),
            payloadHash,
            sourceIp: input.sourceIp
          }
        });

        const execution = await tx.execution.create({
          data: {
            organizationId: workflow.organizationId,
            workflowId: workflow.id,
            workflowVersionId: workflow.activeVersion!.id,
            webhookEventId: webhookEvent.id,
            correlationId: this.requestContext.getCorrelationId(),
            status: ExecutionStatus.Pending,
            inputJson: toPrismaJson({ trigger: { body: input.body, headers: sanitizeHeaders(input.headers) } }),
            contextJson: toPrismaJson({ trigger: { body: input.body }, steps: {}, metadata: {} })
          }
        });

        await tx.idempotencyKey.update({
          where: {
            organizationId_scope_key: {
              organizationId: workflow.organizationId,
              scope,
              key: idempotencyKey
            }
          },
          data: { responseJson: toPrismaJson({ accepted: true, executionId: execution.id, correlationId: execution.correlationId }) }
        });
        return { execution };
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        const existing = await this.waitForExisting(workflow.organizationId, scope, idempotencyKey);
        if (existing?.responseJson) {
          const response = await this.authoritativeResponse(workflow.organizationId, existing.responseJson);
          return { execution: { id: response.executionId, correlationId: response.correlationId } };
        }
      }
      throw error;
    }
  }

  private async retryFailedEnqueue(organizationId: string, scope: string, key: string, response: Prisma.JsonValue) {
    const executionId = (response as any).executionId as string | undefined;
    if (!executionId) {
      throw new ServiceUnavailableException("Idempotent request is not recoverable");
    }
    const execution = await this.prisma.execution.findFirst({ where: { id: executionId, organizationId } });
    if (!execution) {
      throw new ServiceUnavailableException("Execution is not recoverable");
    }
    await this.queueService.enqueueExecution({
      organizationId,
      executionId,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId ?? undefined,
      requestId: this.requestContext.getRequestId(),
      correlationId: execution.correlationId ?? (await this.ensureExecutionCorrelationId(execution.id)),
      enqueuedAt: new Date().toISOString()
    });
    const accepted = { accepted: true, executionId, correlationId: execution.correlationId ?? (await this.ensureExecutionCorrelationId(execution.id)) };
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
    if (!executionId) {
      return response as any;
    }
    const execution = await this.prisma.execution.findFirst({ where: { id: executionId, organizationId } });
    const correlationId = execution?.correlationId ?? fallbackCorrelationId ?? (execution ? await this.ensureExecutionCorrelationId(execution.id) : this.requestContext.getCorrelationId());
    this.requestContext.setCorrelationId(correlationId);
    return { ...(response as any), executionId, correlationId };
  }

  private async ensureExecutionCorrelationId(executionId: string) {
    const candidate = newTraceId();
    await this.prisma.execution.updateMany({ where: { id: executionId, correlationId: null }, data: { correlationId: candidate } });
    const execution = await this.prisma.execution.findUniqueOrThrow({ where: { id: executionId }, select: { correlationId: true } });
    return execution.correlationId ?? candidate;
  }

  private async waitForExisting(organizationId: string, scope: string, key: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { organizationId_scope_key: { organizationId, scope, key } }
      });
      if (!existing || existing.responseJson) {
        return existing;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.prisma.idempotencyKey.findUnique({
      where: { organizationId_scope_key: { organizationId, scope, key } }
    });
  }

  private loadWorkflow(workflowId: string) {
    return this.prisma.workflow.findFirst({
      where: { id: workflowId, status: "ACTIVE" },
      include: { activeVersion: true, triggers: { where: { enabled: true, type: "webhook" } } }
    });
  }
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>) {
  const blocked = new Set(["authorization", "cookie", "set-cookie"]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}
