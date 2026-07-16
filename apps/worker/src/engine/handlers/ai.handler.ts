import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { HttpStepError } from "../step-errors";
import { JobContextService } from "../../observability/job-context.service";
import { WorkerLoggerService } from "../../observability/worker-logger.service";
import { newTraceId } from "@automation/observability";

const aiEndpointByStepType: Partial<Record<StepType, string>> = {
  [StepType.AiClassification]: "/classify",
  [StepType.AiStructuredExtraction]: "/extract",
  [StepType.AiSummary]: "/summarize"
};

@Injectable()
export class AiHandler implements StepHandler {
  type = StepType.AiClassification;

  constructor(
    private readonly resolver: ExpressionResolver,
    private readonly jobContext?: JobContextService,
    private readonly logger?: WorkerLoggerService
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const endpoint = aiEndpointByStepType[step.type];
    if (!endpoint) {
      throw new Error(`Unsupported AI step ${step.type}`);
    }

    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>);
    const trace = this.jobContext?.getContext();
    const aiRequestId = newTraceId();
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, unknown>;
    const response = await fetch(`${process.env.AI_SERVICE_URL ?? "http://localhost:8000"}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-api-key": process.env.AI_SERVICE_API_KEY ?? "dev-ai-service-key",
        "x-request-id": aiRequestId,
        "x-correlation-id": trace?.correlationId ?? String(runtime.correlationId ?? ""),
        "x-execution-id": trace?.executionId ?? String(runtime.executionId ?? ""),
        "x-step-execution-id": String(runtime.stepExecutionId ?? "")
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout((step.timeoutSeconds ?? 60) * 1000)
    });

    if (!response.ok) {
      this.logger?.warn("worker.step.failed", { stepKey: step.key, stepType: step.type, errorCategory: "ai_http", status: response.status });
      throw new HttpStepError(response.status, `AI service failed with ${response.status}`);
    }

    return {
      status: StepExecutionStatus.Completed,
      output: await response.json()
    };
  }
}
