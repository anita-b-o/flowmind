import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ExecutionMode, ExecutionStatus } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { sanitizePublic } from "../common/public-sanitizer";
import { publicDeadLetterReason } from "../dead-letter/dead-letter-reasons";

@Injectable()
export class ExecutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly requestContext?: RequestContextService,
    private readonly logger?: StructuredLoggerService,
    private readonly metrics?: ApiMetricsService,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async list(organizationId: string, query: ListExecutionsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const where: Prisma.ExecutionWhereInput = {
      organizationId,
      executionMode: ExecutionMode.Real,
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
      where: { id: executionId, organizationId, executionMode: ExecutionMode.Real },
      include: {
        workflow: { select: { id: true, name: true, status: true } },
        workflowVersion: { select: { id: true, versionNumber: true, status: true, createdAt: true } },
        steps: { orderBy: { createdAt: "asc" } },
        retryOfExecution: { select: { id: true, status: true, createdAt: true, completedAt: true, correlationId: true } },
        retryExecutions: { select: { id: true, status: true, createdAt: true, completedAt: true, correlationId: true }, orderBy: { createdAt: "desc" } },
        deadLetters: {
          select: {
            id: true,
            reason: true,
            failedStepKey: true,
            attempts: true,
            createdAt: true,
            resolvedAt: true,
            resolution: true,
            retryExecutionId: true
          },
          orderBy: { createdAt: "desc" }
        }
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
      error: sanitizePublic(execution.errorJson),
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs: durationMs(execution.startedAt, execution.completedAt),
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      retryRequestedAt: execution.retryRequestedAt,
      retryReason: execution.retryReason,
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
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs,
        errorCategory: (step.errorJson as any)?.classification ?? null,
        error: sanitizePublic(step.errorJson),
        output: sanitizePayload(step.outputJson)
      }))
      ,
      retryOfExecutionId: execution.retryOfExecutionId,
      retryOfExecution: execution.retryOfExecution,
      retryExecutions: execution.retryExecutions,
      deadLetter: execution.deadLetters.find((item) => !item.resolvedAt)
        ? formatDeadLetter(execution.deadLetters.find((item) => !item.resolvedAt)!)
        : null,
      deadLetters: execution.deadLetters.map(formatDeadLetter)
    };
  }

  async retry(organizationId: string, userId: string, executionId: string, reason?: string) {
    const original = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId, executionMode: ExecutionMode.Real },
      include: { deadLetters: { where: { resolvedAt: null } } }
    });
    if (!original) {
      this.metrics?.recordManualRetry("not_found");
      throw new NotFoundException("Execution not found");
    }
    const eligible = original.status === ExecutionStatus.Failed || original.deadLetters.length > 0;
    if (!eligible) {
      this.metrics?.recordManualRetry("conflict");
      throw new BadRequestException("Execution is not retryable");
    }
    const activeRetry = await this.prisma.execution.findFirst({
      where: {
        retryOfExecutionId: original.id,
        organizationId,
        status: { in: [ExecutionStatus.Pending, ExecutionStatus.Queued, ExecutionStatus.Running, ExecutionStatus.Retrying] }
      }
    });
    if (activeRetry) {
      this.metrics?.recordManualRetry("conflict");
      throw new ConflictException({
        message: "A retry is already active for this execution",
        execution: {
          id: activeRetry.id,
          status: activeRetry.status,
          retryOfExecutionId: activeRetry.retryOfExecutionId,
          correlationId: activeRetry.correlationId
        }
      });
    }

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
      const resolved = await tx.deadLetterExecution.findMany({
        where: { executionId: original.id, organizationId, resolvedAt: null },
        select: { id: true, reason: true }
      });
      await tx.deadLetterExecution.updateMany({
        where: { executionId: original.id, organizationId, resolvedAt: null },
        data: { resolvedAt: new Date(), resolution: "RETRIED", retryExecutionId: created.id }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "execution.retry_requested",
          resourceType: "Execution",
          resourceId: original.id,
          correlationId,
          metadata: {
            originalExecutionId: original.id,
            retryExecutionId: created.id,
            reason: reason ?? null
          }
        },
        tx
      );
      for (const deadLetter of resolved) {
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId: userId,
            action: "dead_letter.resolved",
            resourceType: "DeadLetterExecution",
            resourceId: deadLetter.id,
            correlationId,
            metadata: { reason: publicDeadLetterReason(deadLetter.reason), resolution: "RETRIED", retryExecutionId: created.id }
          },
          tx
        );
      }
      return created;
    });

    try {
      await this.queueService.enqueueExecution({
        organizationId,
        executionId: next.id,
        workflowId: next.workflowId,
        workflowVersionId: next.workflowVersionId ?? undefined,
        requestId: this.requestContext?.getRequestId() ?? `manual-retry-${next.id}`,
        correlationId: next.correlationId ?? correlationId,
        enqueuedAt: new Date().toISOString()
      });
    } catch (error) {
      this.metrics?.recordManualRetry("enqueue_failed");
      this.metrics?.recordEnqueueFailure("manual_retry", classifyError(error));
      throw new ServiceUnavailableException({
        message: "Retry execution was created but could not be enqueued immediately. It is recoverable by the reconciler.",
        recoverable: true,
        execution: retryResponse(next, original.id, correlationId).execution
      });
    }
    this.metrics?.recordManualRetry("success");
    this.logger?.info("api.execution.retry_requested", {
      organizationId,
      userId,
      executionId: original.id,
      retryExecutionId: next.id,
      workflowId: next.workflowId,
      workflowVersionId: next.workflowVersionId
    });
    return retryResponse(next, original.id, correlationId);
  }
}

function retryResponse(next: { id: string; status: string; retryOfExecutionId: string | null; correlationId: string | null }, originalId: string, correlationId: string) {
  return {
    execution: {
      id: next.id,
      status: next.status,
      retryOfExecutionId: next.retryOfExecutionId ?? originalId,
      correlationId: next.correlationId ?? correlationId
    }
  };
}

function formatDeadLetter(item: { id: string; reason: string; failedStepKey: string | null; attempts: number; createdAt: Date; resolvedAt: Date | null; resolution: string | null; retryExecutionId?: string | null }) {
  return {
    id: item.id,
    reason: publicDeadLetterReason(item.reason),
    failedStepKey: item.failedStepKey,
    attempts: item.attempts,
    active: !item.resolvedAt,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    retryExecutionId: item.retryExecutionId ?? null
  };
}

function durationMs(start?: Date | null, end?: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

function sanitizePayload(value: unknown) {
  return sanitizePublic(value);
}
