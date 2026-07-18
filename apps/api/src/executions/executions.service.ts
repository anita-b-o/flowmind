import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  ACTIVE_EXECUTION_STATUSES,
  ExecutionMode,
  ExecutionStatus,
  StepExecutionStatus,
  executionStatusFromPublic,
  isCancelableExecutionStatus,
  publicExecutionStatus
} from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { ListExecutionsQueryDto } from "./dto/list-executions-query.dto";
import { CreateManualExecutionDto } from "./dto/create-manual-execution.dto";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { sanitizePublic } from "../common/public-sanitizer";
import { publicDeadLetterReason } from "../dead-letter/dead-letter-reasons";
import { validateWorkflowGraph } from "../workflows/workflow-graph-validator";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

  async createManual(organizationId: string, userId: string, workflowId: string, dto: CreateManualExecutionDto, headerIdempotencyKey?: string) {
    if (dto.confirmRealEffects !== true) {
      this.metrics?.recordManualExecution("rejected");
      throw new BadRequestException("Manual execution requires real effects confirmation");
    }
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId, status: "ACTIVE", activeVersion: { status: "ACTIVE" } },
      include: { activeVersion: { include: { steps: { orderBy: { position: "asc" } } } } }
    });
    if (!workflow?.activeVersion) {
      this.metrics?.recordManualExecution("rejected");
      throw new BadRequestException("Workflow must have an active version before it can be executed");
    }
    validateVersionDefinition(workflow.activeVersion.definitionJson);

    const input = sanitizePayload({
      trigger: dto.input?.trigger ?? {},
      metadata: dto.input?.metadata ?? {}
    });
    const correlationId = this.requestContext?.getCorrelationId() ?? newTraceId();
    const key = sanitizeIdempotencyKey(headerIdempotencyKey ?? dto.idempotencyKey ?? this.requestContext?.getRequestId() ?? newTraceId());
    const scope = `manual-execution:${workflowId}`;
    const requestHash = sha256(JSON.stringify({ workflowId, input }));
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { organizationId_scope_key: { organizationId, scope, key } }
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.metrics?.recordManualExecution("conflict");
        throw new ConflictException("Idempotency key was already used with a different request");
      }
      if (existing.responseJson) {
        this.metrics?.recordManualExecution("success");
        return existing.responseJson as any;
      }
      this.metrics?.recordManualExecution("conflict");
      throw new ConflictException("A manual execution request with this idempotency key is still being processed");
    }

    const created = await this.createManualClaim({
      organizationId,
      userId,
      workflowId,
      workflowVersionId: workflow.activeVersion.id,
      versionNumber: workflow.activeVersion.versionNumber,
      scope,
      key,
      requestHash,
      input,
      correlationId
    }).catch(async (error) => {
      if ((error as any)?.code === "P2002") {
        const response = await this.waitForIdempotentResponse(organizationId, scope, key, requestHash);
        return { execution: { id: response.execution.id, workflowId, workflowVersionId: workflow.activeVersion!.id, correlationId } as any, response, alreadyHandled: true };
      }
      throw error;
    });
    if ("alreadyHandled" in created && created.alreadyHandled) {
      this.metrics?.recordManualExecution("success");
      return created.response;
    }

    try {
      await this.queueService.enqueueExecution({
        organizationId,
        executionId: created.execution.id,
        workflowId,
        workflowVersionId: workflow.activeVersion.id,
        requestId: this.requestContext?.getRequestId() ?? `manual-${created.execution.id}`,
        correlationId,
        enqueuedAt: new Date().toISOString(),
        executionMode: ExecutionMode.Real
      });
      await this.prisma.$transaction(async (tx) => {
        await tx.idempotencyKey.update({
          where: { organizationId_scope_key: { organizationId, scope, key } },
          data: { status: "ENQUEUED", responseJson: toJson(created.response) }
        });
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId: userId,
            action: "execution.enqueued",
            resourceType: "Execution",
            resourceId: created.execution.id,
            correlationId,
            metadata: { workflowId, workflowVersionId: workflow.activeVersion!.id, source: "manual" }
          },
          tx
        );
      });
      this.logger?.info("api.execution.manual_created", { organizationId, workflowId, workflowVersionId: workflow.activeVersion.id, executionId: created.execution.id });
      this.metrics?.recordManualExecution("success");
      return created.response;
    } catch (error) {
      this.metrics?.recordManualExecution("enqueue_failed");
      this.metrics?.recordEnqueueFailure("manual_retry", classifyError(error));
      await this.prisma.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId, scope, key } },
        data: { status: "FAILED", responseJson: toJson({ ...created.response, recoverable: true }) }
      });
      throw new ServiceUnavailableException({
        message: "Manual execution was created but could not be enqueued immediately. It is recoverable by the reconciler.",
        recoverable: true,
        execution: created.response.execution
      });
    }
  }

  async list(organizationId: string, query: ListExecutionsQueryDto) {
    assertDateRange(query.from, query.to);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const status = query.status ? executionStatusFromPublic(query.status) : undefined;
    if (query.status && !status) throw new BadRequestException("Invalid execution status");
    const where: Prisma.ExecutionWhereInput = {
      organizationId,
      executionMode: ExecutionMode.Real,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(status ? { status: status as ExecutionStatus } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.execution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          workflow: { select: { id: true, name: true } },
          workflowVersion: { select: { id: true, versionNumber: true } },
          startedBy: { select: { id: true, name: true, email: true } },
          _count: { select: { steps: true } }
        }
      }),
      this.prisma.execution.count({ where })
    ]);
    const stepCounts = await this.stepCounts(items.map((item) => item.id));
    return {
      items: items.map((item) => summary(item, stepCounts.get(item.id))),
      page,
      pageSize,
      total
    };
  }

  async getDetail(organizationId: string, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId, executionMode: ExecutionMode.Real },
      include: {
        workflow: { select: { id: true, name: true, status: true } },
        workflowVersion: { select: { id: true, versionNumber: true, status: true, createdAt: true, definitionJson: true } },
        startedBy: { select: { id: true, name: true, email: true } },
        cancelRequestedBy: { select: { id: true, name: true, email: true } },
        steps: { orderBy: [{ workflowStep: { position: "asc" } }, { createdAt: "asc" }] },
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
    if (!execution) throw new NotFoundException("Execution not found");
    const counts = (await this.stepCounts([execution.id])).get(execution.id);
    return {
      ...summary(execution as any, counts),
      workflow: execution.workflow,
      workflowVersion: execution.workflowVersion
        ? {
            id: execution.workflowVersion.id,
            versionNumber: execution.workflowVersion.versionNumber,
            status: execution.workflowVersion.status,
            createdAt: execution.workflowVersion.createdAt,
            definitionSchemaVersion: (execution.workflowVersion.definitionJson as any)?.workflowDefinitionSchemaVersion ?? 1
          }
        : null,
      workflowSnapshot: execution.workflowVersion
        ? {
            workflowVersionId: execution.workflowVersion.id,
            versionNumber: execution.workflowVersion.versionNumber,
            definitionSchemaVersion: (execution.workflowVersion.definitionJson as any)?.workflowDefinitionSchemaVersion ?? 1
          }
        : null,
      input: sanitizePayload(execution.inputJson),
      context: sanitizePayload(execution.contextJson),
      error: sanitizePublic(execution.errorJson),
      updatedAt: execution.updatedAt,
      cancelRequestedAt: execution.cancelRequestedAt,
      cancelledAt: execution.cancelledAt,
      cancelReason: execution.cancelReason,
      cancelRequestedBy: actor(execution.cancelRequestedBy),
      retryRequestedAt: execution.retryRequestedAt,
      retryReason: execution.retryReason,
      steps: execution.steps.map((step) => ({
        id: step.id,
        workflowStepId: step.workflowStepId,
        stepKey: step.stepKey,
        stepType: step.stepType,
        executionPath: step.executionPath,
        iterationIndex: step.iterationIndex,
        status: step.status,
        publicStatus: step.status === StepExecutionStatus.Retrying ? "waiting" : publicStepStatus(step.status),
        attempt: step.attempt,
        attemptCount: step.attemptCount,
        maxAttempts: step.maxAttempts,
        nextRetryAt: step.nextRetryAt,
        effectStatus: step.effectStatus,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        finishedAt: step.completedAt,
        durationMs: step.durationMs,
        errorCategory: (step.errorJson as any)?.classification ?? null,
        error: sanitizePublic(step.errorJson),
        input: step.stepType === "for_each" ? loopInputSummary(step.inputJson) : sanitizePayload(step.inputJson),
        output: sanitizePayload(step.outputJson),
        providerMetadata: sanitizePayload((step.debugJson as any)?.connection ?? null)
      })),
      retryOfExecutionId: execution.retryOfExecutionId,
      retryOfExecution: relation(execution.retryOfExecution),
      retryExecutions: execution.retryExecutions.map(relation),
      deadLetter: execution.deadLetters.find((item) => !item.resolvedAt)
        ? formatDeadLetter(execution.deadLetters.find((item) => !item.resolvedAt)!)
        : null,
      deadLetters: execution.deadLetters.map(formatDeadLetter)
    };
  }

  async cancel(organizationId: string, userId: string, executionId: string, reason?: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId, executionMode: ExecutionMode.Real },
      select: { id: true, status: true, correlationId: true, workflowId: true, workflowVersionId: true, cancelRequestedAt: true }
    });
    if (!execution) {
      this.metrics?.recordExecutionCancel("not_found");
      throw new NotFoundException("Execution not found");
    }
    if (!isCancelableExecutionStatus(execution.status)) {
      this.metrics?.recordExecutionCancel("conflict");
      throw new ConflictException({ message: "Execution is already terminal", execution: { id: execution.id, status: execution.status, publicStatus: publicExecutionStatus(execution.status) } });
    }
    const now = new Date();
    const result = await this.prisma.execution.updateMany({
      where: { id: executionId, organizationId, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
      data: {
        status: ExecutionStatus.Cancelled,
        completedAt: now,
        cancelledAt: now,
        cancelRequestedAt: execution.cancelRequestedAt ?? now,
        cancelRequestedByUserId: userId,
        cancelReason: reason,
        lockedBy: null,
        lockedUntil: null,
        lastHeartbeatAt: null
      }
    });
    const updated = await this.prisma.execution.findUniqueOrThrow({ where: { id: executionId } });
    if (result.count === 1) {
      this.metrics?.recordExecutionCancel("success");
      await this.auditLogs?.record({
        organizationId,
        actorUserId: userId,
        action: "execution.cancel_requested",
        resourceType: "Execution",
        resourceId: executionId,
        correlationId: execution.correlationId,
        metadata: { workflowId: execution.workflowId, workflowVersionId: execution.workflowVersionId, reason: reason ?? null }
      });
      await this.auditLogs?.record({
        organizationId,
        actorUserId: userId,
        action: "execution.cancelled",
        resourceType: "Execution",
        resourceId: executionId,
        correlationId: execution.correlationId,
        metadata: { workflowId: execution.workflowId, workflowVersionId: execution.workflowVersionId }
      });
    }
    return { execution: cancelResponse(updated) };
  }

  async retry(organizationId: string, userId: string, executionId: string, reason?: string, idempotencyKey?: string) {
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
      throw new ConflictException("Execution is not retryable");
    }
    const existingIdempotent = idempotencyKey
      ? await this.prisma.idempotencyKey.findUnique({
          where: { organizationId_scope_key: { organizationId, scope: `retry:${original.id}`, key: sanitizeIdempotencyKey(idempotencyKey) } }
        })
      : null;
    if (existingIdempotent?.responseJson) return existingIdempotent.responseJson as any;

    const activeRetry = await this.prisma.execution.findFirst({
      where: {
        retryOfExecutionId: original.id,
        organizationId,
        status: { in: ACTIVE_EXECUTION_STATUSES as any }
      }
    });
    if (activeRetry) {
      this.metrics?.recordManualRetry("conflict");
      throw new ConflictException({
        message: "A retry is already active for this execution",
        execution: {
          id: activeRetry.id,
          status: activeRetry.status,
          publicStatus: publicExecutionStatus(activeRetry.status),
          retryOfExecutionId: activeRetry.retryOfExecutionId,
          correlationId: activeRetry.correlationId
        }
      });
    }

    const correlationId = original.correlationId ?? this.requestContext?.getCorrelationId() ?? newTraceId();
    const idemKey = idempotencyKey ? sanitizeIdempotencyKey(idempotencyKey) : undefined;
    const next = await this.prisma.$transaction(async (tx) => {
      if (idemKey) {
        await tx.idempotencyKey.create({
          data: {
            organizationId,
            scope: `retry:${original.id}`,
            key: idemKey,
            requestHash: sha256(JSON.stringify({ reason: reason ?? null })),
            status: "PROCESSING",
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
          }
        });
      }
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
          executionMode: ExecutionMode.Real,
          inputJson: original.inputJson as Prisma.InputJsonValue,
          contextJson: toJson({ trigger: (original.inputJson as any)?.trigger ?? {}, steps: {}, metadata: {} })
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
          metadata: { originalExecutionId: original.id, retryExecutionId: created.id, reason: reason ?? null }
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
    const response = retryResponse(next, original.id, correlationId);
    if (idemKey) {
      await this.prisma.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId, scope: `retry:${original.id}`, key: idemKey } },
        data: { status: "ENQUEUED", responseJson: toJson(response) }
      });
    }
    this.metrics?.recordManualRetry("success");
    this.logger?.info("api.execution.retry_requested", { organizationId, userId, executionId: original.id, retryExecutionId: next.id, workflowId: next.workflowId });
    return response;
  }

  private async stepCounts(executionIds: string[]) {
    if (!executionIds.length) return new Map<string, StepCount>();
    const rows = await this.prisma.stepExecution.groupBy({
      by: ["executionId", "status"],
      where: { executionId: { in: executionIds } },
      _count: { _all: true }
    });
    const map = new Map<string, StepCount>();
    for (const row of rows) {
      const count = map.get(row.executionId) ?? { total: 0, completed: 0, failed: 0 };
      count.total += row._count._all;
      if (row.status === StepExecutionStatus.Completed || row.status === StepExecutionStatus.Skipped) count.completed += row._count._all;
      if (row.status === StepExecutionStatus.Failed) count.failed += row._count._all;
      map.set(row.executionId, count);
    }
    return map;
  }

  private async createManualClaim(input: {
    organizationId: string;
    userId: string;
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    scope: string;
    key: string;
    requestHash: string;
    input: unknown;
    correlationId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.idempotencyKey.create({
        data: {
          organizationId: input.organizationId,
          scope: input.scope,
          key: input.key,
          requestHash: input.requestHash,
          status: "PROCESSING",
          lockedUntil: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
        }
      });
      const execution = await tx.execution.create({
        data: {
          organizationId: input.organizationId,
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          correlationId: input.correlationId,
          status: ExecutionStatus.Queued,
          executionMode: ExecutionMode.Real,
          startedByUserId: input.userId,
          manualExecutionKey: input.key,
          inputJson: toJson(input.input),
          contextJson: toJson({ trigger: (input.input as any).trigger ?? {}, steps: {}, metadata: (input.input as any).metadata ?? {} })
        }
      });
      await this.auditLogs?.record(
        {
          organizationId: input.organizationId,
          actorUserId: input.userId,
          action: "execution.created",
          resourceType: "Execution",
          resourceId: execution.id,
          correlationId: input.correlationId,
          metadata: { workflowId: input.workflowId, workflowVersionId: input.workflowVersionId, mode: ExecutionMode.Real, source: "manual" }
        },
        tx
      );
      const response = manualExecutionResponse(execution, input.versionNumber);
      await tx.idempotencyKey.update({
        where: { organizationId_scope_key: { organizationId: input.organizationId, scope: input.scope, key: input.key } },
        data: { status: "PROCESSING", responseJson: toJson(response), lockedUntil: null }
      });
      return { execution, response };
    });
  }

  private async waitForIdempotentResponse(organizationId: string, scope: string, key: string, requestHash: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { organizationId_scope_key: { organizationId, scope, key } } });
      if (existing?.requestHash && existing.requestHash !== requestHash) {
        throw new ConflictException("Idempotency key was already used with a different request");
      }
      if (existing?.responseJson) return existing.responseJson as any;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ConflictException("A manual execution request with this idempotency key is still being processed");
  }
}

type StepCount = { total: number; completed: number; failed: number };

function summary(item: any, counts?: StepCount) {
  return {
    id: item.id,
    workflowId: item.workflowId,
    workflowVersionId: item.workflowVersionId,
    workflow: item.workflow ?? null,
    workflowVersion: item.workflowVersion ?? null,
    workflowName: item.workflow?.name ?? null,
    versionNumber: item.workflowVersion?.versionNumber ?? null,
    correlationId: item.correlationId,
    status: item.status,
    publicStatus: publicExecutionStatus(item.status),
    mode: item.executionMode,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    finishedAt: item.completedAt,
    durationMs: durationMs(item.startedAt, item.completedAt),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedBy: actor(item.startedBy),
    initiator: actor(item.startedBy),
    stepCount: counts?.total ?? item._count?.steps ?? 0,
    completedStepCount: counts?.completed ?? 0,
    failedStepCount: counts?.failed ?? 0,
    attempts: item.runAttempt,
    runAttempt: item.runAttempt,
    cancelled: item.status === ExecutionStatus.Cancelled,
    retryOfExecutionId: item.retryOfExecutionId,
    cancelRequestedAt: item.cancelRequestedAt,
    cancelledAt: item.cancelledAt
  };
}

function retryResponse(next: { id: string; status: string; retryOfExecutionId: string | null; correlationId: string | null }, originalId: string, correlationId: string) {
  return {
    execution: {
      id: next.id,
      status: next.status,
      publicStatus: publicExecutionStatus(next.status),
      retryOfExecutionId: next.retryOfExecutionId ?? originalId,
      correlationId: next.correlationId ?? correlationId
    }
  };
}

function manualExecutionResponse(execution: any, versionNumber: number) {
  return {
    accepted: true,
    execution: {
      id: execution.id,
      status: execution.status,
      publicStatus: publicExecutionStatus(execution.status),
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      versionNumber,
      correlationId: execution.correlationId,
      createdAt: execution.createdAt,
      startedAt: execution.startedAt,
      finishedAt: execution.completedAt
    },
    executionId: execution.id
  };
}

function cancelResponse(execution: any) {
  return {
    id: execution.id,
    status: execution.status,
    publicStatus: publicExecutionStatus(execution.status),
    cancelledAt: execution.cancelledAt,
    cancelRequestedAt: execution.cancelRequestedAt,
    finishedAt: execution.completedAt
  };
}

function relation(execution: any) {
  if (!execution) return null;
  return { ...execution, publicStatus: publicExecutionStatus(execution.status), finishedAt: execution.completedAt };
}

function actor(user?: { id: string; name?: string | null; email?: string | null } | null) {
  if (!user) return null;
  return { id: user.id, display: user.name || user.email || "Unknown user", email: user.email ?? null, name: user.name ?? null };
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

function loopInputSummary(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  const state = record.forEachState && typeof record.forEachState === "object" ? record.forEachState as Record<string, any> : {};
  return sanitizePublic({ total: Array.isArray(state.items) ? state.items.length : 0, nextIteration: state.nextIndex ?? 0, currentStepKey: state.currentStepKey ?? null });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeIdempotencyKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) {
    throw new BadRequestException("Invalid idempotency key");
  }
  return trimmed;
}

function validateVersionDefinition(definition: unknown) {
  const record = definition && typeof definition === "object" && !Array.isArray(definition) ? (definition as Record<string, unknown>) : {};
  if (record.workflowDefinitionSchemaVersion === 2) {
    validateWorkflowGraph((record.steps as any[]) ?? [], record.graph as Record<string, unknown>);
  }
}

function assertDateRange(from?: string, to?: string) {
  if (from && to && new Date(from) > new Date(to)) {
    throw new BadRequestException("from must be before to");
  }
}

function publicStepStatus(status: string) {
  if (status === StepExecutionStatus.Completed) return "completed";
  if (status === StepExecutionStatus.Running) return "running";
  if (status === StepExecutionStatus.Failed) return "failed";
  if (status === StepExecutionStatus.Skipped) return "skipped";
  if (status === StepExecutionStatus.Retrying) return "waiting";
  return "pending";
}
