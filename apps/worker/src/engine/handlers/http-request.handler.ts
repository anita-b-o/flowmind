import { Injectable } from "@nestjs/common";
import { StepExecutionStatus, StepType, WorkflowStepDefinition, ExecutionContext, StepResult } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { StepHandler } from "../types";
import { SafeHttpClient } from "../../http/safe-http-client";
import { HttpStepError } from "../step-errors";
import { ConnectionResolver } from "../../connections/connection-resolver";
import { HttpAuthLocation, HttpAuthScheme } from "@automation/shared-types";

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
      const connection = await this.connections.resolveHttp(organizationId, config.connectionId);
      url = resolveUrl(connection.baseUrl, config.url);
      headers = { ...headers, ...connection.additionalHeaders };
      injectHttpConnection(connection, url, headers, allowedRestrictedHeaders, (nextUrl) => {
        url = nextUrl;
      });
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
    const base = new URL(baseUrl);
    const next = new URL(value, base);
    for (const [key, entry] of base.searchParams.entries()) {
      if (!next.searchParams.has(key)) next.searchParams.append(key, entry);
    }
    return next.toString();
  }
  return value;
}

function addQuerySecret(value: string, name: string, secret: string) {
  const url = new URL(value);
  url.searchParams.set(name, secret);
  return url.toString();
}

function injectHttpConnection(
  connection: Awaited<ReturnType<ConnectionResolver["resolveHttp"]>>,
  currentUrl: string,
  headers: Record<string, string>,
  allowedRestrictedHeaders: string[],
  setUrl: (url: string) => void
) {
  if (connection.authScheme === HttpAuthScheme.ApiKey) {
    if (!connection.authName || !connection.secretValue) throw new Error("HTTP API key connection is invalid");
    if (connection.authLocation === HttpAuthLocation.Query) {
      setUrl(addQuerySecret(currentUrl, connection.authName, connection.secretValue));
      return;
    }
    headers[connection.authName] = connection.secretValue;
    allowedRestrictedHeaders.push(connection.authName);
    return;
  }
  if (connection.authScheme === HttpAuthScheme.BearerToken) {
    if (!connection.secretValue) throw new Error("HTTP bearer connection is invalid");
    headers.Authorization = `Bearer ${connection.secretValue}`;
    allowedRestrictedHeaders.push("Authorization");
    return;
  }
  if (connection.authScheme === HttpAuthScheme.BasicAuth) {
    if (!connection.username || !connection.secretValue) throw new Error("HTTP basic connection is invalid");
    headers.Authorization = `Basic ${Buffer.from(`${connection.username}:${connection.secretValue}`, "utf8").toString("base64")}`;
    allowedRestrictedHeaders.push("Authorization");
    return;
  }
  for (const [name, value] of Object.entries(connection.secretHeaders ?? {})) {
    headers[name] = value;
    allowedRestrictedHeaders.push(name);
  }
}
