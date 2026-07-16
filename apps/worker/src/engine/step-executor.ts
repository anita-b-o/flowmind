import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepRegistry } from "./step-registry";
import { ErrorClassifier } from "./error-classifier";
import { RetryPolicyResolver, type RetryPolicy } from "./retry-policy-resolver";

export type StepExecutionRecord = {
  id: string;
  attemptCount: number;
  maxAttempts: number;
  status: string;
  effectKey: string | null;
  effectStatus: string | null;
};

@Injectable()
export class StepExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StepRegistry,
    private readonly errorClassifier: ErrorClassifier,
    private readonly retryPolicyResolver: RetryPolicyResolver
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
        inputJson: toJson(input.context)
      }
    });

    try {
      input.context.metadata = {
        ...(input.context.metadata ?? {}),
        runtime: {
          organizationId: input.organizationId,
          executionId: input.executionId,
          workflowStepId: input.workflowStepId,
          stepExecutionId: input.stepExecution.id,
          effectKey: input.stepExecution.effectKey ?? `flowmind:${input.executionId}:${input.step.key}`
        }
      };
      const handler = this.registry.get(input.step.type);
      const result = await withTimeout(handler.execute(input.step, input.context), policy.timeoutSeconds * 1000);
      const completedAt = new Date();
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
      if (canRetry) {
        return { outcome: "retrying" as const, nextRetryAt: nextRetryAt as Date };
      }
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
    return {
      result: { status: StepExecutionStatus.Skipped, output }
    };
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
