import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepType, WorkflowStepDefinition, ExecutionContext, StepResult } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { SafeHttpClient } from "../../http/safe-http-client";
import { HttpStepError } from "../step-errors";
import { ConnectionResolver } from "../../connections/connection-resolver";
import { HttpAuthLocation } from "@automation/shared-types";

@Injectable()
export class HttpRequestHandler implements StepHandler {
  type = StepType.HttpRequest;

  constructor(
    private readonly resolver: ExpressionResolver,
    private readonly safeHttpClient: SafeHttpClient,
    private readonly connections: ConnectionResolver
  ) {}

  async execute(step: WorkflowStepDefinition, context: ExecutionContext): Promise<StepResult> {
    const config = this.resolver.resolveValue(step.config, context as unknown as Record<string, unknown>) as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      connectionId?: string;
    };

    const method = (config.method ?? "GET").toUpperCase();
    const runtime = (context.metadata?.runtime ?? {}) as Record<string, string>;
    const metadata = context.metadata as Record<string, string>;
    let url = config.url;
    let headers = { ...(config.headers ?? {}) };
    const allowedRestrictedHeaders: string[] = [];
    if (config.connectionId) {
      const organizationId = runtime.organizationId ?? metadata.organizationId;
      if (!organizationId) {
        throw new Error("HTTP connection resolution is missing organization metadata");
      }
      const connection = await this.connections.resolveHttpApiKey(organizationId, config.connectionId);
      url = resolveUrl(connection.baseUrl, config.url);
      headers = { ...connection.additionalHeaders, ...headers };
      if (connection.authLocation === HttpAuthLocation.Header) {
        headers[connection.authName] = connection.secretValue;
        allowedRestrictedHeaders.push(connection.authName);
      } else {
        url = addQuerySecret(url, connection.authName, connection.secretValue);
      }
    }
    if (["POST", "PATCH", "DELETE"].includes(method) && runtime.effectKey && !hasHeader(headers, "idempotency-key")) {
      headers["Idempotency-Key"] = runtime.effectKey;
    }
    const response = await this.safeHttpClient.request({
      url,
      method,
      headers,
      body: config.body,
      timeoutMs: (step.timeoutSeconds ?? 15) * 1000,
      allowedRestrictedHeaders
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

function resolveUrl(baseUrl: string | undefined, value: string) {
  if (baseUrl && value.startsWith("/")) {
    return new URL(value, baseUrl).toString();
  }
  return value;
}

function addQuerySecret(value: string, name: string, secret: string) {
  const url = new URL(value);
  url.searchParams.set(name, secret);
  return url.toString();
}
