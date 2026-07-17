import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { AuthOutcome, ErrorCategory, WebhookOutcome, WebhookReasonCode } from "./metrics-catalog";

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class ApiMetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();
  private server?: Server;

  readonly httpRequests = new Counter({
    name: "flowmind_http_requests_total",
    help: "API HTTP requests.",
    labelNames: ["method", "route", "status_class"],
    registers: [this.registry]
  });
  readonly httpDuration = new Histogram({
    name: "flowmind_http_request_duration_seconds",
    help: "API HTTP request duration.",
    labelNames: ["method", "route", "status_class"],
    buckets: HTTP_BUCKETS,
    registers: [this.registry]
  });
  readonly httpErrors = new Counter({
    name: "flowmind_http_errors_total",
    help: "API HTTP errors.",
    labelNames: ["method", "route", "status_class", "error_category"],
    registers: [this.registry]
  });
  readonly webhookRequests = new Counter({
    name: "flowmind_webhook_requests_total",
    help: "Webhook requests by outcome.",
    labelNames: ["outcome", "reason_code"],
    registers: [this.registry]
  });
  readonly webhookRejected = new Counter({
    name: "flowmind_webhook_rejected_total",
    help: "Rejected webhook requests.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });
  readonly webhookRateLimited = new Counter({
    name: "flowmind_webhook_rate_limited_total",
    help: "Rate limited webhook requests.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });
  readonly authLogin = new Counter({
    name: "flowmind_auth_login_total",
    help: "Authentication login attempts.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly authRefresh = new Counter({
    name: "flowmind_auth_refresh_total",
    help: "Authentication refresh attempts.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly authRefreshReuseDetected = new Counter({
    name: "flowmind_auth_refresh_reuse_detected_total",
    help: "Refresh token reuse detections.",
    registers: [this.registry]
  });
  readonly manualRetries = new Counter({
    name: "flowmind_manual_retries_total",
    help: "Manual execution retry requests.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly manualExecutions = new Counter({
    name: "flowmind_manual_executions_total",
    help: "Manual execution requests.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly executionCancels = new Counter({
    name: "flowmind_execution_cancels_total",
    help: "Execution cancel requests.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly enqueueFailures = new Counter({
    name: "flowmind_enqueue_failures_total",
    help: "Execution enqueue failures.",
    labelNames: ["operation", "error_category"],
    registers: [this.registry]
  });
  readonly readinessFailures = new Counter({
    name: "flowmind_readiness_failures_total",
    help: "API readiness failures.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });

  constructor() {
    this.registry.setDefaultLabels({ service: "api" });
    if (this.enabled() && process.env.NODE_ENV !== "test") {
      collectDefaultMetrics({ register: this.registry, prefix: "flowmind_api_" });
    }
  }

  onModuleInit() {
    if (!this.enabled()) return;
    this.server = createServer(async (request, response) => {
      if (request.url?.split("?")[0] !== "/metrics") {
        writeText(response, 404, "not_found\n");
        return;
      }
      if (!this.hasCredential(request.headers.authorization, request.headers["x-metrics-api-key"])) {
        writeText(response, 401, "missing credentials\n");
        return;
      }
      if (!this.isAuthorized(request.headers.authorization, request.headers["x-metrics-api-key"])) {
        writeText(response, 403, "forbidden\n");
        return;
      }
      response.writeHead(200, { "content-type": this.registry.contentType });
      response.end(await this.registry.metrics());
    });
    this.server.on("error", (error) => {
      console.warn("API metrics server failed", { message: error.message });
    });
    this.server.listen(this.port(), this.host());
    this.server.unref();
  }

  async onModuleDestroy() {
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  recordWebhook(outcome: WebhookOutcome, reasonCode: WebhookReasonCode) {
    this.webhookRequests.inc({ outcome, reason_code: reasonCode });
    if (outcome === "rejected") this.webhookRejected.inc({ reason_code: reasonCode });
    if (reasonCode === "rate_limited") this.webhookRateLimited.inc({ reason_code: reasonCode });
  }

  recordAuthLogin(outcome: AuthOutcome) {
    this.authLogin.inc({ outcome });
  }

  recordAuthRefresh(outcome: AuthOutcome) {
    this.authRefresh.inc({ outcome });
    if (outcome === "reuse_detected") this.authRefreshReuseDetected.inc();
  }

  recordManualRetry(outcome: "success" | "not_found" | "conflict" | "enqueue_failed" | "error") {
    this.manualRetries.inc({ outcome });
  }

  recordManualExecution(outcome: "success" | "conflict" | "enqueue_failed" | "rejected") {
    this.manualExecutions.inc({ outcome });
  }

  recordExecutionCancel(outcome: "success" | "not_found" | "conflict") {
    this.executionCancels.inc({ outcome });
  }

  recordEnqueueFailure(operation: "webhook" | "manual_retry", errorCategory: ErrorCategory) {
    this.enqueueFailures.inc({ operation, error_category: errorCategory });
  }

  enabled() {
    return process.env.METRICS_ENABLED === "true";
  }

  private host() {
    return process.env.METRICS_HOST ?? "127.0.0.1";
  }

  private port() {
    return Number(process.env.API_METRICS_PORT ?? 9464);
  }

  private apiKey() {
    return process.env.METRICS_API_KEY ?? "";
  }

  private hasCredential(authorization: string | undefined, header: string | string[] | undefined) {
    return Boolean(bearerToken(authorization) || headerValue(header));
  }

  private isAuthorized(authorization: string | undefined, header: string | string[] | undefined) {
    const presented = bearerToken(authorization) ?? headerValue(header) ?? "";
    const expected = this.apiKey();
    if (!presented || !expected) return false;
    const left = Buffer.from(presented);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function writeText(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}
