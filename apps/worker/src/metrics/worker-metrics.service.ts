import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const STEP_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export type WorkerErrorCategory = "retryable" | "non_retryable" | "ambiguous" | "unknown";
export type LeaseOutcome = "acquired" | "conflict" | "expired_recovery" | "lost" | "released";
export type StepOutcome = "completed" | "retry_scheduled" | "failed" | "skipped" | "ambiguous";
export type TransformOutcome = "success" | "failure";
export type ReconcilerReason = "run_completed" | "run_failed" | "execution_requeued" | "retry_recovered" | "expired_lease_recovered" | "queued_job_recovered";
export type DlqReason = "non_retryable" | "attempts_exhausted" | "ambiguous_effect" | "inconsistent_state" | "invalid_wait" | "branch_resolution_failed" | "control_validation_failed";

@Injectable()
export class WorkerMetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();
  private server?: Server;
  readonly approvalRequests = new Counter({ name: "flowmind_approval_requests_total", help: "Approval requests created.", labelNames: ["assignee_policy"], registers: [this.registry] });
  readonly approvalOutcomes = new Counter({ name: "flowmind_approval_outcomes_total", help: "Approval outcomes processed.", labelNames: ["outcome", "assignee_policy"], registers: [this.registry] });
  readonly approvalLatency = new Histogram({ name: "flowmind_approval_decision_latency_seconds", help: "Approval decision latency.", labelNames: ["outcome", "assignee_policy"], buckets: [1, 10, 60, 300, 3600, 86400, 604800], registers: [this.registry] });

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
  readonly transformExecutions = new Counter({
    name: "flowmind_transform_executions_total",
    help: "Transform step executions by mode and outcome.",
    labelNames: ["mode", "outcome"],
    registers: [this.registry]
  });
  readonly transformFailures = new Counter({
    name: "flowmind_transform_failures_total",
    help: "Transform step failures by mode and category.",
    labelNames: ["mode", "category"],
    registers: [this.registry]
  });
  readonly transformLimitExceeded = new Counter({
    name: "flowmind_transform_limit_exceeded_total",
    help: "Transform step limit exceeded failures by mode.",
    labelNames: ["mode"],
    registers: [this.registry]
  });
  readonly transformDuration = new Histogram({
    name: "flowmind_transform_duration_seconds",
    help: "Transform step execution duration.",
    labelNames: ["mode", "outcome"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry]
  });
  readonly dataStoreOperations = new Counter({
    name: "flowmind_data_store_operations_total",
    help: "Data Store operations by outcome.",
    labelNames: ["operation", "outcome"],
    registers: [this.registry]
  });
  readonly dataStoreErrors = new Counter({
    name: "flowmind_data_store_errors_total",
    help: "Data Store operation errors by category.",
    labelNames: ["operation", "error_category"],
    registers: [this.registry]
  });
  readonly dataStoreLatency = new Histogram({
    name: "flowmind_data_store_latency_seconds",
    help: "Data Store operation latency.",
    labelNames: ["operation", "outcome"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry]
  });
  readonly variableOperations = new Counter({
    name: "flowmind_variable_operations_total",
    help: "Workflow variable operations by operation and outcome.",
    labelNames: ["operation", "outcome"],
    registers: [this.registry]
  });
  readonly variableErrors = new Counter({
    name: "flowmind_variable_errors_total",
    help: "Workflow variable operation errors by category.",
    labelNames: ["operation", "error_category"],
    registers: [this.registry]
  });
  readonly variableLatency = new Histogram({
    name: "flowmind_variable_latency_seconds",
    help: "Workflow variable operation latency.",
    labelNames: ["operation", "outcome"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry]
  });
  readonly loopExecutions = new Counter({
    name: "flowmind_loop_executions_total",
    help: "FOR_EACH loop executions by outcome and mode.",
    labelNames: ["outcome", "mode"],
    registers: [this.registry]
  });
  readonly loopIterations = new Counter({
    name: "flowmind_loop_iterations_total",
    help: "FOR_EACH iterations by outcome and mode.",
    labelNames: ["outcome", "mode"],
    registers: [this.registry]
  });
  readonly loopIterationFailures = new Counter({
    name: "flowmind_loop_iteration_failures_total",
    help: "Failed FOR_EACH iterations by mode.",
    labelNames: ["mode"],
    registers: [this.registry]
  });
  readonly loopDuration = new Histogram({
    name: "flowmind_loop_duration_seconds",
    help: "FOR_EACH duration by outcome and mode.",
    labelNames: ["outcome", "mode"],
    buckets: STEP_BUCKETS,
    registers: [this.registry]
  });
  readonly tryExecutions = new Counter({ name: "flowmind_try_executions_total", help: "TRY_CATCH executions by outcome and error category.", labelNames: ["outcome", "error_category"], registers: [this.registry] });
  readonly tryCaughtErrors = new Counter({ name: "flowmind_try_caught_errors_total", help: "Errors caught by TRY_CATCH.", labelNames: ["error_category"], registers: [this.registry] });
  readonly tryHandledErrors = new Counter({ name: "flowmind_try_handled_errors_total", help: "Errors handled by TRY_CATCH.", labelNames: ["error_category"], registers: [this.registry] });
  readonly tryUnhandledErrors = new Counter({ name: "flowmind_try_unhandled_errors_total", help: "Errors left unhandled by TRY_CATCH.", labelNames: ["error_category"], registers: [this.registry] });
  readonly tryFinallyFailures = new Counter({ name: "flowmind_try_finally_failures_total", help: "TRY_CATCH Finally failures.", labelNames: ["error_category"], registers: [this.registry] });
  readonly tryDuration = new Histogram({ name: "flowmind_try_duration_seconds", help: "TRY_CATCH duration by outcome and error category.", labelNames: ["outcome", "error_category"], buckets: STEP_BUCKETS, registers: [this.registry] });
  readonly subworkflowExecutions = new Counter({ name: "flowmind_subworkflow_executions_total", help: "Subworkflow executions by outcome and version policy.", labelNames: ["outcome", "version_policy"], registers: [this.registry] });
  readonly subworkflowDuration = new Histogram({ name: "flowmind_subworkflow_duration_seconds", help: "Subworkflow duration by outcome and version policy.", labelNames: ["outcome", "version_policy"], buckets: STEP_BUCKETS, registers: [this.registry] });
  readonly subworkflowDepthExceeded = new Counter({ name: "flowmind_subworkflow_depth_exceeded_total", help: "Subworkflow depth limit violations.", registers: [this.registry] });

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
  recordApproval(outcome: string, assigneePolicy: string, latencySeconds?: number) {
    const labels = { outcome, assignee_policy: assigneePolicy.toLowerCase() };
    this.approvalOutcomes.inc(labels);
    if (latencySeconds !== undefined) this.approvalLatency.observe(labels, latencySeconds);
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

  recordLoopExecution(outcome: "completed" | "failed", mode: "sequential", durationSeconds: number) {
    this.loopExecutions.inc({ outcome, mode });
    this.loopDuration.observe({ outcome, mode }, Math.max(0, durationSeconds));
  }

  recordLoopIteration(outcome: "success" | "failed", mode: "sequential") {
    this.loopIterations.inc({ outcome, mode });
    if (outcome === "failed") this.loopIterationFailures.inc({ mode });
  }

  recordTryExecution(outcome: "succeeded" | "handled" | "failed", category: string, durationSeconds: number) {
    const error_category = safeReason(category);
    this.tryExecutions.inc({ outcome, error_category });
    this.tryDuration.observe({ outcome, error_category }, Math.max(0, durationSeconds));
    if (outcome !== "succeeded") this.tryCaughtErrors.inc({ error_category });
    if (outcome === "handled") this.tryHandledErrors.inc({ error_category });
    if (outcome === "failed") this.tryUnhandledErrors.inc({ error_category });
  }

  recordTryFinallyFailure(category: string) { this.tryFinallyFailures.inc({ error_category: safeReason(category) }); }

  recordSubworkflow(outcome: string, policy: string, durationSeconds = 0) { const labels = { outcome: safeReason(outcome), version_policy: policy === "PINNED_VERSION" ? "pinned_version" : "published" }; this.subworkflowExecutions.inc(labels); this.subworkflowDuration.observe(labels, Math.max(0, durationSeconds)); }
  recordSubworkflowDepthExceeded() { this.subworkflowDepthExceeded.inc(); }

  recordTransform(mode: string | undefined, outcome: TransformOutcome, durationSeconds: number, category?: string) {
    const safeMode = safeTransformMode(mode);
    this.transformExecutions.inc({ mode: safeMode, outcome });
    this.transformDuration.observe({ mode: safeMode, outcome }, durationSeconds);
    if (outcome === "failure") {
      const safeCategory = safeReason((category ?? "unknown").toLowerCase());
      this.transformFailures.inc({ mode: safeMode, category: safeCategory });
      if (safeCategory === "limit_exceeded") this.transformLimitExceeded.inc({ mode: safeMode });
    }
  }

  recordDataStore(operation: string, outcome: string, durationSeconds: number, errorCategory?: string) {
    const safeOperation = safeReason(operation);
    const safeOutcome = safeReason(outcome);
    this.dataStoreOperations.inc({ operation: safeOperation, outcome: safeOutcome });
    this.dataStoreLatency.observe({ operation: safeOperation, outcome: safeOutcome }, Math.max(0, durationSeconds));
    if (errorCategory) this.dataStoreErrors.inc({ operation: safeOperation, error_category: safeReason(errorCategory) });
  }

  recordVariable(operation: string, outcome: string, durationSeconds: number, errorCategory?: string) {
    const safeOperation = safeVariableOperation(operation);
    const safeOutcome = safeReason(outcome);
    this.variableOperations.inc({ operation: safeOperation, outcome: safeOutcome });
    this.variableLatency.observe({ operation: safeOperation, outcome: safeOutcome }, Math.max(0, durationSeconds));
    if (errorCategory) this.variableErrors.inc({ operation: safeOperation, error_category: safeReason(errorCategory) });
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

function safeTransformMode(value: string | undefined) {
  return ["OBJECT", "PICK", "OMIT", "MAP_ARRAY", "FILTER_ARRAY", "MERGE"].includes(value ?? "") ? String(value).toLowerCase() : "unknown";
}

function safeVariableOperation(value: string) {
  const operation = value.toLowerCase();
  return ["set", "get", "delete", "increment", "append"].includes(operation) ? operation : "unknown";
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
