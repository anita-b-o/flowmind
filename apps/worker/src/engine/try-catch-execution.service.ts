import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { StepExecutionStatus, type ExecutionContext, type SafeStepError, type TryCatchOutput, type WorkflowStepDefinition } from "@automation/shared-types";
import { sanitizeForLog } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ForEachExecutionService, type ForEachStepRow } from "./for-each-execution.service";
import { isDone, selectedNextStepKey } from "./graph/graph-planner";
import type { RuntimeGraph } from "./graph/graph-validator";
import { StepExecutor, type StepExecutionRecord } from "./step-executor";
import { StructuredStepFailure } from "./structured-step-failure";
import { ExecuteWorkflowExecutionService } from "./execute-workflow-execution.service";
import { recordStepAttempt } from "./step-attempt-recorder";

type RegionResult = { outcome: "completed" } | { outcome: "waiting"; nextRetryAt: Date | null; waitReason?: string };
type Region = { name: "body" | "catch" | "finally"; entry: string; exit: string; keys: Set<string> };

@Injectable()
export class TryCatchExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor,
    @Inject(forwardRef(() => ForEachExecutionService)) private readonly forEach: ForEachExecutionService,
    private readonly metrics?: WorkerMetricsService,
    private readonly executeWorkflow?: ExecuteWorkflowExecutionService
  ) {}

  async execute(input: {
    organizationId: string; executionId: string; correlationId?: string | null;
    tryStep: WorkflowStepDefinition; tryStepExecution: StepExecutionRecord & { inputJson?: unknown; startedAt?: Date | null };
    graph: RuntimeGraph; stepRowsByKey: Map<string, ForEachStepRow>; runtimeContext: ExecutionRuntimeContext;
    parentContext: ExecutionContext; parentPath: string; iterationIndex?: number | null;
  }): Promise<{ outcome: "completed"; output: TryCatchOutput } | { outcome: "waiting"; nextRetryAt: Date | null; waitReason?: string }> {
    const edges = input.graph.edges.filter((edge) => edge.from === input.tryStep.key);
    const bodyEntry = edges.find((edge) => edge.kind === "try_body")!.to;
    const catchEntry = edges.find((edge) => edge.kind === "try_catch")!.to;
    const finallyEntry = edges.find((edge) => edge.kind === "try_finally")?.to;
    const done = edges.find((edge) => edge.kind === "try_done")!.to;
    const boundary = finallyEntry ?? done;
    const state = readState(input.tryStepExecution.inputJson) ?? { phase: "body", startedAt: new Date().toISOString(), bodyStatus: "not_run", catchStatus: "not_run", finallyStatus: "not_run", audit: {} };
    if (!readState(input.tryStepExecution.inputJson)) {
      await this.prisma.stepExecution.update({ where: { id: input.tryStepExecution.id }, data: { status: StepExecutionStatus.Running, startedAt: new Date(state.startedAt), attempt: 1, attemptCount: 1, effectStatus: "running", inputJson: json({ tryState: state }) } });
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.tryStepExecution.id, attempt: 1, status: StepExecutionStatus.Running, startedAt: new Date(state.startedAt), effectStatus: "running" });
      await this.audit(input, "try.started", { outcome: "started", handled: false });
    }
    let primary: StructuredStepFailure | undefined = state.primary ? new StructuredStepFailure(state.primary.error, state.primary.id) : undefined;
    try {
      if (state.phase === "body") {
        try {
          const result = await this.runRegion(input, { name: "body", entry: state.currentStepKey ?? bodyEntry, exit: boundary, keys: regionKeys(input.graph, bodyEntry, boundary) }, input.parentContext, state);
          if (result.outcome === "waiting") return result;
          state.bodyStatus = "succeeded"; state.phase = finallyEntry ? "finally" : "complete"; state.currentStepKey = undefined;
        } catch (error) {
          primary = await this.asFailure(input, error);
          state.primary = { id: primary.stepExecutionId, error: primary.safeError };
          state.bodyStatus = "failed"; state.phase = "catch"; state.currentStepKey = undefined;
          await this.audit(input, "try.body_failed", { outcome: "failed", category: primary.safeError.category, handled: false });
        }
        await this.checkpoint(input, state);
      }
      if (state.phase === "catch") {
        const errorFrame = input.runtimeContext.createErrorFrame(input.parentContext, primary!.safeError, {});
        try {
          const result = await this.runRegion(input, { name: "catch", entry: state.currentStepKey ?? catchEntry, exit: boundary, keys: regionKeys(input.graph, catchEntry, boundary) }, errorFrame, state);
          if (result.outcome === "waiting") return result;
          state.catchStatus = "succeeded"; state.handled = true; state.phase = finallyEntry ? "finally" : "complete"; state.currentStepKey = undefined;
          await this.prisma.stepExecution.update({ where: { id: primary!.stepExecutionId }, data: { errorHandled: true } });
          await this.audit(input, "try.handled", { outcome: "handled", category: primary!.safeError.category, handled: true });
        } catch (error) {
          primary = await this.asFailure(input, error);
          state.primary = { id: primary.stepExecutionId, error: primary.safeError };
          state.catchStatus = "failed"; state.phase = finallyEntry ? "finally" : "failed"; state.currentStepKey = undefined;
        }
        await this.checkpoint(input, state);
      }
      if (state.phase === "finally" && finallyEntry) {
        try {
          const result = await this.runRegion(input, { name: "finally", entry: state.currentStepKey ?? finallyEntry, exit: done, keys: regionKeys(input.graph, finallyEntry, done) }, input.parentContext, state);
          if (result.outcome === "waiting") return result;
          state.finallyStatus = "succeeded"; state.phase = primary && !state.handled ? "failed" : "complete"; state.currentStepKey = undefined;
        } catch (error) {
          const finalFailure = await this.asFailure(input, error);
          state.finallyStatus = "failed"; state.secondary = primary ? finalFailure.safeError : undefined; primary ??= finalFailure;
          state.primary ??= { id: primary.stepExecutionId, error: primary.safeError };
          state.phase = "failed"; state.currentStepKey = undefined;
          this.metrics?.recordTryFinallyFailure(primary.safeError.category);
        }
        await this.checkpoint(input, state);
      }
      if (state.phase === "failed") throw primary!;
      const output = summary(state);
      const completedAt = new Date();
      await this.prisma.stepExecution.update({ where: { id: input.tryStepExecution.id }, data: { status: StepExecutionStatus.Completed, outputJson: json(output), errorJson: Prisma.JsonNull, debugJson: json({ try: output }), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "succeeded" } });
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.tryStepExecution.id, attempt: 1, status: StepExecutionStatus.Completed, startedAt: new Date(state.startedAt), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "succeeded" });
      await this.audit(input, "try.completed", { outcome: output.status, category: output.errorCategory, handled: output.errorHandled });
      this.metrics?.recordTryExecution(output.status, output.errorCategory ?? "none", (completedAt.getTime() - Date.parse(state.startedAt)) / 1000);
      return { outcome: "completed", output };
    } catch (error) {
      const failure = error instanceof StructuredStepFailure ? error : await this.asFailure(input, error);
      const output = { ...summary(state), status: "failed" as const };
      const completedAt = new Date();
      await this.prisma.stepExecution.update({ where: { id: input.tryStepExecution.id }, data: { status: StepExecutionStatus.Failed, outputJson: json(output), errorJson: json({ message: failure.safeError.message, classification: failure.safeError.category, code: failure.safeError.code, secondary: state.secondary }), debugJson: json({ try: output, secondaryError: state.secondary }), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "failed" } });
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.tryStepExecution.id, attempt: 1, status: StepExecutionStatus.Failed, startedAt: new Date(state.startedAt), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "failed", errorCategory: failure.safeError.category, errorCodeSafe: failure.safeError.code, errorMessageSafe: failure.safeError.message });
      await this.audit(input, "try.failed", { outcome: "failed", category: failure.safeError.category, handled: false });
      this.metrics?.recordTryExecution("failed", failure.safeError.category, (completedAt.getTime() - Date.parse(state.startedAt)) / 1000);
      throw failure;
    }
  }

  private async runRegion(input: Parameters<TryCatchExecutionService["execute"]>[0], region: Region, context: ExecutionContext, state: any): Promise<RegionResult> {
    const executionPath = `${input.parentPath}/try[${input.tryStep.key}]/${region.name}`;
    const persisted = await this.prisma.stepExecution.findMany({ where: { executionId: input.executionId, executionPath }, orderBy: { createdAt: "asc" } });
    context.steps = Object.fromEntries(persisted.filter((row) => isDone(row.status)).map((row) => [row.stepKey, { status: row.status as StepExecutionStatus, output: row.outputJson }]));
    let next = state.currentStepKey ?? region.entry;
    while (next !== region.exit) {
      if (!region.keys.has(next)) throw new Error(`TRY_CATCH ${region.name} escaped to ${next}`);
      const row = input.stepRowsByKey.get(next); if (!row) throw new Error(`Missing step ${next}`);
      const step = toStep(row);
      let execution = await this.stepExecutor.ensure({ organizationId: input.organizationId, executionId: input.executionId, workflowStepId: row.id, step, executionPath, iterationIndex: input.iterationIndex });
      if (step.type === "for_each") {
        const body = input.graph.edges.find((edge) => edge.from === step.key && edge.kind === "for_each_body")!, done = input.graph.edges.find((edge) => edge.from === step.key && edge.kind === "for_each_done")!;
        if (execution.status === StepExecutionStatus.Completed) { context.steps[step.key] = { status: StepExecutionStatus.Completed, output: execution.outputJson }; next = done.to; continue; }
        const result = await this.forEach.execute({ organizationId: input.organizationId, executionId: input.executionId, correlationId: input.correlationId, loopStep: step, loopStepExecution: execution as any, graph: input.graph, bodyEntryStepKey: body.to, doneStepKey: done.to, bodyStepKeys: regionKeys(input.graph, body.to, done.to), stepRowsByKey: input.stepRowsByKey, runtimeContext: input.runtimeContext, parentContext: context, parentPath: executionPath });
        if (result.outcome === "waiting") { state.currentStepKey = next; await this.checkpoint(input, state); return result; }
        context.steps[step.key] = { status: StepExecutionStatus.Completed, output: result.output }; next = done.to; continue;
      }
      if (step.type === "execute_workflow") {
        if (!this.executeWorkflow) throw new Error("EXECUTE_WORKFLOW runtime service is unavailable");
        try {
          const result = await this.executeWorkflow.execute({ organizationId: input.organizationId, executionId: input.executionId, correlationId: input.correlationId, step, stepExecution: execution as any, context, executionPath, iterationIndex: input.iterationIndex });
          if (result.outcome === "waiting") { state.currentStepKey = next; await this.checkpoint(input, state); return result; }
          context.steps[step.key] = { status: StepExecutionStatus.Completed, output: result.output };
          next = selectedNextStepKey(input.graph, step.key, result.output) ?? region.exit;
          state.currentStepKey = next === region.exit ? undefined : next; await this.checkpoint(input, state); continue;
        } catch (error) { throw await this.asFailure(input, error, execution.id); }
      }
      if (execution.status === StepExecutionStatus.Retrying && execution.nextRetryAt && execution.nextRetryAt > new Date()) { state.currentStepKey = next; await this.checkpoint(input, state); return { outcome: "waiting", nextRetryAt: execution.nextRetryAt }; }
      if (execution.status === StepExecutionStatus.Retrying && isIntentionalWait(execution)) {
        const resumed = await this.stepExecutor.completeWait({ step, stepExecution: execution });
        context.steps[step.key] = { status: resumed.result.status, output: resumed.result.output };
        execution = { ...execution, status: resumed.result.status, outputJson: resumed.result.output };
      }
      if (execution.status === StepExecutionStatus.Failed && execution.attemptCount >= execution.maxAttempts) throw await this.failureFromRow(execution.id);
      if (!isDone(execution.status)) {
        try {
          const result = await this.stepExecutor.execute({ organizationId: input.organizationId, executionId: input.executionId, workflowStepId: row.id, step, context, stepExecution: execution, executionPath, iterationIndex: input.iterationIndex });
          if (result.outcome === "retrying" || result.outcome === "durable_wait") { state.currentStepKey = next; await this.checkpoint(input, state); return { outcome: "waiting", nextRetryAt: result.nextRetryAt, waitReason: result.waitReason }; }
          context.steps[step.key] = { status: result.result.status, output: result.result.output };
          next = selectedNextStepKey(input.graph, step.key, result.result.output) ?? region.exit;
        } catch (error) { throw await this.asFailure(input, error, execution.id); }
      } else next = selectedNextStepKey(input.graph, step.key, execution.outputJson) ?? region.exit;
      state.currentStepKey = next === region.exit ? undefined : next; await this.checkpoint(input, state);
    }
    return { outcome: "completed" };
  }

  private checkpoint(input: Parameters<TryCatchExecutionService["execute"]>[0], state: any) { return this.prisma.stepExecution.update({ where: { id: input.tryStepExecution.id }, data: { inputJson: json({ tryState: state }), outputJson: json(summary(state)) } }); }
  private async asFailure(input: Parameters<TryCatchExecutionService["execute"]>[0], error: unknown, id?: string) { if (error instanceof StructuredStepFailure) return error; if (id) return this.failureFromRow(id, error); const row = await this.prisma.stepExecution.findFirst({ where: { executionId: input.executionId, status: StepExecutionStatus.Failed, errorHandled: false }, orderBy: { updatedAt: "desc" } }); if (!row) throw error; return this.failureFromRow(row.id, error); }
  private async failureFromRow(id: string, cause?: unknown) { const row = await this.prisma.stepExecution.findUniqueOrThrow({ where: { id } }); const e = record(row.errorJson); const category = String(e.classification ?? "unknown"); const safe: SafeStepError = { message: safeMessage(e.message), category, ...(typeof e.code === "string" ? { code: e.code.slice(0, 100) } : {}), stepKey: row.stepKey, executionPath: row.executionPath, retryable: category === "retryable", attempts: row.attemptCount }; return new StructuredStepFailure(safe, row.id, cause); }
  private audit(input: Parameters<TryCatchExecutionService["execute"]>[0], action: string, metadata: Record<string, unknown>) { return this.prisma.auditLog.create({ data: { organizationId: input.organizationId, actorUserId: null, action, resourceType: "StepExecution", resourceId: input.tryStepExecution.id, correlationId: input.correlationId ?? null, metadataJson: json(sanitizeForLog(metadata)) } }).catch(() => undefined); }
}

function regionKeys(graph: RuntimeGraph, start: string, stop: string) { const seen = new Set<string>(); const visit = (key: string) => { if (key === stop || seen.has(key)) return; seen.add(key); for (const edge of graph.edges.filter((e) => e.from === key)) visit(edge.to); }; visit(start); return seen; }
function readState(value: unknown): any { const state = record(record(value).tryState); return typeof state.phase === "string" ? state : undefined; }
function summary(state: any): TryCatchOutput { return { status: state.phase === "failed" ? "failed" : state.handled ? "handled" : "succeeded", bodyStatus: state.bodyStatus, catchStatus: state.catchStatus, finallyStatus: state.finallyStatus, errorHandled: state.handled === true, ...(state.primary?.error?.stepKey ? { failedStepKey: state.primary.error.stepKey } : {}), ...(state.primary?.error?.category ? { errorCategory: state.primary.error.category } : {}) }; }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function toStep(row: ForEachStepRow): WorkflowStepDefinition { return { id: row.id ?? undefined, key: row.key, name: row.name, type: row.type as any, position: row.position, config: record(row.configJson), retryPolicy: row.retryPolicyJson as any, timeoutSeconds: row.timeoutSeconds ?? undefined }; }
function isIntentionalWait(step: { effectStatus?: string | null; outputJson?: unknown }) { return step.effectStatus !== "approval_waiting" && (["delay", "wait_until", "waiting"].includes(step.effectStatus ?? "") || Boolean(step.outputJson && typeof step.outputJson === "object" && "waitReason" in step.outputJson)); }
function safeMessage(value: unknown) { return String(value ?? "Step failed").replace(/(authorization|cookie|password|token|api[-_ ]?key|secret|connection(?:string)?|smtp)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]").replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|smtp):\/\/[^\s]+/gi, "[REDACTED_CONNECTION]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").slice(0, 500); }
