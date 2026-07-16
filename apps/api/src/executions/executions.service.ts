import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ExecutionStatus } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";

@Injectable()
export class ExecutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly requestContext?: RequestContextService,
    private readonly logger?: StructuredLoggerService
  ) {}

  async list(organizationId: string, query: ListExecutionsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.ExecutionWhereInput = {
      organizationId,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.execution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          workflowId: true,
          workflowVersionId: true,
          correlationId: true,
          status: true,
          startedAt: true,
        completedAt: true,
        createdAt: true,
        retryOfExecutionId: true
        }
      }),
      this.prisma.execution.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async getDetail(organizationId: string, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId },
      include: {
        workflow: { select: { id: true, name: true, status: true } },
        workflowVersion: { select: { id: true, versionNumber: true, status: true, createdAt: true } },
        steps: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!execution) {
      throw new NotFoundException("Execution not found");
    }
    return {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      workflow: execution.workflow,
      workflowVersion: execution.workflowVersion,
      status: execution.status,
      correlationId: execution.correlationId,
      input: sanitizePayload(execution.inputJson),
      context: sanitizePayload(execution.contextJson),
      error: execution.errorJson,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      steps: execution.steps.map((step) => ({
        id: step.id,
        workflowStepId: step.workflowStepId,
        stepKey: step.stepKey,
        stepType: step.stepType,
        status: step.status,
        attempt: step.attempt,
        attemptCount: step.attemptCount,
        maxAttempts: step.maxAttempts,
        nextRetryAt: step.nextRetryAt,
        effectStatus: step.effectStatus,
        output: step.outputJson,
        error: step.errorJson,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs
      }))
      ,
      retryOfExecutionId: execution.retryOfExecutionId,
      retryExecutions: await this.prisma.execution.findMany({
        where: { retryOfExecutionId: execution.id, organizationId },
        select: { id: true, status: true, createdAt: true, completedAt: true }
      }),
      deadLetter: await this.prisma.deadLetterExecution.findFirst({
        where: { executionId: execution.id, organizationId, resolvedAt: null },
        select: { id: true, reason: true, failedStepKey: true, attempts: true, createdAt: true, resolvedAt: true, resolution: true }
      }),
      isLocked: Boolean(execution.lockedUntil && execution.lockedUntil > new Date()),
      lockedUntil: execution.lockedUntil
    };
  }

  async retry(organizationId: string, userId: string, executionId: string, reason?: string) {
    const original = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId },
      include: { deadLetters: { where: { resolvedAt: null } } }
    });
    if (!original) throw new NotFoundException("Execution not found");
    const eligible = original.status === ExecutionStatus.Failed || original.deadLetters.length > 0;
    if (!eligible) throw new ConflictException("Execution is not retryable");
    const activeRetry = await this.prisma.execution.findFirst({
      where: {
        retryOfExecutionId: original.id,
        organizationId,
        status: { in: [ExecutionStatus.Pending, ExecutionStatus.Queued, ExecutionStatus.Running, ExecutionStatus.Retrying] }
      }
    });
    if (activeRetry) throw new ConflictException("A retry is already active for this execution");

    const correlationId = original.correlationId ?? this.requestContext?.getCorrelationId() ?? newTraceId();
    const next = await this.prisma.$transaction(async (tx) => {
      const created = await tx.execution.create({
        data: {
          organizationId,
          workflowId: original.workflowId,
          workflowVersionId: original.workflowVersionId,
          webhookEventId: original.webhookEventId,
          retryOfExecutionId: original.id,
          retryRequestedByUserId: userId,
          retryRequestedAt: new Date(),
          retryReason: reason,
          correlationId,
          status: ExecutionStatus.Queued,
          inputJson: original.inputJson as Prisma.InputJsonValue,
          contextJson: { trigger: (original.inputJson as any)?.trigger ?? {}, steps: {}, metadata: {} }
        }
      });
      await tx.deadLetterExecution.updateMany({
        where: { executionId: original.id, organizationId, resolvedAt: null },
        data: { resolvedAt: new Date(), resolution: "RETRIED", retryExecutionId: created.id }
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: userId,
          action: "execution.retry",
          resourceType: "execution",
          resourceId: original.id,
          correlationId,
          metadataJson: {
            originalExecutionId: original.id,
            retryExecutionId: created.id,
            reason: reason ?? null
          }
        }
      });
      return created;
    });

    await this.queueService.enqueueExecution({
      organizationId,
      executionId: next.id,
      workflowId: next.workflowId,
      workflowVersionId: next.workflowVersionId,
      requestId: this.requestContext?.getRequestId() ?? `manual-retry-${next.id}`,
      correlationId: next.correlationId ?? correlationId,
      enqueuedAt: new Date().toISOString()
    });
    this.logger?.info("api.execution.retry_requested", {
      organizationId,
      userId,
      executionId: original.id,
      retryExecutionId: next.id,
      workflowId: next.workflowId,
      workflowVersionId: next.workflowVersionId
    });
    return { executionId: next.id, retryOfExecutionId: original.id };
  }
}

function sanitizePayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (["authorization", "cookie", "set-cookie", "x-api-key"].includes(key.toLowerCase())) {
        return "[redacted]";
      }
      return entry;
    })
  );
}
