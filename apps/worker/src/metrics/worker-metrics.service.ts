import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const STEP_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export type WorkerErrorCategory = "retryable" | "non_retryable" | "ambiguous" | "unknown";
export type LeaseOutcome = "acquired" | "conflict" | "expired_recovery" | "lost" | "released";
export type StepOutcome = "completed" | "retry_scheduled" | "failed" | "skipped" | "ambiguous";
export type ReconcilerReason = "run_completed" | "run_failed" | "execution_requeued" | "retry_recovered" | "expired_lease_recovered" | "queued_job_recovered";
export type DlqReason = "non_retryable" | "attempts_exhausted" | "ambiguous_effect" | "inconsistent_state" | "invalid_wait" | "branch_resolution_failed" | "control_validation_failed";

@Injectable()
export class WorkerMetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();
  private server?: Server;

  readonly jobsReceived = new Counter({
    name: "flowmind_workflow_jobs_received_total",
    help: "Workflow jobs received by the worker.",
    labelNames: ["queue"],
    registers: [this.registry]
  });
  readonly executionsCompleted = new Counter({
    name: "flowmind_workflow_executions_completed_total",
    help: "Workflow executions completed by the worker.",
    registers: [this.registry]
  });
  readonly executionsFailed = new Counter({
    name: "flowmind_workflow_executions_failed_total",
    help: "Workflow executions failed by the worker.",
    labelNames: ["error_category"],
    registers: [this.registry]
  });
  readonly executionsReconciled = new Counter({
    name: "flowmind_workflow_executions_reconciled_total",
    help: "Workflow executions recovered by reconciler.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });
  readonly leaseAcquire = new Counter({
    name: "flowmind_execution_lease_acquire_total",
    help: "Execution lease acquire outcomes.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly leaseConflict = new Counter({
    name: "flowmind_execution_lease_conflict_total",
    help: "Execution lease conflicts.",
    registers: [this.registry]
  });
  readonly leaseLost = new Counter({
    name: "flowmind_execution_lease_lost_total",
    help: "Execution lease losses.",
    registers: [this.registry]
  });
  readonly stepExecutions = new Counter({
    name: "flowmind_step_executions_total",
    help: "Step execution attempts.",
    labelNames: ["step_type", "outcome"],
    registers: [this.registry]
  });
  readonly stepRetries = new Counter({
    name: "flowmind_step_retries_total",
    help: "Step retries scheduled.",
    labelNames: ["step_type", "error_category"],
    registers: [this.registry]
  });
  readonly stepFailures = new Counter({
    name: "flowmind_step_failures_total",
    help: "Step failures.",
    labelNames: ["step_type", "error_category"],
    registers: [this.registry]
  });
  readonly stepDuration = new Histogram({
    name: "flowmind_step_duration_seconds",
    help: "Step execution duration.",
    labelNames: ["step_type", "outcome"],
    buckets: STEP_BUCKETS,
    registers: [this.registry]
  });
  readonly dlqEntries = new Counter({
    name: "flowmind_dlq_entries_total",
    help: "Persistent DLQ entries.",
    labelNames: ["reason_code", "outcome"],
    registers: [this.registry]
  });
  readonly dlqPublishFailures = new Counter({
    name: "flowmind_dlq_publish_failures_total",
    help: "DLQ publish failures.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });
  readonly activeJobs = new Gauge({
    name: "flowmind_worker_active_jobs",
    help: "Active workflow jobs.",
    labelNames: ["queue"],
    registers: [this.registry]
  });
  readonly reconcilerRuns = new Counter({
    name: "flowmind_reconciler_runs_total",
    help: "Reconciler runs.",
    labelNames: ["outcome"],
    registers: [this.registry]
  });
  readonly reconcilerReenqueued = new Counter({
    name: "flowmind_reconciler_reenqueued_total",
    help: "Executions reenqueued by reconciler.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });
  readonly reconcilerDuration = new Histogram({
    name: "flowmind_reconciler_duration_seconds",
    help: "Reconciler run duration.",
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry]
  });
  readonly stepWaitScheduled = new Counter({
    name: "flowmind_step_wait_scheduled_total",
    help: "Intentional workflow waits scheduled by step type.",
    labelNames: ["step_type", "reason"],
    registers: [this.registry]
  });
  readonly stepWaitDuration = new Histogram({
    name: "flowmind_step_wait_duration_seconds",
    help: "Intentional workflow wait duration.",
    labelNames: ["step_type"],
    buckets: [1, 5, 10, 30, 60, 300, 900, 3600, 7200, 21600],
    registers: [this.registry]
  });
  readonly branchSelected = new Counter({
    name: "flowmind_branch_selected_total",
    help: "Branch selections by control step type.",
    labelNames: ["step_type", "branch"],
    registers: [this.registry]
  });
  readonly graphValidationFailures = new Counter({
    name: "flowmind_graph_validation_failures_total",
    help: "Workflow graph validation failures.",
    labelNames: ["reason_code"],
    registers: [this.registry]
  });

  constructor() {
    this.registry.setDefaultLabels({ service: "worker" });
    if (this.enabled() && process.env.NODE_ENV !== "test") {
      collectDefaultMetrics({ register: this.registry, prefix: "flowmind_worker_" });
    }
  }

  onModuleInit() {
    if (!this.enabled()) return;
    this.server = createServer(async (request, response) => {
      if (request.url?.split("?")[0] !== "/metrics") return writeText(response, 404, "not_found\n");
      if (!this.hasCredential(request.headers.authorization, request.headers["x-metrics-api-key"])) return writeText(response, 401, "missing credentials\n");
      if (!this.isAuthorized(request.headers.authorization, request.headers["x-metrics-api-key"])) return writeText(response, 403, "forbidden\n");
      response.writeHead(200, { "content-type": this.registry.contentType });
      response.end(await this.registry.metrics());
    });
    this.server.on("error", (error) => console.warn("Worker metrics server failed", { message: error.message }));
    this.server.listen(Number(process.env.WORKER_METRICS_PORT ?? 9465), process.env.METRICS_HOST ?? "127.0.0.1");
    this.server.unref();
  }

  async onModuleDestroy() {
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  enabled() {
    return process.env.METRICS_ENABLED === "true";
  }

  recordLease(outcome: LeaseOutcome) {
    this.leaseAcquire.inc({ outcome });
    if (outcome === "conflict") this.leaseConflict.inc();
    if (outcome === "lost") this.leaseLost.inc();
  }

  recordStep(stepType: string, outcome: StepOutcome, durationSeconds: number, errorCategory?: WorkerErrorCategory) {
    this.stepExecutions.inc({ step_type: safeStepType(stepType), outcome });
    this.stepDuration.observe({ step_type: safeStepType(stepType), outcome }, durationSeconds);
    if (outcome === "retry_scheduled") this.stepRetries.inc({ step_type: safeStepType(stepType), error_category: errorCategory ?? "unknown" });
    if (outcome === "failed" || outcome === "ambiguous") this.stepFailures.inc({ step_type: safeStepType(stepType), error_category: errorCategory ?? "unknown" });
  }

  recordWait(stepType: string, reason: string, durationSeconds: number) {
    this.stepWaitScheduled.inc({ step_type: safeStepType(stepType), reason: safeReason(reason) });
    this.stepWaitDuration.observe({ step_type: safeStepType(stepType) }, durationSeconds);
  }

  recordBranch(stepType: string, branch: string) {
    this.branchSelected.inc({ step_type: safeStepType(stepType), branch: safeReason(branch) });
  }

  private hasCredential(authorization: string | undefined, header: string | string[] | undefined) {
    return Boolean(bearerToken(authorization) || headerValue(header));
  }

  private isAuthorized(authorization: string | undefined, header: string | string[] | undefined) {
    const presented = bearerToken(authorization) ?? headerValue(header) ?? "";
    const expected = process.env.METRICS_API_KEY ?? "";
    if (!presented || !expected) return false;
    const left = Buffer.from(presented);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

export function safeStepType(value: string) {
  return /^[a-z][a-z0-9_]{0,40}$/.test(value) ? value : "unknown";
}

export function workerErrorCategory(value: unknown): WorkerErrorCategory {
  return value === "retryable" || value === "non_retryable" || value === "ambiguous" ? value : "unknown";
}

export function dlqReasonCode(reason: string | undefined): DlqReason {
  if (reason === "ambiguous") return "ambiguous_effect";
  if (reason === "failed") return "attempts_exhausted";
  if (reason === "non_retryable") return "non_retryable";
  if (reason === "invalid_wait") return "invalid_wait";
  if (reason === "branch_resolution_failed") return "branch_resolution_failed";
  if (reason === "control_validation_failed") return "control_validation_failed";
  return "inconsistent_state";
}

function safeReason(value: string) {
  return /^[a-z][a-z0-9_]{0,40}$/.test(value) ? value : "unknown";
}

function bearerToken(value: string | undefined) {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function writeText(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}
