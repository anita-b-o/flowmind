import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepRegistry } from "./step-registry";
import { ErrorClassifier } from "./error-classifier";
import { RetryPolicyResolver, type RetryPolicy } from "./retry-policy-resolver";
import { JobContextService } from "../observability/job-context.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService, workerErrorCategory } from "../metrics/worker-metrics.service";
import { ExpressionResolver } from "./expression-resolver";

export type StepExecutionRecord = {
  id: string;
  attemptCount: number;
  maxAttempts: number;
  status: string;
  nextRetryAt?: Date | null;
  effectKey: string | null;
  effectStatus: string | null;
  outputJson?: unknown;
};

@Injectable()
export class StepExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StepRegistry,
    private readonly errorClassifier: ErrorClassifier,
    private readonly retryPolicyResolver: RetryPolicyResolver,
    private readonly expressionResolver?: ExpressionResolver,
    private readonly jobContext?: JobContextService,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
  ) {}

  async ensure(input: {
    organizationId: string;
    executionId: string;
    workflowStepId: string;
    step: WorkflowStepDefinition;
  }) {
    const policy = this.retryPolicyResolver.resolve(input.step);
    const effectKey = `flowmind:${input.executionId}:${input.step.key}`;
    return this.prisma.stepExecution.upsert({
      where: { executionId_workflowStepId: { executionId: input.executionId, workflowStepId: input.workflowStepId } },
      update: { maxAttempts: policy.maxAttempts, effectKey },
      create: {
        organizationId: input.organizationId,
        executionId: input.executionId,
        workflowStepId: input.workflowStepId,
        stepKey: input.step.key,
        stepType: input.step.type,
        status: StepExecutionStatus.Pending,
        attempt: 0,
        attemptCount: 0,
        maxAttempts: policy.maxAttempts,
        effectKey,
        inputJson: {}
      }
    });
  }

  async execute(input: {
    organizationId: string;
    executionId: string;
    workflowStepId: string;
    step: WorkflowStepDefinition;
    context: any;
    stepExecution: StepExecutionRecord;
  }) {
    const policy = this.retryPolicyResolver.resolve(input.step);
    const startedAt = new Date();
    const nextAttempt = input.stepExecution.attemptCount + 1;
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Running,
        attempt: nextAttempt,
        attemptCount: nextAttempt,
        maxAttempts: policy.maxAttempts,
        startedAt,
        completedAt: null,
        nextRetryAt: null,
        workerId: workerId(),
        inputJson: {}
      }
    });
    this.logger?.info("worker.step.started", {
      stepExecutionId: input.stepExecution.id,
      stepKey: input.step.key,
      stepType: input.step.type,
      attemptCount: nextAttempt,
      maxAttempts: policy.maxAttempts
    });

    try {
      const trace = this.jobContext?.getContext();
      input.context.metadata = {
        ...(input.context.metadata ?? {}),
        runtime: {
          organizationId: input.organizationId,
          executionId: input.executionId,
          workflowStepId: input.workflowStepId,
          stepExecutionId: input.stepExecution.id,
          effectKey: input.stepExecution.effectKey ?? `flowmind:${input.executionId}:${input.step.key}`,
          requestId: trace?.requestId,
          correlationId: trace?.correlationId
        }
      };
      input.context.connection = await this.safeConnectionMetadata(input.organizationId, input.step.config);
      const mode = input.context.metadata?.expressionMode === "strict" ? "strict" : "legacy";
      const resolvedConfig = this.expressionResolver
        ? this.expressionResolver.resolveValue(input.step.config, input.context, { mode })
        : input.step.config;
      const resolvedStep = { ...input.step, config: resolvedConfig as Record<string, unknown> };
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: { inputJson: toJson({ config: resolvedConfig }) }
      });
      const handler = this.registry.get(input.step.type);
      const result = await withTimeout(handler.execute(resolvedStep, input.context), policy.timeoutSeconds * 1000);
      const completedAt = new Date();
      const control = result.control;
      const waitUntil = control?.waitUntil ? new Date(control.waitUntil) : null;
      if (waitUntil && Number.isFinite(waitUntil.getTime()) && waitUntil > completedAt) {
        await this.prisma.stepExecution.update({
          where: { id: input.stepExecution.id },
          data: {
            status: StepExecutionStatus.Retrying,
            outputJson: result.output as object,
            errorJson: Prisma.JsonNull,
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            nextRetryAt: waitUntil,
            effectStatus: control?.waitReason ?? "waiting"
          }
        });
        this.logger?.info(control?.waitReason === "wait_until" ? "worker.flow.wait_until_scheduled" : "worker.flow.delay_scheduled", {
          stepExecutionId: input.stepExecution.id,
          stepKey: input.step.key,
          stepType: input.step.type,
          nextRetryAt: waitUntil
        });
        this.metrics?.recordWait(input.step.type, control?.waitReason ?? "delay", Math.max(0, (waitUntil.getTime() - completedAt.getTime()) / 1000));
        return { outcome: "retrying" as const, nextRetryAt: waitUntil };
      }
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: {
          status: result.status,
          outputJson: result.output as object,
          errorJson: Prisma.JsonNull,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          effectStatus: "succeeded"
        }
      });
      this.logger?.info("worker.step.completed", {
        stepExecutionId: input.stepExecution.id,
        stepKey: input.step.key,
        stepType: input.step.type,
        durationMs: completedAt.getTime() - startedAt.getTime()
      });
      this.metrics?.recordStep(input.step.type, "completed", (completedAt.getTime() - startedAt.getTime()) / 1000);
      return { result, outcome: "completed" as const };
    } catch (error) {
      const completedAt = new Date();
      const classification = this.errorClassifier.classify(error);
      const canRetry = classification === "retryable" && nextAttempt < policy.maxAttempts;
      const nextRetryAt = canRetry ? this.retryPolicyResolver.nextRetryAt(policy, nextAttempt, completedAt) : null;
      await this.prisma.stepExecution.update({
        where: { id: input.stepExecution.id },
        data: {
          status: canRetry ? StepExecutionStatus.Retrying : StepExecutionStatus.Failed,
          errorJson: serializeError(error, classification),
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
          nextRetryAt,
          effectStatus: classification === "ambiguous" ? "ambiguous" : "failed"
        }
      });
      this.logger?.warn(classification === "ambiguous" ? "worker.effect.ambiguous" : "worker.step.failed", {
        stepExecutionId: input.stepExecution.id,
        stepKey: input.step.key,
        stepType: input.step.type,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        errorCategory: classification,
        retrying: canRetry
      });
      if (canRetry) {
        this.metrics?.recordStep(input.step.type, "retry_scheduled", (completedAt.getTime() - startedAt.getTime()) / 1000, workerErrorCategory(classification));
        return { outcome: "retrying" as const, nextRetryAt: nextRetryAt as Date };
      }
      this.metrics?.recordStep(
        input.step.type,
        classification === "ambiguous" ? "ambiguous" : "failed",
        (completedAt.getTime() - startedAt.getTime()) / 1000,
        workerErrorCategory(classification)
      );
      throw error;
    }
  }

  async skip(input: {
    organizationId: string;
    executionId: string;
    workflowStepId: string;
    step: WorkflowStepDefinition;
    stepExecution: StepExecutionRecord;
    reason: string;
  }) {
    const now = new Date();
    const output = { skipped: true, reason: input.reason };
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Skipped,
        inputJson: { reason: input.reason },
        outputJson: output,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        effectStatus: "skipped"
      }
    });
    this.metrics?.recordStep(input.step.type, "skipped", 0);
    return {
      result: { status: StepExecutionStatus.Skipped, output }
    };
  }

  async completeWait(input: { step: WorkflowStepDefinition; stepExecution: StepExecutionRecord }) {
    const now = new Date();
    const output = input.stepExecution.outputJson ?? { resumed: true };
    await this.prisma.stepExecution.update({
      where: { id: input.stepExecution.id },
      data: {
        status: StepExecutionStatus.Completed,
        outputJson: toJson(output),
        errorJson: Prisma.JsonNull,
        completedAt: now,
        nextRetryAt: null,
        durationMs: 0,
        effectStatus: "succeeded"
      }
    });
    this.logger?.info("worker.flow.wait_resumed", {
      stepExecutionId: input.stepExecution.id,
      stepKey: input.step.key,
      stepType: input.step.type
    });
    this.metrics?.recordStep(input.step.type, "completed", 0);
    return { result: { status: StepExecutionStatus.Completed, output } };
  }

  private async safeConnectionMetadata(organizationId: string, config: Record<string, unknown>) {
    const connectionId = typeof config.connectionId === "string" ? config.connectionId : undefined;
    if (!connectionId) return {};
    const connection = await this.prisma.connection.findFirst({
      where: { id: connectionId, organizationId, deletedAt: null },
      select: { id: true, name: true, type: true }
    });
    if (!connection) return {};
    return { id: connection.id, name: connection.name, type: connection.type };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function serializeError(error: unknown, classification: string) {
  return {
    message: error instanceof Error ? error.message : String(error),
    classification
  };
}

function workerId() {
  return process.env.WORKER_ID ?? `${process.pid}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
