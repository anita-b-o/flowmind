import { Injectable } from "@nestjs/common";
import {
  ExecutionContext,
  StepExecutionStatus,
  StepResult,
  StepType,
  WorkflowStepDefinition
} from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { JobContextService } from "../../observability/job-context.service";
import { AiGateway } from "./ai-gateway";

@Injectable()
export class AiHandler implements StepHandler {
  type = StepType.AiClassification;

  constructor(
    private readonly resolver: ExpressionResolver,
    private readonly gateway: AiGateway,
    private readonly jobContext?: JobContextService
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    if (
      ![StepType.AiClassification, StepType.AiStructuredExtraction, StepType.AiSummary].includes(
        step.type
      )
    ) {
      throw new Error(`Unsupported AI step ${step.type}`);
    }
    const config = this.resolver.resolveValue(
      step.config,
      context as unknown as Record<string, unknown>
    );
    const trace = this.jobContext?.getContext();
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, unknown>;
    const output = await this.gateway.execute({
      stepType: step.type,
      config,
      timeoutMs: (step.timeoutSeconds ?? 60) * 1000,
      trace: {
        correlationId: trace?.correlationId ?? String(runtime.correlationId ?? ""),
        executionId: trace?.executionId ?? String(runtime.executionId ?? ""),
        stepExecutionId: String(runtime.stepExecutionId ?? "")
      }
    });
    return { status: StepExecutionStatus.Completed, output };
  }
}
