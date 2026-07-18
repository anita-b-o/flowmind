import { Injectable } from "@nestjs/common";
import { type ExecutionContext, StepExecutionStatus } from "@automation/shared-types";

type ExecutionLike = {
  id: string;
  organizationId: string;
  workflowId: string;
  workflowVersionId?: string | null;
  correlationId?: string | null;
  retryOfExecutionId?: string | null;
  startedAt?: Date | null;
  inputJson: unknown;
  workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null;
  workflowVersion?: { definitionJson: unknown; workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null } | null;
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
    const definition = asRecord(execution.workflowVersion?.definitionJson);
    const workflow = execution.workflowVersion?.workflow ?? execution.workflow;
    const organization = workflow?.organization;
    const context: ExecutionContext = {
      trigger: asRecord(input.trigger),
      steps: {},
      workflow: {
        id: execution.workflowId,
        versionId: execution.workflowVersionId ?? null,
        name: workflow?.name,
        variables: asRecord(definition.workflowVariables),
        environment: asRecord(definition.environmentVariables)
      },
      execution: {
        id: execution.id,
        correlationId: execution.correlationId,
        retryOfExecutionId: execution.retryOfExecutionId,
        startedAt: execution.startedAt?.toISOString()
      },
      organization: {
        id: execution.organizationId,
        slug: organization?.slug,
        variables: {}
      },
      connection: {},
      metadata: {
        ...asRecord(input.metadata),
        organizationId: execution.organizationId,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId ?? null,
        executionId: execution.id,
        expressionMode: definition.expressionMode === "strict" ? "strict" : "legacy"
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
