import { Injectable } from "@nestjs/common";
import { ExecutionJobPayload, ExecutionStatus, StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepExecutor } from "./step-executor";
import { ContextReconstructor } from "./context-reconstructor";
import { ExecutionLeaseService } from "./execution-lease.service";
import { LeaseLostError } from "./lease-lost.error";
import { DeadLetterService } from "../dlq/dead-letter.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

export type WorkflowRunResult = { status: "completed" | "skipped" | "lost_lease" } | { status: "waiting"; nextRetryAt: Date };

@Injectable()
export class WorkflowRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor,
    private readonly contextReconstructor: ContextReconstructor,
    private readonly leaseService: ExecutionLeaseService,
    private readonly deadLetterService: DeadLetterService,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
  ) {}

  async run(payload: ExecutionJobPayload): Promise<WorkflowRunResult> {
    const acquired = await this.leaseService.acquire(payload.executionId, payload.organizationId);
    if (!acquired) {
      this.logger?.info("worker.lease.rejected");
      return { status: "skipped" };
    }
    this.logger?.info("worker.lease.acquired");
    let heartbeat: NodeJS.Timeout | undefined;
    const startHeartbeat = () => {
      heartbeat = setInterval(() => {
        void this.leaseService.heartbeat(payload.executionId).catch(() => undefined);
      }, this.leaseService.heartbeatIntervalMs());
    };
    startHeartbeat();
    const execution = await this.loadExecution(payload);
    if (!execution) {
      throw new Error(`Execution ${payload.executionId} not found`);
    }
    if ([ExecutionStatus.Completed, ExecutionStatus.Cancelled].includes(execution.status as ExecutionStatus)) {
      await this.leaseService.release(execution.id);
      if (heartbeat) clearInterval(heartbeat);
      return { status: "completed" };
    }
      await this.prisma.execution.update({ where: { id: execution.id }, data: { startedAt: execution.startedAt ?? new Date(), completedAt: null } });

    try {
      let skipNext = false;
      let current = await this.loadExecution(payload);
      if (!current) {
        throw new Error(`Execution ${payload.executionId} not found`);
      }

      for (const dbStep of current.workflowVersion.steps) {
        await this.leaseService.assertOwned(current.id);
        if (dbStep.position === 0) {
          continue;
        }

        const step = toStepDefinition(dbStep);
        let stepExecution = await this.stepExecutor.ensure({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step
        });

        if (stepExecution.status === StepExecutionStatus.Completed) {
          skipNext = shouldSkipNext(step, stepExecution.outputJson);
          continue;
        }
        if (stepExecution.status === StepExecutionStatus.Skipped) {
          skipNext = false;
          continue;
        }
        if (stepExecution.status === StepExecutionStatus.Retrying && stepExecution.nextRetryAt && stepExecution.nextRetryAt > new Date()) {
          await this.markWaiting(current.id);
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: stepExecution.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: stepExecution.nextRetryAt };
        }
        if (stepExecution.status === StepExecutionStatus.Failed && stepExecution.attemptCount >= stepExecution.maxAttempts) {
          throw new Error(`Step ${step.key} failed after ${stepExecution.attemptCount} attempts`);
        }

        if (skipNext) {
          const { result } = await this.stepExecutor.skip({
            organizationId: current.organizationId,
            executionId: current.id,
            workflowStepId: dbStep.id,
            step,
            stepExecution,
            reason: "skipNextOnFalse"
          });
          await this.updateContextCache(current.id);
          skipNext = false;
          current = await this.reload(payload);
          continue;
        }

        const context = this.contextReconstructor.reconstruct(current, current.steps);
        const outcome = await this.stepExecutor.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step,
          context,
          stepExecution
        });
        await this.leaseService.assertOwned(current.id);
        await this.updateContextCache(current.id);

        if (outcome.outcome === "retrying") {
          await this.markWaiting(current.id);
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: outcome.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt };
        }
        skipNext = Boolean(outcome.result.control?.skipNext);
        current = await this.reload(payload);
      }

      const context = await this.reconstructContextForExecution(execution.id);
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: toJson(context), errorJson: undefined }
      });
      if (heartbeat) clearInterval(heartbeat);
      await this.leaseService.release(execution.id);
      this.logger?.info("worker.execution.completed", { durationMs: execution.startedAt ? Date.now() - execution.startedAt.getTime() : undefined });
      this.metrics?.executionsCompleted.inc();
      return { status: "completed" };
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (error instanceof LeaseLostError) {
        this.logger?.warn("worker.lease.lost");
        return { status: "lost_lease" };
      }
      const context = await this.reconstructContextForExecution(execution.id);
      const failedStep = await this.prisma.stepExecution.findFirst({
        where: { executionId: execution.id, status: StepExecutionStatus.Failed },
        orderBy: { updatedAt: "desc" }
      });
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: ExecutionStatus.Failed,
          completedAt: new Date(),
          contextJson: toJson(context),
          errorJson: { message: error instanceof Error ? error.message : String(error) }
        }
      });
      await this.deadLetterService.create({
        organizationId: execution.organizationId,
        executionId: execution.id,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
        reason: failedStep?.effectStatus === "ambiguous" ? "ambiguous" : "failed",
        failedStepKey: failedStep?.stepKey,
        failedStepExecutionId: failedStep?.id,
        attempts: failedStep?.attemptCount,
        lastErrorJson: failedStep?.errorJson ?? { message: error instanceof Error ? error.message : String(error) },
        jobId: `execution-${execution.id}`
      });
      this.logger?.error("worker.execution.failed", {
        failedStepKey: failedStep?.stepKey,
        stepExecutionId: failedStep?.id,
        errorCategory: (failedStep?.errorJson as any)?.classification
      });
      this.logger?.warn("worker.execution.dead_lettered", {
        failedStepKey: failedStep?.stepKey,
        stepExecutionId: failedStep?.id,
        reason: failedStep?.effectStatus === "ambiguous" ? "ambiguous" : "failed"
      });
      this.metrics?.executionsFailed.inc({ error_category: (failedStep?.errorJson as any)?.classification ?? "unknown" });
      await this.leaseService.release(execution.id);
      throw error;
    }
  }

  private loadExecution(payload: ExecutionJobPayload) {
    return this.prisma.execution.findFirst({
      where: { id: payload.executionId, organizationId: payload.organizationId },
      include: {
        workflowVersion: { include: { steps: { orderBy: { position: "asc" } } } },
        steps: { orderBy: { createdAt: "asc" } }
      }
    });
  }

  private async reload(payload: ExecutionJobPayload) {
    const execution = await this.loadExecution(payload);
    if (!execution) {
      throw new Error(`Execution ${payload.executionId} not found`);
    }
    return execution;
  }

  private async reconstructContextForExecution(executionId: string) {
    const execution = await this.prisma.execution.findUniqueOrThrow({
      where: { id: executionId },
      include: { steps: { orderBy: { createdAt: "asc" } } }
    });
    return this.contextReconstructor.reconstruct(execution, execution.steps);
  }

  private async updateContextCache(executionId: string) {
    const context = await this.reconstructContextForExecution(executionId);
    await this.prisma.execution.update({ where: { id: executionId }, data: { contextJson: toJson(context) } });
  }

  private markWaiting(executionId: string) {
    return this.prisma.execution.update({
      where: { id: executionId },
      data: { status: ExecutionStatus.Retrying, completedAt: null }
    });
  }
}

function toStepDefinition(dbStep: {
  id: string;
  key: string;
  name: string;
  type: string;
  position: number;
  configJson: unknown;
  retryPolicyJson: unknown;
  timeoutSeconds: number | null;
}): WorkflowStepDefinition {
  return {
    id: dbStep.id,
    key: dbStep.key,
    name: dbStep.name,
    type: dbStep.type as any,
    position: dbStep.position,
    config: dbStep.configJson as Record<string, unknown>,
    retryPolicy: dbStep.retryPolicyJson as any,
    timeoutSeconds: dbStep.timeoutSeconds ?? undefined
  };
}

function shouldSkipNext(step: WorkflowStepDefinition, output: unknown) {
  return (
    step.type === "conditional" &&
    Boolean((step.config as any).skipNextOnFalse) &&
    output !== null &&
    typeof output === "object" &&
    (output as any).passed === false
  );
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
