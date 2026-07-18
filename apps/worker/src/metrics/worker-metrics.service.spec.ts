import { request as httpRequest } from "node:http";
import { WorkerMetricsService, dlqReasonCode } from "./worker-metrics.service";

describe("WorkerMetricsService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("keeps registries isolated", async () => {
    const first = new WorkerMetricsService();
    const second = new WorkerMetricsService();
    first.jobsReceived.inc({ queue: "workflow-executions" });
    expect(await first.registry.metrics()).toContain("flowmind_workflow_jobs_received_total");
    expect(await second.registry.metrics()).not.toContain('queue="workflow-executions"');
  });

  it("does not start the endpoint when metrics are disabled", () => {
    delete process.env.METRICS_ENABLED;
    const service = new WorkerMetricsService();
    service.onModuleInit();
    expect((service as any).server).toBeUndefined();
  });

  it("protects the endpoint and closes on shutdown", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_API_KEY = "worker-metrics-key-123";
    process.env.WORKER_METRICS_PORT = "0";
    const service = new WorkerMetricsService();
    service.onModuleInit();
    await listening((service as any).server);
    const address = (service as any).server.address();
    expect(await get(address.port)).toMatchObject({ status: 401 });
    expect(await get(address.port, "wrong")).toMatchObject({ status: 403 });
    const ok = await get(address.port, "worker-metrics-key-123");
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain("worker-metrics-key-123");
    await service.onModuleDestroy();
    expect((service as any).server).toBeUndefined();
  });

  it("records jobs, leases, steps, reconciler and DLQ without business IDs", async () => {
    const service = new WorkerMetricsService();
    service.jobsReceived.inc({ queue: "workflow-executions" });
    service.activeJobs.inc({ queue: "workflow-executions" });
    service.activeJobs.dec({ queue: "workflow-executions" });
    service.recordLease("acquired");
    service.recordLease("conflict");
    service.recordLease("lost");
    service.recordStep("http_request", "completed", 0.2);
    service.recordStep("email_notification", "retry_scheduled", 0.4, "retryable");
    service.recordStep("database_record", "failed", 0.1, "non_retryable");
    service.executionsCompleted.inc();
    service.executionsFailed.inc({ error_category: "non_retryable" });
    service.executionsReconciled.inc({ reason_code: "retry_recovered" });
    service.reconcilerRuns.inc({ outcome: "completed" });
    service.reconcilerReenqueued.inc({ reason_code: "queued_job_recovered" });
    service.reconcilerDuration.observe(0.01);
    service.dlqEntries.inc({ reason_code: dlqReasonCode("failed"), outcome: "created" });
    service.dlqPublishFailures.inc({ reason_code: dlqReasonCode("ambiguous") });
    service.recordLoopIteration("success", "sequential");
    service.recordLoopIteration("failed", "sequential");
    service.recordLoopExecution("completed", "sequential", 0.5);
    service.approvalRequests.inc({ assignee_policy: "any_authorized_user" });
    service.recordApproval("approved", "ANY_AUTHORIZED_USER", 10);
    service.recordApproval("rejected", "ANY_AUTHORIZED_USER", 20);
    service.recordApproval("expired", "ANY_AUTHORIZED_USER", 42);
    service.recordApproval("cancelled", "ANY_AUTHORIZED_USER", 30);
    const output = await service.registry.metrics();
    expect(output).toContain("flowmind_worker_active_jobs");
    expect(output).toContain("flowmind_execution_lease_conflict_total");
    expect(output).toContain("flowmind_step_duration_seconds_bucket");
    expect(output).toContain("flowmind_reconciler_runs_total");
    expect(output).toContain("flowmind_dlq_publish_failures_total");
    expect(output).toContain('flowmind_loop_iterations_total{outcome="success",mode="sequential",service="worker"} 1');
    expect(output).toContain('flowmind_loop_iteration_failures_total{mode="sequential",service="worker"} 1');
    expect(output).toContain('flowmind_approval_outcomes_total{outcome="expired",assignee_policy="any_authorized_user",service="worker"} 1');
    expect(output).toContain('flowmind_approval_outcomes_total{outcome="approved",assignee_policy="any_authorized_user",service="worker"} 1');
    expect(output).toContain('flowmind_approval_outcomes_total{outcome="rejected",assignee_policy="any_authorized_user",service="worker"} 1');
    expect(output).toContain('flowmind_approval_outcomes_total{outcome="cancelled",assignee_policy="any_authorized_user",service="worker"} 1');
    expect(output.match(/flowmind_approval_decision_latency_seconds_count\{[^}]*outcome="approved"[^}]*\} 1/g)).toHaveLength(1);
    expect(output).not.toMatch(/(executionId|workflowId|workerId|jobId|correlationId|requestId|email|hostname)=/);
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
