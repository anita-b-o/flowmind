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

@Injectable()
export class ExecutionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shutdown: ShutdownStateService,
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
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
    reasonCode: ReconcilerReason = "execution_requeued"
  ) {
    const correlationId = existingCorrelationId ?? (await this.ensureExecutionCorrelationId(executionId));
    const job = await this.queue.add(
      EXECUTION_RUN_JOB,
      { executionId, organizationId, workflowId, workflowVersionId: workflowVersionId ?? undefined, requestId: newTraceId(), correlationId, enqueuedAt: new Date().toISOString() },
      { jobId: `execution-${executionId}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false }
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

function isAmbiguousWhenAbandoned(stepType: string) {
  return stepType === "email_notification" || stepType === "http_request";
}
