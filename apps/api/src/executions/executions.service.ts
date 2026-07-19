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
import { ExecutionTimelineQueryDto } from "./dto/execution-timeline-query.dto";
import { CreateManualExecutionDto } from "./dto/create-manual-execution.dto";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { RequestContextService } from "../observability/request-context.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { ApiMetricsService } from "../metrics/metrics.service";
import { classifyError } from "../metrics/metrics-catalog";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { publicError, sanitizePublic } from "../common/public-sanitizer";
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
    const limit = Math.min(query.limit ?? query.pageSize ?? 20, 100);
    const rawStatuses = query.statuses?.length ? query.statuses : query.status ? [query.status] : [];
    const statuses = rawStatuses.map((value) => executionStatusFromPublic(value) ?? (Object.values(ExecutionStatus).includes(value as ExecutionStatus) ? value as ExecutionStatus : undefined));
    if (statuses.some((value) => !value)) throw new BadRequestException("Invalid execution status");
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.workflowId) {
      const workflow = await this.prisma.workflow.findFirst({ where: { id: query.workflowId, organizationId }, select: { id: true } });
      if (!workflow) return { items: [], nextCursor: null, hasMore: false };
    }
    const where: Prisma.ExecutionWhereInput = {
      organizationId,
      executionMode: ExecutionMode.Real,
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(statuses.length ? { status: { in: statuses as ExecutionStatus[] } } : {}),
      ...(query.relationship === "root" ? { parentExecutionId: null } : query.relationship === "child" ? { parentExecutionId: { not: null } } : {}),
      ...(query.rootExecutionId ? { AND: [{ OR: [{ id: query.rootExecutionId }, { rootExecutionId: query.rootExecutionId }] }] } : {}),
      ...(query.waiting === "true" ? { status: ExecutionStatus.Retrying } : query.waiting === "false" ? { NOT: { status: ExecutionStatus.Retrying } } : {}),
      ...((query.failed === "true" || query.failedStepKey) ? { steps: { some: { status: StepExecutionStatus.Failed, ...(query.failedStepKey ? { stepKey: query.failedStepKey } : {}) } } } : query.failed === "false" ? { steps: { none: { status: StepExecutionStatus.Failed } } } : {}),
      ...triggerWhere(query.triggerType),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          }
        : {})
    };
    const cursorWhere: Prisma.ExecutionWhereInput | undefined = cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : undefined;
    const items = await this.prisma.execution.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true, workflowId: true, workflowVersionId: true, correlationId: true, status: true, waitReason: true, executionMode: true,
        startedAt: true, completedAt: true, createdAt: true, updatedAt: true, runAttempt: true, retryOfExecutionId: true,
        parentExecutionId: true, rootExecutionId: true, depth: true, webhookEventId: true, scheduledTriggerId: true, eventDeliveryId: true,
        manualExecutionKey: true, startedByUserId: true,
        workflow: { select: { id: true, name: true } }, workflowVersion: { select: { id: true, versionNumber: true } },
        startedBy: { select: { id: true, name: true, email: true } }, _count: { select: { steps: true } }
      }
    });
    const hasMore = items.length > limit;
    const pageItems = items.slice(0, limit);
    const stepCounts = await this.stepCounts(pageItems.map((item) => item.id));
    const failedSteps = await this.failedSteps(pageItems.map((item) => item.id));
    return {
      items: pageItems.map((item) => ({ ...summary(item, stepCounts.get(item.id)), triggerType: triggerType(item), relationship: item.parentExecutionId ? "child" : "root", parentExecutionId: item.parentExecutionId, rootExecutionId: item.rootExecutionId ?? item.id, depth: item.depth, failedStep: failedSteps.get(item.id) ?? null })),
      nextCursor: hasMore ? encodeCursor(pageItems.at(-1)!) : null,
      hasMore,
      pageSize: limit
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
        parentExecution: { select: { id: true, status: true, workflowId: true, completedAt: true } },
        parentStepExecution: { select: { id: true, stepKey: true, executionPath: true } },
        childExecutions: { select: { id: true, status: true, workflowId: true, workflowVersionId: true, depth: true, createdAt: true, startedAt: true, completedAt: true }, orderBy: { createdAt: "asc" } },
        approvalRequests: { select: { id: true, status: true, title: true, requestedAt: true, expiresAt: true, decidedAt: true, decidedByUserId: true, stepKey: true, executionPath: true, iterationIndex: true }, orderBy: { requestedAt: "desc" } },
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
        },
        eventDelivery: { include: { internalEvent: { select: { id: true, eventType: true, correlationId: true, rootEventId: true, causationId: true, depth: true } }, trigger: { select: { id: true } } } }
      }
    });
    if (!execution) throw new NotFoundException("Execution not found");
    const counts = (await this.stepCounts([execution.id])).get(execution.id);
    const sourceEvents = await this.prisma.internalEvent.findMany({
      where: { organizationId, envelopeJson: { path: ["data", "executionId"], equals: execution.id } },
      select: { id: true }, take: 20
    });
    const notifications = sourceEvents.length ? await this.prisma.notificationRequest.findMany({
      where: { organizationId, sourceEventId: { in: sourceEvents.map((item) => item.id) } },
      select: { id: true, type: true, channel: true, status: true, createdAt: true, updatedAt: true, delivery: { select: { status: true, attempts: true, lastAttemptAt: true, sentAt: true, failedAt: true, errorCategory: true, errorMessageSafe: true } } },
      orderBy: { createdAt: "asc" }, take: 100
    }) : [];
    return {
      ...summary(execution as any, counts),
      triggerType: triggerType(execution),
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
      payloads: payloadMetadata(execution),
      error: execution.errorJson ? publicError(execution.errorJson) : null,
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
        errorHandled: step.errorHandled,
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
        error: step.errorJson ? publicError(step.errorJson) : null,
        artifact: safeStepArtifact(step),
        payloads: payloadMetadata(step)
      })),
      retryOfExecutionId: execution.retryOfExecutionId,
      retryOfExecution: relation(execution.retryOfExecution),
      retryExecutions: execution.retryExecutions.map(relation),
      parentExecutionId: execution.parentExecutionId,
      parentStepExecutionId: execution.parentStepExecutionId,
      rootExecutionId: execution.rootExecutionId ?? execution.id,
      depth: execution.depth,
      parentExecution: execution.parentExecution,
      parentStepExecution: execution.parentStepExecution,
      childExecutions: execution.childExecutions,
      waitReason: execution.waitReason,
      approvals: execution.approvalRequests,
      deadLetter: execution.deadLetters.find((item) => !item.resolvedAt)
        ? formatDeadLetter(execution.deadLetters.find((item) => !item.resolvedAt)!)
        : null,
      deadLetters: execution.deadLetters.map(formatDeadLetter),
      eventCausality: execution.eventDelivery ? {
        eventType: execution.eventDelivery.internalEvent.eventType,
        correlationId: execution.eventDelivery.internalEvent.correlationId,
        rootEventId: execution.eventDelivery.internalEvent.rootEventId,
        causationId: execution.eventDelivery.internalEvent.causationId,
        depth: execution.eventDelivery.internalEvent.depth,
        deliveryStatus: execution.eventDelivery.status,
        triggerId: execution.eventDelivery.trigger.id
      } : null,
      notifications: notifications.map((item) => ({ id: item.id, type: item.type, channel: item.channel, status: item.delivery?.status ?? item.status, attempts: item.delivery?.attempts ?? 0, createdAt: item.createdAt, updatedAt: item.updatedAt, lastAttemptAt: item.delivery?.lastAttemptAt ?? null, sentAt: item.delivery?.sentAt ?? null, failedAt: item.delivery?.failedAt ?? null, errorCategory: item.delivery?.errorCategory ?? null, errorMessageSafe: item.delivery?.errorMessageSafe ?? null }))
    };
  }

  async stepDetail(organizationId: string, executionId: string, stepExecutionId: string) {
    const step = await this.prisma.stepExecution.findFirst({ where: { id: stepExecutionId, executionId, organizationId, execution: { executionMode: ExecutionMode.Real } }, include: { attempts: { orderBy: { attempt: "asc" } } } });
    if (!step) throw new NotFoundException("Step execution not found");
    return safeStepDetail(step);
  }

  async tree(organizationId: string, executionId: string) {
    const current = await this.prisma.execution.findFirst({ where: { id: executionId, organizationId, executionMode: ExecutionMode.Real }, select: { id: true, rootExecutionId: true } });
    if (!current) throw new NotFoundException("Execution not found");
    const rootId = current.rootExecutionId ?? current.id;
    const rows = await this.prisma.execution.findMany({
      where: { organizationId, executionMode: ExecutionMode.Real, OR: [{ id: rootId }, { rootExecutionId: rootId }] },
      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
      select: { id: true, parentExecutionId: true, parentStepExecutionId: true, rootExecutionId: true, depth: true, workflowId: true, status: true, createdAt: true, startedAt: true, completedAt: true, workflow: { select: { name: true } }, parentStepExecution: { select: { stepKey: true, executionPath: true } } }
    });
    const nodes = new Map(rows.map((row) => [row.id, { ...row, workflowName: row.workflow.name, children: [] as any[] }]));
    for (const node of nodes.values()) if (node.parentExecutionId && nodes.has(node.parentExecutionId)) nodes.get(node.parentExecutionId)!.children.push(node);
    return nodes.get(rootId) ?? null;
  }

  async timeline(organizationId: string, executionId: string, query: ExecutionTimelineQueryDto) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, organizationId, executionMode: ExecutionMode.Real },
      include: { steps: { include: { attempts: { orderBy: { attempt: "asc" } } } }, approvalRequests: true, childExecutions: { include: { workflow: { select: { name: true } } } }, deadLetters: true, eventDelivery: { include: { internalEvent: true } } }
    });
    if (!execution) throw new NotFoundException("Execution not found");
    const sourceEvents = await this.prisma.internalEvent.findMany({ where: { organizationId, envelopeJson: { path: ["data", "executionId"], equals: executionId } }, select: { id: true }, take: 20 });
    const notifications = sourceEvents.length ? await this.prisma.notificationRequest.findMany({ where: { organizationId, sourceEventId: { in: sourceEvents.map((event) => event.id) } }, select: { id: true, type: true, channel: true, status: true, createdAt: true, updatedAt: true, delivery: { select: { status: true, attempts: true, lastAttemptAt: true, sentAt: true, failedAt: true } } }, orderBy: { createdAt: "asc" }, take: 100 }) : [];
    const events = buildTimeline(execution, notifications).sort(compareTimeline);
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : null;
    const visible = cursor ? events.filter((event) => compareTimeline(event, cursor) > 0) : events;
    const limit = Math.min(query.limit ?? 50, 100);
    const items = visible.slice(0, limit);
    return { items, nextCursor: visible.length > limit ? encodeTimelineCursor(items.at(-1)!) : null, hasMore: visible.length > limit };
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
        ,waitReason: null
      }
    });
    const updated = await this.prisma.execution.findUniqueOrThrow({ where: { id: executionId } });
    if (result.count === 1) {
      const rootId = (updated as any).rootExecutionId ?? updated.id;
      await this.prisma.execution.updateMany({
        where: { organizationId, rootExecutionId: rootId, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
        data: { status: ExecutionStatus.Cancelled, completedAt: now, cancelledAt: now, cancelRequestedAt: now, cancelRequestedByUserId: userId, cancelReason: reason ?? "Parent execution cancelled", lockedBy: null, lockedUntil: null, lastHeartbeatAt: null, waitReason: null }
      });
      const cancelledApprovals = await this.prisma.approvalRequest.findMany({ where: { organizationId, status: "PENDING", execution: { OR: [{ id: executionId }, { rootExecutionId: rootId }] } }, select: { id: true, workflowId: true, executionId: true, stepKey: true, assigneePolicy: true, requestedAt: true } });
      for (const approval of cancelledApprovals) {
        const changed = await this.prisma.approvalRequest.updateMany({ where: { id: approval.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: now, version: { increment: 1 } } });
        if (changed.count !== 1) continue;
        await this.auditLogs?.record({ organizationId, actorUserId: userId, action: "approval.cancelled", resourceType: "ApprovalRequest", resourceId: approval.id, correlationId: execution.correlationId, metadata: { workflowId: approval.workflowId, executionId: approval.executionId, stepKey: approval.stepKey, outcome: "cancelled" } });
        const labels = { outcome: "cancelled", assignee_policy: approval.assigneePolicy.toLowerCase() };
        this.metrics?.approvalDecisions.inc(labels);
        this.metrics?.approvalDecisionLatency.observe(labels, Math.max(0, (now.getTime() - approval.requestedAt.getTime()) / 1000));
      }
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

  private async failedSteps(executionIds: string[]) {
    if (!executionIds.length) return new Map<string, { stepKey: string; errorHandled: boolean; errorCategory: string | null }>();
    const rows = await this.prisma.stepExecution.findMany({
      where: { executionId: { in: executionIds }, status: StepExecutionStatus.Failed },
      orderBy: { completedAt: "desc" },
      select: { executionId: true, stepKey: true, errorHandled: true, errorJson: true }
    });
    const result = new Map<string, { stepKey: string; errorHandled: boolean; errorCategory: string | null }>();
    for (const row of rows) if (!result.has(row.executionId)) result.set(row.executionId, { stepKey: row.stepKey, errorHandled: row.errorHandled, errorCategory: String((row.errorJson as any)?.classification ?? "unknown") });
    return result;
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
    waitReason: item.waitReason ?? null,
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

function triggerType(item: any) {
  if (item.parentExecutionId) return "subworkflow";
  if (item.retryOfExecutionId) return "retry";
  if (item.eventDeliveryId) return "event";
  if (item.scheduledTriggerId) return "scheduled";
  if (item.webhookEventId) return "webhook";
  return "manual";
}

function triggerWhere(value?: string): Prisma.ExecutionWhereInput {
  if (!value) return {};
  if (value === "subworkflow") return { parentExecutionId: { not: null } };
  if (value === "retry") return { retryOfExecutionId: { not: null } };
  if (value === "event") return { eventDeliveryId: { not: null } };
  if (value === "scheduled") return { scheduledTriggerId: { not: null } };
  if (value === "webhook") return { webhookEventId: { not: null } };
  return { parentExecutionId: null, retryOfExecutionId: null, eventDeliveryId: null, scheduledTriggerId: null, webhookEventId: null };
}

function encodeCursor(item: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: item.createdAt.toISOString(), id: item.id })).toString("base64url");
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !Number.isFinite(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("Invalid execution cursor");
  }
}

function payloadMetadata(value: any) {
  const metadata = (entry: unknown) => entry === null || entry === undefined ? null : { present: true, kind: Array.isArray(entry) ? "array" : typeof entry === "object" ? "object" : typeof entry, approximateBytes: Buffer.byteLength(JSON.stringify(entry) ?? "") };
  return { input: metadata(value.inputJson), context: metadata(value.contextJson), output: metadata(value.outputJson), error: metadata(value.errorJson), debug: metadata(value.debugJson) };
}

function safeStepArtifact(step: any) {
  const debug = step.debugJson && typeof step.debugJson === "object" && !Array.isArray(step.debugJson) ? step.debugJson as Record<string, any> : {};
  const output = step.outputJson && typeof step.outputJson === "object" && !Array.isArray(step.outputJson) ? step.outputJson as Record<string, any> : {};
  if (step.stepType === "for_each") return { kind: "loop", total: numberOrNull(debug.loop?.total ?? output.total), completed: numberOrNull(debug.loop?.completed ?? output.completed ?? output.succeeded), failed: numberOrNull(debug.loop?.failed ?? output.failed) };
  if (step.stepType === "try_catch") return { kind: "try_catch", status: safeToken(debug.try?.status ?? output.status), bodyStatus: safeToken(debug.try?.bodyStatus ?? output.bodyStatus), catchStatus: safeToken(debug.try?.catchStatus ?? output.catchStatus), finallyStatus: safeToken(debug.try?.finallyStatus ?? output.finallyStatus), errorHandled: step.errorHandled === true || output.errorHandled === true };
  if (step.stepType === "execute_workflow") return { kind: "subworkflow", childExecutionId: typeof debug.subworkflow?.executionId === "string" ? debug.subworkflow.executionId : null, status: safeToken(debug.subworkflow?.status) };
  if (debug.connection && typeof debug.connection === "object") return { kind: "connection", type: safeToken(debug.connection.type), status: safeToken(debug.connection.status) };
  if (debug.variable && typeof debug.variable === "object") return { kind: "variable", operation: safeToken(debug.variable.operation), scope: safeToken(debug.variable.scope) };
  return null;
}

function safeStepDetail(step: any) {
  return {
    id: step.id, executionId: step.executionId, stepKey: step.stepKey, stepType: step.stepType, status: step.status,
    publicStatus: publicStepStatus(step.status), attempt: step.attempt, attemptCount: step.attemptCount, maxAttempts: step.maxAttempts,
    executionPath: step.executionPath, iterationIndex: step.iterationIndex, errorHandled: step.errorHandled,
    startedAt: step.startedAt, completedAt: step.completedAt, durationMs: step.durationMs, nextRetryAt: step.nextRetryAt,
    retryState: step.status === StepExecutionStatus.Retrying ? (step.nextRetryAt ? "backoff" : step.effectStatus === "approval_waiting" ? "approval" : "waiting") : null,
    effectStatus: step.effectStatus, error: step.errorJson ? publicError(step.errorJson) : null, artifact: safeStepArtifact(step), payloads: payloadMetadata(step),
    attempts: (step.attempts ?? []).map((attempt: any) => ({ id: attempt.id, attempt: attempt.attempt, status: attempt.status, startedAt: attempt.startedAt, completedAt: attempt.completedAt, durationMs: attempt.durationMs, nextRetryAt: attempt.nextRetryAt, waitReason: attempt.waitReason, effectStatus: attempt.effectStatus, errorCategory: attempt.errorCategory, errorCodeSafe: attempt.errorCodeSafe, errorMessageSafe: attempt.errorMessageSafe })),
    historyComplete: (step.attempts?.length ?? 0) >= step.attemptCount
  };
}

type TimelineEvent = { id: string; type: string; timestamp: string; status?: string; stepExecutionId?: string; stepKey?: string; executionPath?: string; iterationIndex?: number | null; attempt?: number; durationMs?: number | null; waitReason?: string | null; relatedExecutionId?: string; approvalId?: string; message: string };

function buildTimeline(execution: any, notifications: any[] = []): TimelineEvent[] {
  const events: TimelineEvent[] = [{ id: `execution:${execution.id}:created`, type: "execution_created", timestamp: execution.createdAt.toISOString(), status: execution.status, message: "Execution created" }];
  if (execution.startedAt) events.push({ id: `execution:${execution.id}:started`, type: "execution_started", timestamp: execution.startedAt.toISOString(), status: "RUNNING", message: "Execution started" });
  if (execution.eventDelivery) events.push({ id: `event:${execution.eventDelivery.id}`, type: "event_trigger", timestamp: execution.eventDelivery.createdAt.toISOString(), status: execution.eventDelivery.status, message: `Triggered by ${execution.eventDelivery.internalEvent.eventType}` });
  for (const step of execution.steps) {
    if (!step.attempts.length) {
      const timestamp = step.startedAt ?? step.createdAt;
      events.push({ id: `step:${step.id}:legacy`, type: "step", timestamp: timestamp.toISOString(), status: step.status, stepExecutionId: step.id, stepKey: step.stepKey, executionPath: step.executionPath, iterationIndex: step.iterationIndex, attempt: step.attemptCount, durationMs: step.durationMs, waitReason: step.status === StepExecutionStatus.Retrying ? step.effectStatus : null, message: step.attemptCount > 1 ? `${step.stepKey}: ${step.attemptCount} attempts recorded; historical detail unavailable` : `${step.stepKey} ${String(step.status).toLowerCase()}` });
    } else for (const attempt of step.attempts) events.push({ id: `attempt:${attempt.id}`, type: attempt.waitReason ? "wait" : "step_attempt", timestamp: (attempt.startedAt ?? attempt.createdAt).toISOString(), status: attempt.status, stepExecutionId: step.id, stepKey: step.stepKey, executionPath: step.executionPath, iterationIndex: step.iterationIndex, attempt: attempt.attempt, durationMs: attempt.durationMs, waitReason: attempt.waitReason, message: attempt.waitReason ? `${step.stepKey} waiting: ${attempt.waitReason}` : `${step.stepKey} attempt ${attempt.attempt} ${String(attempt.status).toLowerCase()}` });
  }
  for (const approval of execution.approvalRequests) {
    events.push({ id: `approval:${approval.id}:requested`, type: "approval_requested", timestamp: approval.requestedAt.toISOString(), status: "PENDING", approvalId: approval.id, stepKey: approval.stepKey, executionPath: approval.executionPath, iterationIndex: approval.iterationIndex, message: "Approval requested" });
    if (approval.decidedAt) events.push({ id: `approval:${approval.id}:decided`, type: "approval_decided", timestamp: approval.decidedAt.toISOString(), status: approval.status, approvalId: approval.id, stepKey: approval.stepKey, executionPath: approval.executionPath, iterationIndex: approval.iterationIndex, message: `Approval ${String(approval.status).toLowerCase()}` });
  }
  for (const child of execution.childExecutions) events.push({ id: `child:${child.id}`, type: "subworkflow", timestamp: child.createdAt.toISOString(), status: child.status, relatedExecutionId: child.id, message: `Subworkflow ${child.workflow.name} created` });
  for (const dead of execution.deadLetters) events.push({ id: `dead-letter:${dead.id}`, type: "dead_letter", timestamp: dead.createdAt.toISOString(), status: dead.resolvedAt ? "RESOLVED" : "ACTIVE", stepKey: dead.failedStepKey, message: dead.resolvedAt ? "Dead letter resolved" : "Execution moved to dead letter" });
  for (const notification of notifications) events.push({ id: `notification:${notification.id}`, type: "notification", timestamp: notification.createdAt.toISOString(), status: notification.delivery?.status ?? notification.status, message: `${notification.type} notification ${String(notification.delivery?.status ?? notification.status).toLowerCase()}` });
  if (execution.completedAt) events.push({ id: `execution:${execution.id}:completed`, type: "execution_completed", timestamp: execution.completedAt.toISOString(), status: execution.status, message: `Execution ${String(execution.status).toLowerCase()}` });
  return events;
}

const TIMELINE_TYPE_PRIORITY: Record<string, number> = { event_trigger: 0, execution_created: 10, execution_started: 20, step_attempt: 30, wait: 40, approval_requested: 50, approval_decided: 60, subworkflow: 70, notification: 80, dead_letter: 90, execution_completed: 100 };
function compareTimeline(a: TimelineEvent, b: TimelineEvent) { return a.timestamp.localeCompare(b.timestamp) || (TIMELINE_TYPE_PRIORITY[a.type] ?? 50) - (TIMELINE_TYPE_PRIORITY[b.type] ?? 50) || a.id.localeCompare(b.id); }
function encodeTimelineCursor(event: TimelineEvent) { return Buffer.from(JSON.stringify({ v: 1, timestamp: event.timestamp, type: event.type, id: event.id })).toString("base64url"); }
function decodeTimelineCursor(value: string): TimelineEvent { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (parsed.v !== 1 || typeof parsed.timestamp !== "string" || typeof parsed.type !== "string" || typeof parsed.id !== "string") throw new Error(); return { timestamp: parsed.timestamp, type: parsed.type, id: parsed.id, message: "" }; } catch { throw new BadRequestException("Invalid timeline cursor"); } }
function numberOrNull(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function safeToken(value: unknown) { return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : null; }

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
