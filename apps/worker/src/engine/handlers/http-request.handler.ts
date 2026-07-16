import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepType, WorkflowStepDefinition, ExecutionContext, StepResult } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { SafeHttpClient } from "../../http/safe-http-client";
import { HttpStepError } from "../step-errors";

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

    const method = (config.method ?? "GET").toUpperCase();
    const headers = { ...(config.headers ?? {}) };
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, string>;
    if (["POST", "PATCH", "DELETE"].includes(method) && runtime.effectKey && !hasHeader(headers, "idempotency-key")) {
      headers["Idempotency-Key"] = runtime.effectKey;
    }
    const response = await this.safeHttpClient.request({
      url: config.url,
      method,
      headers,
      body: config.body,
      timeoutMs: (step.timeoutSeconds ?? 15) * 1000
    });
    if (!response.ok) {
      throw new HttpStepError(response.status);
    }
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

function hasHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
