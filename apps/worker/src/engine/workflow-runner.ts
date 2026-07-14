import { Injectable } from "@nestjs/common";
import { ExecutionJobPayload, ExecutionStatus, StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { StepExecutor } from "./step-executor";

@Injectable()
export class WorkflowRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor
  ) {}

  async run(payload: ExecutionJobPayload) {
    const execution = await this.prisma.execution.findFirst({
      where: {
        id: payload.executionId,
        organizationId: payload.organizationId
      },
      include: {
        workflowVersion: {
          include: { steps: { orderBy: { position: "asc" } } }
        }
      }
    });
    if (!execution) {
      throw new Error(`Execution ${payload.executionId} not found`);
    }
    if ([ExecutionStatus.Completed, ExecutionStatus.Cancelled].includes(execution.status as ExecutionStatus)) {
      return;
    }

    await this.prisma.execution.update({
      where: { id: execution.id },
      data: { status: ExecutionStatus.Running, startedAt: execution.startedAt ?? new Date() }
    });

    const context = execution.contextJson as any;
    context.metadata = {
      ...(context.metadata ?? {}),
      organizationId: execution.organizationId,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      executionId: execution.id
    };
    try {
      let skipNext = false;
      for (const dbStep of execution.workflowVersion.steps) {
        if (dbStep.position === 0) {
          continue;
        }
        if (context.steps?.[dbStep.key]?.status === StepExecutionStatus.Completed) {
          continue;
        }

        const step: WorkflowStepDefinition = {
          id: dbStep.id,
          key: dbStep.key,
          name: dbStep.name,
          type: dbStep.type as any,
          position: dbStep.position,
          config: dbStep.configJson as Record<string, unknown>,
          retryPolicy: dbStep.retryPolicyJson as any,
          timeoutSeconds: dbStep.timeoutSeconds ?? undefined
        };
        if (skipNext) {
          const { result } = await this.stepExecutor.skip({
            organizationId: execution.organizationId,
            executionId: execution.id,
            workflowStepId: dbStep.id,
            step,
            reason: "skipNextOnFalse"
          });
          context.steps[step.key] = { output: result.output, status: result.status };
          skipNext = false;
          await this.prisma.execution.update({
            where: { id: execution.id },
            data: { contextJson: context }
          });
          continue;
        }
        const { result } = await this.stepExecutor.execute({
          organizationId: execution.organizationId,
          executionId: execution.id,
          workflowStepId: dbStep.id,
          step,
          context
        });
        context.steps[step.key] = { output: result.output, status: result.status };
        if (result.control?.skipNext) {
          skipNext = true;
        }
        await this.prisma.execution.update({
          where: { id: execution.id },
          data: { contextJson: context }
        });
      }

      await this.prisma.execution.update({
        where: { id: execution.id },
        data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: context }
      });
    } catch (error) {
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: ExecutionStatus.Failed,
          completedAt: new Date(),
          errorJson: { message: error instanceof Error ? error.message : String(error) }
        }
      });
      throw error;
    }
  }
}
