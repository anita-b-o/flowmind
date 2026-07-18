import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import { ExecutionStatus, StepExecutionStatus } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { PrismaService } from "../prisma/prisma.service";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "../queues/queue.constants";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService, type ReconcilerReason } from "../metrics/worker-metrics.service";
import { InternalEventEmitter } from "../internal-events/internal-event-emitter.service";

@Injectable()
export class ExecutionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService,
    private readonly events?: InternalEventEmitter
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.reconcile(), Number(process.env.EXECUTION_RECONCILIATION_INTERVAL_MS ?? 10_000));
    this.timer.unref();
    void this.reconcile();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close().catch(() => undefined);
  }

  isActive() {
    return Boolean(this.timer) && !this.shutdown.isShuttingDown();
  }

  async reconcile() {
    if (this.running || this.shutdown.isShuttingDown()) return;
    this.running = true;
    const started = process.hrtime.bigint();
    try {
      await this.recoverExpiredRunning();
      await this.recoverApprovals();
      await this.requeueDueRetries();
      await this.requeueQueuedExecutions();
      this.metrics?.reconcilerRuns.inc({ outcome: "completed" });
      this.metrics?.reconcilerDuration.observe(Number(process.hrtime.bigint() - started) / 1_000_000_000);
    } catch (error) {
      this.metrics?.reconcilerRuns.inc({ outcome: "failed" });
      this.metrics?.reconcilerDuration.observe(Number(process.hrtime.bigint() - started) / 1_000_000_000);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async recoverApprovals() {
    const now = new Date();
    const expired = await this.prisma.approvalRequest.findMany({ where: { status: "PENDING", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: 100, include: { execution: { select: { correlationId: true, eventRootId: true, eventCausationId: true, eventDepth: true } } } });
    for (const approval of expired) {
      const won = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.approvalRequest.updateMany({ where: { id: approval.id, status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED", decidedAt: now, version: { increment: 1 } } });
        if (!changed.count) return false;
        await tx.execution.updateMany({ where: { id: approval.executionId, status: "RETRYING", waitReason: "approval" }, data: { status: "QUEUED", waitReason: null } });
        await tx.auditLog.create({ data: { organizationId: approval.organizationId, actorUserId: null, action: "approval.expired", resourceType: "ApprovalRequest", resourceId: approval.id, correlationId: approval.execution.correlationId, metadataJson: { workflowId: approval.workflowId, executionId: approval.executionId, stepKey: approval.stepKey, outcome: "expired" } } });
        await this.events?.emit(tx, { organizationId: approval.organizationId, type: "APPROVAL_EXPIRED", source: { type: "approval", id: approval.id }, subject: { type: "approval_request", id: approval.id }, data: { approvalId: approval.id, executionId: approval.executionId, workflowId: approval.workflowId, workflowVersionId: approval.workflowVersionId, stepKey: approval.stepKey, outcome: "EXPIRED", requestedAt: approval.requestedAt.toISOString(), decidedAt: now.toISOString() }, causality: approval.execution.eventRootId ? { rootEventId: approval.execution.eventRootId, causationId: approval.execution.eventCausationId, depth: approval.execution.eventDepth, correlationId: approval.execution.correlationId } : { correlationId: approval.execution.correlationId } });
        return true;
      });
      if (won) {
        this.metrics?.recordApproval("expired", approval.assigneePolicy, Math.max(0, (now.getTime() - approval.requestedAt.getTime()) / 1000));
        await this.enqueue(approval.executionId, approval.organizationId, approval.workflowId, approval.workflowVersionId, approval.execution.correlationId, "execution_requeued", approvalResumeJobId(approval.executionId, approval.id, approval.version + 1));
      }
    }
    const stranded = await this.prisma.approvalRequest.findMany({ where: { status: { in: ["APPROVED", "REJECTED", "EXPIRED"] }, stepExecution: { status: "RETRYING", effectStatus: "approval_waiting" }, execution: { status: { in: ["RETRYING", "QUEUED"] } } }, orderBy: { requestedAt: "asc" }, take: 100, include: { execution: { select: { correlationId: true } } } });
    for (const approval of stranded) {
      await this.prisma.execution.updateMany({ where: { id: approval.executionId, status: "RETRYING", waitReason: "approval" }, data: { status: "QUEUED", waitReason: null } });
      await this.enqueue(approval.executionId, approval.organizationId, approval.workflowId, approval.workflowVersionId, approval.execution.correlationId, "execution_requeued", approvalResumeJobId(approval.executionId, approval.id, approval.version));
    }
  }

  private async recoverExpiredRunning() {
    const now = new Date();
    const executions = await this.prisma.execution.findMany({
      where: { status: ExecutionStatus.Running, lockedUntil: { lt: now } },
      take: 50,
      include: { steps: true }
    });
    for (const execution of executions) {
      await this.prisma.execution.updateMany({
        where: { id: execution.id, status: ExecutionStatus.Running, lockedUntil: { lt: now } },
        data: { status: ExecutionStatus.Queued, lockedBy: null, lockedUntil: null }
      });
      for (const step of execution.steps.filter((entry) => entry.status === StepExecutionStatus.Running)) {
        const ambiguous = isAmbiguousWhenAbandoned(step.stepType);
        await this.prisma.stepExecution.update({
          where: { id: step.id },
          data: {
            status: ambiguous ? StepExecutionStatus.Failed : StepExecutionStatus.Retrying,
            effectStatus: ambiguous ? "ambiguous" : "failed",
            errorJson: { message: "Step abandoned after execution lease expired", classification: ambiguous ? "ambiguous" : "retryable" },
            nextRetryAt: ambiguous ? null : now
          }
        });
      }
      await this.enqueue(execution.id, execution.organizationId, execution.workflowId, execution.workflowVersionId, execution.correlationId, "expired_lease_recovered");
    }
  }

  private async requeueDueRetries() {
    const now = new Date();
    const executions = await this.prisma.execution.findMany({
      where: {
        OR: [
          { status: ExecutionStatus.Retrying },
          { status: ExecutionStatus.Queued }
        ],
        lockedBy: null,
        steps: { some: { status: StepExecutionStatus.Retrying, nextRetryAt: { lte: now } } }
      },
      take: 100
    });
    for (const execution of executions) {
      await this.prisma.execution.updateMany({
        where: { id: execution.id, status: { in: [ExecutionStatus.Retrying, ExecutionStatus.Queued] } },
        data: { status: ExecutionStatus.Queued }
      });
      await this.enqueue(execution.id, execution.organizationId, execution.workflowId, execution.workflowVersionId, execution.correlationId, "retry_recovered");
    }
  }

  private async requeueQueuedExecutions() {
    const now = new Date();
    const executions = await this.prisma.execution.findMany({
      where: {
        status: ExecutionStatus.Queued,
        lockedBy: null,
        NOT: {
          steps: { some: { status: StepExecutionStatus.Retrying, nextRetryAt: { lte: now } } }
        }
      },
      take: 100
    });
    for (const execution of executions) {
      await this.enqueue(execution.id, execution.organizationId, execution.workflowId, execution.workflowVersionId, execution.correlationId, "queued_job_recovered");
    }
  }

  private async enqueue(
    executionId: string,
    organizationId: string,
    workflowId: string,
    workflowVersionId: string | null,
    existingCorrelationId?: string | null,
    reasonCode: ReconcilerReason = "execution_requeued",
    jobId = `execution-${executionId}`
  ) {
    const correlationId = existingCorrelationId ?? (await this.ensureExecutionCorrelationId(executionId));
    const job = await this.queue.add(
      EXECUTION_RUN_JOB,
      { executionId, organizationId, workflowId, workflowVersionId: workflowVersionId ?? undefined, requestId: newTraceId(), correlationId, enqueuedAt: new Date().toISOString() },
      { jobId, attempts: 1, removeOnComplete: 1000, removeOnFail: false }
    );
    this.metrics?.executionsReconciled.inc({ reason_code: reasonCode });
    this.metrics?.reconcilerReenqueued.inc({ reason_code: reasonCode });
    this.logger?.info("worker.reconciler.reenqueued", { executionId, organizationId, workflowId, workflowVersionId, correlationId, jobId: job.id });
    return job;
  }

  private async ensureExecutionCorrelationId(executionId: string) {
    const candidate = newTraceId();
    await this.prisma.execution.updateMany({ where: { id: executionId, correlationId: null }, data: { correlationId: candidate } });
    const execution = await this.prisma.execution.findUniqueOrThrow({ where: { id: executionId }, select: { correlationId: true } });
    return execution.correlationId ?? candidate;
  }
}

function approvalResumeJobId(executionId: string, approvalId: string, version: number) {
  return `execution-${executionId}-approval-${approvalId}-v${version}`;
}

function isAmbiguousWhenAbandoned(stepType: string) {
  return stepType === "email_notification" || stepType === "http_request";
}
