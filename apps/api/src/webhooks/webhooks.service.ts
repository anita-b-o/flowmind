import { createHash, randomUUID } from "node:crypto";
import { Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ExecutionStatus } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { WebhookTokenService } from "../triggers/webhook-token.service";
import { WebhookRateLimitService } from "./webhook-rate-limit.service";

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
    private readonly rateLimitService: WebhookRateLimitService
  ) {}

  async receive(input: ReceiveWebhookInput) {
    await this.rateLimitService.assertAllowed(`pre:${input.workflowId}:${input.sourceIp}`, this.rateLimitService.burstMax());
    const workflow = await this.loadWorkflow(input.workflowId);
    if (!workflow || !workflow.activeVersion) {
      throw new NotFoundException("Active workflow not found");
    }

    const trigger = workflow.triggers.find((candidate) => this.tokenService.verifyToken(input.token, candidate.tokenHash));
    if (!trigger) {
      throw new UnauthorizedException("Invalid webhook token");
    }
    await this.rateLimitService.assertAllowed(`trigger:${workflow.organizationId}:${workflow.id}:${trigger.id}:${input.sourceIp}`);

    const payloadHash = sha256(JSON.stringify(input.body));
    const headerKey = headerValue(input.headers["idempotency-key"]);
    const idempotencyKey = headerKey ?? `${workflow.id}:${payloadHash}`;
    const scope = `webhook:${workflow.id}`;

    const existing = await this.waitForExisting(workflow.organizationId, scope, idempotencyKey);
    if (existing?.responseJson && ["PROCESSING", "ENQUEUED"].includes(existing.status)) {
      return existing.responseJson;
    }
    if (existing?.status === "FAILED" && existing.responseJson) {
      return this.retryFailedEnqueue(workflow.organizationId, scope, idempotencyKey, existing.responseJson);
    }

    const result = await this.createExecutionClaim(workflow, trigger.id, input, payloadHash, scope, idempotencyKey);

    try {
      await this.queueService.enqueueExecution({
        organizationId: workflow.organizationId,
        executionId: result.execution.id,
        workflowId: workflow.id,
        workflowVersionId: workflow.activeVersion.id,
        requestId: randomUUID()
      });
      const response = { accepted: true, executionId: result.execution.id };
      await this.prisma.$transaction([
        this.prisma.execution.update({ where: { id: result.execution.id }, data: { status: ExecutionStatus.Queued } }),
        this.prisma.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId: workflow.organizationId, scope, key: idempotencyKey } },
          data: { status: "ENQUEUED", responseJson: toPrismaJson(response), lockedUntil: null }
        })
      ]);
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
        data: { responseJson: toPrismaJson({ accepted: true, executionId: execution.id }) }
      });
      return { execution };
    });
    } catch (error: any) {
      if (error?.code === "P2002") {
        const existing = await this.waitForExisting(workflow.organizationId, scope, idempotencyKey);
        if (existing?.responseJson) {
          return { execution: { id: (existing.responseJson as any).executionId } };
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
      workflowVersionId: execution.workflowVersionId,
      requestId: randomUUID()
    });
    const accepted = { accepted: true, executionId };
    await this.prisma.$transaction([
      this.prisma.execution.update({ where: { id: executionId }, data: { status: ExecutionStatus.Queued, errorJson: Prisma.JsonNull } }),
      this.prisma.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId, scope, key } },
        data: { status: "ENQUEUED", responseJson: toPrismaJson(accepted) }
      })
    ]);
    return accepted;
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
