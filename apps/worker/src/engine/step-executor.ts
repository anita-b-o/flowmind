import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { StepRegistry } from "./step-registry";

@Injectable()
export class StepExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StepRegistry
  ) {}

  async execute(input: {
    organizationId: string;
    executionId: string;
    workflowStepId: string;
    step: WorkflowStepDefinition;
    context: any;
  }) {
    const startedAt = new Date();
    const stepExecution = await this.prisma.stepExecution.create({
      data: {
        organizationId: input.organizationId,
        executionId: input.executionId,
        workflowStepId: input.workflowStepId,
        stepKey: input.step.key,
        stepType: input.step.type,
        status: StepExecutionStatus.Running,
        inputJson: input.context
      }
    });

    try {
      input.context.metadata = {
        ...(input.context.metadata ?? {}),
        runtime: {
          organizationId: input.organizationId,
          executionId: input.executionId,
          workflowStepId: input.workflowStepId,
          stepExecutionId: stepExecution.id
        }
      };
      const handler = this.registry.get(input.step.type);
      const result = await withTimeout(
        handler.execute(input.step, input.context),
        (input.step.timeoutSeconds ?? 30) * 1000
      );
      const completedAt = new Date();
      await this.prisma.stepExecution.update({
        where: { id: stepExecution.id },
        data: {
          status: result.status,
          outputJson: result.output as object,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime()
        }
      });
      return { stepExecutionId: stepExecution.id, result };
    } catch (error) {
      const completedAt = new Date();
      await this.prisma.stepExecution.update({
        where: { id: stepExecution.id },
        data: {
          status: StepExecutionStatus.Failed,
          errorJson: serializeError(error),
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime()
        }
      });
      throw error;
    }
  }

  async skip(input: {
    organizationId: string;
    executionId: string;
    workflowStepId: string;
    step: WorkflowStepDefinition;
    reason: string;
  }) {
    const now = new Date();
    const stepExecution = await this.prisma.stepExecution.create({
      data: {
        organizationId: input.organizationId,
        executionId: input.executionId,
        workflowStepId: input.workflowStepId,
        stepKey: input.step.key,
        stepType: input.step.type,
        status: StepExecutionStatus.Skipped,
        inputJson: { reason: input.reason },
        outputJson: { skipped: true, reason: input.reason },
        startedAt: now,
        completedAt: now,
        durationMs: 0
      }
    });
    return {
      stepExecutionId: stepExecution.id,
      result: { status: StepExecutionStatus.Skipped, output: { skipped: true, reason: input.reason } }
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

function serializeError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error)
  };
}
