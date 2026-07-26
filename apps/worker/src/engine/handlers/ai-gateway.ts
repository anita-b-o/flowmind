import { Injectable } from "@nestjs/common";
import { StepType } from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { HttpStepError } from "../step-errors";
import { WorkerLoggerService } from "../../observability/worker-logger.service";

export interface AiGatewayTrace {
  correlationId?: string;
  executionId?: string;
  stepExecutionId?: string;
}

export interface AiGatewayInput {
  stepType: StepType;
  config: unknown;
  timeoutMs: number;
  trace: AiGatewayTrace;
}

export abstract class AiGateway {
  abstract execute(input: AiGatewayInput): Promise<unknown>;
}

const endpointByStepType: Partial<Record<StepType, string>> = {
  [StepType.AiClassification]: "/classify",
  [StepType.AiStructuredExtraction]: "/extract",
  [StepType.AiSummary]: "/summarize"
};

@Injectable()
export class HttpAiGateway implements AiGateway {
  constructor(private readonly logger?: WorkerLoggerService) {}

  async execute(input: AiGatewayInput) {
    const endpoint = endpointByStepType[input.stepType];
    if (!endpoint) throw new Error(`Unsupported AI step ${input.stepType}`);
    const baseUrl = process.env.AI_SERVICE_URL;
    const apiKey = process.env.AI_SERVICE_API_KEY;
    if (!baseUrl || !apiKey) throw new Error("External AI gateway is not configured");

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-api-key": apiKey,
        "x-request-id": newTraceId(),
        "x-correlation-id": input.trace.correlationId ?? "",
        "x-execution-id": input.trace.executionId ?? "",
        "x-step-execution-id": input.trace.stepExecutionId ?? ""
      },
      body: JSON.stringify(input.config),
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    if (!response.ok) {
      this.logger?.warn("worker.step.failed", {
        stepType: input.stepType,
        errorCategory: "ai_http",
        status: response.status
      });
      throw new HttpStepError(response.status, `AI service failed with ${response.status}`);
    }
    return response.json();
  }
}

@Injectable()
export class EmbeddedFakeAiGateway implements AiGateway {
  async execute(input: AiGatewayInput) {
    const config = record(input.config);
    const text = String(config.text ?? config.input ?? "");
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      latency_ms: 0
    };
    if (input.stepType === StepType.AiClassification) {
      return {
        label: text.toLowerCase().includes("urgent") ? "high" : "normal",
        confidence: 0.9,
        reason: "embedded demo provider rule",
        usage
      };
    }
    if (input.stepType === StepType.AiStructuredExtraction) {
      return {
        data: {
          name: "Unknown",
          company: "Unknown",
          email: "unknown@example.com",
          intent: text.slice(0, 120)
        },
        usage
      };
    }
    if (input.stepType === StepType.AiSummary) {
      return { summary: text.slice(0, 240), usage };
    }
    throw new Error(`Unsupported AI step ${input.stepType}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
