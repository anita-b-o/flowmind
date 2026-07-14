import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepType, WorkflowStepDefinition, ExecutionContext, StepResult } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { SafeHttpClient } from "../../http/safe-http-client";

@Injectable()
export class HttpRequestHandler implements StepHandler {
  type = StepType.HttpRequest;

  constructor(
    private readonly resolver: ExpressionResolver,
    private readonly safeHttpClient: SafeHttpClient
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };

    const response = await this.safeHttpClient.request({
      url: config.url,
      method: config.method,
      headers: config.headers,
      body: config.body,
      timeoutMs: (step.timeoutSeconds ?? 15) * 1000
    });
    return {
      status: StepExecutionStatus.Completed,
      output: {
        status: response.status,
        ok: response.ok,
        body: response.body
      }
    };
  }
}
