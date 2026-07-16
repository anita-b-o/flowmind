import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { HttpMetricsMiddleware } from "../src/metrics/http-metrics.middleware";
import { classifyError, normalizeRoute } from "../src/metrics/metrics-catalog";
import { ApiMetricsService } from "../src/metrics/metrics.service";

describe("API metrics", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("stays disabled by default", () => {
    delete process.env.METRICS_ENABLED;
    const service = new ApiMetricsService();
    expect(service.enabled()).toBe(false);
  });

  it("starts a protected metrics server when enabled and closes it on shutdown", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_API_KEY = "test-metrics-key-123";
    process.env.API_METRICS_PORT = "0";
    const service = new ApiMetricsService();
    service.onModuleInit();
    await listening((service as any).server);
    const address = (service as any).server.address();
    expect(await get(address.port)).toMatchObject({ status: 401 });
    expect(await get(address.port, "wrong")).toMatchObject({ status: 403 });
    const ok = await get(address.port, "test-metrics-key-123");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("# HELP");
    expect(ok.body).not.toContain("test-metrics-key-123");
    await service.onModuleDestroy();
    expect((service as any).server).toBeUndefined();
  });

  it("records HTTP requests once with normalized dynamic routes and duration buckets", async () => {
    process.env.METRICS_ENABLED = "true";
    const service = new ApiMetricsService();
    const middleware = new HttpMetricsMiddleware(service);
    const response = new EventEmitter() as any;
    response.statusCode = 200;
    const request = {
      method: "GET",
      path: "/executions/123e4567-e89b-12d3-a456-426614174000",
      route: undefined
    } as any;
    middleware.use(request, response, jest.fn());
    response.emit("finish");
    const output = await service.registry.metrics();
    expect(output).toContain('flowmind_http_requests_total{method="GET",route="/executions/:id",status_class="2xx",service="api"} 1');
    expect(output).toContain('flowmind_http_request_duration_seconds_bucket{le="0.005",service="api",method="GET",route="/executions/:id",status_class="2xx"}');
    expect(output).not.toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("records webhook, auth, retry, enqueue and readiness metrics without high-cardinality labels", async () => {
    const service = new ApiMetricsService();
    service.recordWebhook("accepted", "accepted");
    service.recordWebhook("rejected", "rate_limited");
    service.recordAuthLogin("success");
    service.recordAuthLogin("invalid_credentials");
    service.recordAuthRefresh("reuse_detected");
    service.recordManualRetry("success");
    service.recordEnqueueFailure("webhook", classifyError(new Error("redis unavailable")));
    service.readinessFailures.inc({ reason_code: "database" });
    const output = await service.registry.metrics();
    expect(output).toContain("flowmind_webhook_requests_total");
    expect(output).toContain("flowmind_webhook_rate_limited_total");
    expect(output).toContain("flowmind_auth_login_total");
    expect(output).toContain("flowmind_auth_refresh_reuse_detected_total");
    expect(output).toContain("flowmind_manual_retries_total");
    expect(output).toContain("flowmind_enqueue_failures_total");
    expect(output).toContain("flowmind_readiness_failures_total");
    expect(output).not.toMatch(/(executionId|workflowId|correlationId|requestId|email|token|cookie|hostname)=/);
  });

  it("normalizes route candidates before they become labels", () => {
    expect(normalizeRoute("/executions/123e4567-e89b-12d3-a456-426614174000")).toBe("/executions/:id");
    expect(normalizeRoute("/webhooks/workflow-verylongid/token-verylongid", "POST")).toBe("/webhooks/:workflowId/:token");
  });
});

function get(port: number, key?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/metrics", headers: key ? { authorization: `Bearer ${key}` } : {} },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function listening(server: any) {
  return new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
}
