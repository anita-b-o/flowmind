import { Injectable } from "@nestjs/common";
import { type ExecutionContext, StepExecutionStatus } from "@automation/shared-types";

type ExecutionLike = {
  id: string;
  organizationId: string;
  workflowId: string;
  workflowVersionId: string;
  inputJson: unknown;
};

type StepExecutionLike = {
  stepKey: string;
  status: string;
  outputJson: unknown;
};

@Injectable()
export class ContextReconstructor {
  reconstruct(execution: ExecutionLike, stepExecutions: StepExecutionLike[]): ExecutionContext {
    const input = asRecord(execution.inputJson);
    const context: ExecutionContext = {
      trigger: asRecord(input.trigger),
      steps: {},
      metadata: {
        ...asRecord(input.metadata),
        organizationId: execution.organizationId,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
        executionId: execution.id
      }
    };

    for (const stepExecution of stepExecutions) {
      if ([StepExecutionStatus.Completed, StepExecutionStatus.Skipped].includes(stepExecution.status as StepExecutionStatus)) {
        context.steps[stepExecution.stepKey] = {
          output: stepExecution.outputJson,
          status: stepExecution.status as StepExecutionStatus
        };
      }
    }
    return context;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
