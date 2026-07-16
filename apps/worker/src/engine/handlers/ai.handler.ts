import { Injectable } from "@nestjs/common";
import { ExecutionContext, StepExecutionStatus, StepResult, StepType, WorkflowStepDefinition } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { HttpStepError } from "../step-errors";

const aiEndpointByStepType: Partial<Record<StepType, string>> = {
  [StepType.AiClassification]: "/classify",
  [StepType.AiStructuredExtraction]: "/extract",
  [StepType.AiSummary]: "/summarize"
};

@Injectable()
export class AiHandler implements StepHandler {
  type = StepType.AiClassification;

  constructor(private readonly resolver: ExpressionResolver) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const endpoint = aiEndpointByStepType[step.type];
    if (!endpoint) {
      throw new Error(`Unsupported AI step ${step.type}`);
    }

    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>);
    const response = await fetch(`${process.env.AI_SERVICE_URL ?? "http://localhost:8000"}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-api-key": process.env.AI_SERVICE_API_KEY ?? "dev-ai-service-key"
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout((step.timeoutSeconds ?? 60) * 1000)
    });

    if (!response.ok) {
      throw new HttpStepError(response.status, `AI service failed with ${response.status}`);
    }

    return {
      status: StepExecutionStatus.Completed,
      output: await response.json()
    };
  }
}
