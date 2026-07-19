import { forwardRef, Inject, Injectable, Optional } from "@nestjs/common";
import {
  FOR_EACH_LIMITS,
  StepExecutionStatus,
  type ForEachErrorSummary,
  type ForEachOutput,
  type WorkflowStepDefinition
} from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ExpressionResolver } from "./expression-resolver";
import { branchSkipKeys, isDone, selectedNextStepKey } from "./graph/graph-planner";
import type { RuntimeGraph } from "./graph/graph-validator";
import { StepExecutor, type StepExecutionRecord } from "./step-executor";
import { NonRetryableStepError } from "./step-errors";
import { TryCatchExecutionService } from "./try-catch-execution.service";
import { ExecuteWorkflowExecutionService } from "./execute-workflow-execution.service";
import { recordStepAttempt } from "./step-attempt-recorder";

export type ForEachStepRow = {
  id?: string | null;
  key: string;
  name: string;
  type: string;
  position: number;
  configJson: unknown;
  retryPolicyJson: unknown;
  timeoutSeconds: number | null;
};

type LoopState = {
  items: unknown[];
  nextIndex: number;
  currentStepKey?: string;
  succeeded: number;
  failed: number;
  skipped: number;
  results: unknown[];
  errors: ForEachErrorSummary[];
  resultsTruncated: boolean;
  errorsTruncated: boolean;
  startedAt: string;
};

export type ForEachRunResult = { outcome: "completed"; output: ForEachOutput } | { outcome: "waiting"; nextRetryAt: Date | null; waitReason?: string };

@Injectable()
export class ForEachExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor,
    private readonly expressionResolver: ExpressionResolver,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService,
    @Optional() @Inject(forwardRef(() => TryCatchExecutionService)) private readonly tryCatch?: TryCatchExecutionService,
    private readonly executeWorkflow?: ExecuteWorkflowExecutionService
  ) {}

  async execute(input: {
    organizationId: string;
    executionId: string;
    correlationId?: string | null;
    loopStep: WorkflowStepDefinition;
    loopStepExecution: StepExecutionRecord & { inputJson?: unknown; status: string; startedAt?: Date | null };
    graph: RuntimeGraph;
    bodyEntryStepKey: string;
    doneStepKey: string;
    bodyStepKeys: Set<string>;
    stepRowsByKey: Map<string, ForEachStepRow>;
    runtimeContext: ExecutionRuntimeContext;
    parentContext?: import("@automation/shared-types").ExecutionContext;
    parentPath?: string;
  }): Promise<ForEachRunResult> {
    let state = readState(input.loopStepExecution.inputJson);
    const config = normalizeConfig(input.loopStep.config);
    try {
      if (!state) state = await this.start(input, config);
      while (state.nextIndex < state.items.length) {
        const iterationIndex = state.nextIndex;
        const executionPath = `${input.parentPath ?? "root"}/${input.loopStep.key}[${iterationIndex}]`;
        const persisted = await this.prisma.stepExecution.findMany({ where: { executionId: input.executionId, executionPath }, orderBy: { createdAt: "asc" } });
        const iterationSteps = Object.fromEntries(persisted.filter((row) => isDone(row.status)).map((row) => [row.stepKey, { status: row.status as StepExecutionStatus, output: row.outputJson }]));
        const frame = input.runtimeContext.createIterationFrame({
          item: state.items[iterationIndex],
          index: iterationIndex,
          itemVariable: config.itemVariable,
          indexVariable: config.indexVariable,
          steps: iterationSteps
        });
        let nextStepKey = state.currentStepKey ?? input.bodyEntryStepKey;
        let lastOutput: unknown;
        let lastStatus: StepExecutionStatus = StepExecutionStatus.Completed;
        while (nextStepKey !== input.doneStepKey) {
          if (!input.bodyStepKeys.has(nextStepKey)) throw new NonRetryableStepError(`FOR_EACH Body escaped to ${nextStepKey}`);
          const row = input.stepRowsByKey.get(nextStepKey);
          if (!row) throw new NonRetryableStepError(`FOR_EACH Body references missing step ${nextStepKey}`);
          const step = toStep(row);
          const reused = await this.reused(input.executionId, executionPath, step.key);
          if (reused) {
            frame.steps[step.key] = { status: reused.status as StepExecutionStatus, output: reused.outputJson };
            lastOutput = reused.outputJson; lastStatus = reused.status as StepExecutionStatus;
            if (step.type === "try_catch") nextStepKey = input.graph.edges.find((edge) => edge.from === step.key && edge.kind === "try_done")?.to ?? input.doneStepKey;
            else nextStepKey = selectedNextStepKey(input.graph, step.key, reused.outputJson) ?? input.doneStepKey;
            state.currentStepKey = nextStepKey === input.doneStepKey ? undefined : nextStepKey;
            await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
            continue;
          }
          let stepExecution = await this.stepExecutor.ensure({
            organizationId: input.organizationId,
            executionId: input.executionId,
            workflowStepId: row.id,
            step,
            executionPath,
            iterationIndex
          });
          if (step.type === "try_catch" || step.type === "for_each") stepExecution = await this.hydrateControl(input.executionId, stepExecution as any, step.key, executionPath) as any;
          if (step.type === "try_catch") {
            if (!this.tryCatch) throw new NonRetryableStepError("TRY_CATCH runtime service is unavailable");
            const doneEdge = input.graph.edges.find((edge) => edge.from === step.key && edge.kind === "try_done");
            if (!doneEdge) throw new NonRetryableStepError("TRY_CATCH Done connection is missing");
            if (stepExecution.status === StepExecutionStatus.Completed) { frame.steps[step.key] = { status: StepExecutionStatus.Completed, output: stepExecution.outputJson }; nextStepKey = doneEdge.to; continue; }
            const result = await this.tryCatch.execute({ organizationId: input.organizationId, executionId: input.executionId, correlationId: input.correlationId, tryStep: step, tryStepExecution: stepExecution as any, graph: input.graph, stepRowsByKey: input.stepRowsByKey, runtimeContext: input.runtimeContext, parentContext: frame, parentPath: executionPath, iterationIndex });
            if (result.outcome === "waiting") { state.currentStepKey = nextStepKey; await this.checkpoint(input.loopStepExecution.id, state, summary(state, config)); return result; }
            frame.steps[step.key] = { status: StepExecutionStatus.Completed, output: result.output };
            const selected = doneEdge.to;
            if (!selected) throw new NonRetryableStepError(`FOR_EACH Body cannot resolve next step after ${step.key}`);
            nextStepKey = selected;
            state.currentStepKey = nextStepKey === input.doneStepKey ? undefined : nextStepKey;
            await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
            continue;
          }
          if (step.type === "execute_workflow") {
            if (!this.executeWorkflow) throw new NonRetryableStepError("EXECUTE_WORKFLOW runtime service is unavailable");
            const result = await this.executeWorkflow.execute({ organizationId: input.organizationId, executionId: input.executionId, correlationId: input.correlationId, step, stepExecution: stepExecution as any, context: frame, executionPath, iterationIndex });
            if (result.outcome === "waiting") { state.currentStepKey = nextStepKey; await this.checkpoint(input.loopStepExecution.id, state, summary(state, config)); return result; }
            frame.steps[step.key] = { status: StepExecutionStatus.Completed, output: result.output };
            lastOutput = result.output; lastStatus = StepExecutionStatus.Completed;
            nextStepKey = selectedNextStepKey(input.graph, step.key, result.output) ?? input.doneStepKey;
            state.currentStepKey = nextStepKey === input.doneStepKey ? undefined : nextStepKey;
            await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
            continue;
          }
          if (stepExecution.status === StepExecutionStatus.Retrying && stepExecution.nextRetryAt && stepExecution.nextRetryAt > new Date()) {
            state.currentStepKey = nextStepKey;
            await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
            return { outcome: "waiting", nextRetryAt: stepExecution.nextRetryAt };
          }
          if (stepExecution.status === StepExecutionStatus.Retrying && isIntentionalWait(stepExecution)) {
            const resumed = await this.stepExecutor.completeWait({ step, stepExecution });
            frame.steps[step.key] = { status: resumed.result.status, output: resumed.result.output };
            stepExecution = { ...stepExecution, status: resumed.result.status, outputJson: resumed.result.output };
          }
          if (stepExecution.status === StepExecutionStatus.Failed && stepExecution.attemptCount >= stepExecution.maxAttempts) {
            await this.handleIterationFailure(input, config, state, iterationIndex, step.key, stepExecution);
            if (!config.continueOnError) throw new Error(`Step ${step.key} failed after ${stepExecution.attemptCount} attempts`);
            nextStepKey = input.doneStepKey;
            lastStatus = StepExecutionStatus.Failed;
            break;
          }
          let output: unknown = stepExecution.outputJson;
          let status = stepExecution.status as StepExecutionStatus;
          if (!isDone(status)) {
            try {
              const outcome = await this.stepExecutor.execute({
                organizationId: input.organizationId,
                executionId: input.executionId,
                workflowStepId: row.id,
                step,
                context: frame,
                stepExecution,
                executionPath,
                iterationIndex
              });
              if (outcome.outcome === "retrying" || outcome.outcome === "durable_wait") {
                state.currentStepKey = nextStepKey;
                await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
                return { outcome: "waiting", nextRetryAt: outcome.nextRetryAt, waitReason: outcome.waitReason };
              }
              output = outcome.result.output;
              status = outcome.result.status;
              frame.steps[step.key] = { status, output };
            } catch (error) {
              const failed = await this.prisma.stepExecution.findUniqueOrThrow({ where: { id: stepExecution.id } });
              await this.handleIterationFailure(input, config, state, iterationIndex, step.key, failed);
              if (!config.continueOnError) throw error;
              nextStepKey = input.doneStepKey;
              lastStatus = StepExecutionStatus.Failed;
              break;
            }
          }
          lastOutput = output;
          lastStatus = status;
          const selected = selectedNextStepKey(input.graph, step.key, output);
          if (!selected) throw new NonRetryableStepError(`FOR_EACH Body cannot resolve next step after ${step.key}`);
          if ((step.type === "if" || step.type === "switch") && selected !== input.doneStepKey) {
            await this.skipUnselected(input, executionPath, iterationIndex, step.key, selected, frame);
          }
          nextStepKey = selected;
          state.currentStepKey = nextStepKey === input.doneStepKey ? undefined : nextStepKey;
          await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
        }
        if (lastStatus !== StepExecutionStatus.Failed) {
          if (lastStatus === StepExecutionStatus.Skipped) state.skipped += 1;
          else state.succeeded += 1;
          if (config.collectResults) {
            if (state.results.length < config.maxResults) state.results.push(limitPreview(lastOutput));
            else state.resultsTruncated = true;
          }
          this.metrics?.recordLoopIteration("success", "sequential");
        }
        state.nextIndex += 1;
        state.currentStepKey = undefined;
        await this.checkpoint(input.loopStepExecution.id, state, summary(state, config));
      }
      const output = summary(state, config);
      const completedAt = new Date();
      await this.prisma.stepExecution.update({ where: { id: input.loopStepExecution.id }, data: { status: StepExecutionStatus.Completed, outputJson: json(output), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "succeeded" } });
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.loopStepExecution.id, attempt: 1, status: StepExecutionStatus.Completed, startedAt: new Date(state.startedAt), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "succeeded" });
      await this.audit(input, "loop.completed", output);
      this.metrics?.recordLoopExecution("completed", "sequential", Math.max(0, (completedAt.getTime() - Date.parse(state.startedAt)) / 1000));
      this.logger?.info("worker.loop.completed", { stepExecutionId: input.loopStepExecution.id, total: output.total, succeeded: output.succeeded, failed: output.failed, mode: output.mode });
      return { outcome: "completed", output };
    } catch (error) {
      state ??= { items: [], nextIndex: 0, succeeded: 0, failed: 0, skipped: 0, results: [], errors: [], resultsTruncated: false, errorsTruncated: false, startedAt: new Date().toISOString() };
      const output = summary(state, config);
      const completedAt = new Date();
      await this.prisma.stepExecution.update({ where: { id: input.loopStepExecution.id }, data: { status: StepExecutionStatus.Failed, outputJson: json(output), errorJson: json({ message: error instanceof Error ? error.message : String(error), classification: "non_retryable" }), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "failed" } }).catch(() => undefined);
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.loopStepExecution.id, attempt: 1, status: StepExecutionStatus.Failed, startedAt: new Date(state.startedAt), completedAt, durationMs: completedAt.getTime() - Date.parse(state.startedAt), effectStatus: "failed", errorCategory: "non_retryable", errorCodeSafe: "STEP_FAILED", errorMessageSafe: "The loop failed and will not be retried." }).catch(() => undefined);
      await this.audit(input, "loop.failed", output);
      this.metrics?.recordLoopExecution("failed", "sequential", Math.max(0, (completedAt.getTime() - Date.parse(state.startedAt)) / 1000));
      throw error;
    }
  }

  private async start(input: Parameters<ForEachExecutionService["execute"]>[0], config: ReturnType<typeof normalizeConfig>) {
    const mode = input.runtimeContext.context.metadata?.expressionMode === "strict" ? "strict" : "legacy";
    const source = this.expressionResolver.resolveValue(config.source, input.runtimeContext.context, { mode });
    if (!Array.isArray(source)) throw new NonRetryableStepError("FOR_EACH Source must resolve to an array");
    if (source.length > config.maxItems || source.length > FOR_EACH_LIMITS.maxItems) throw new NonRetryableStepError("FOR_EACH Source exceeds maxItems");
    if (Buffer.byteLength(JSON.stringify(source), "utf8") > FOR_EACH_LIMITS.maxSourceBytes) throw new NonRetryableStepError("FOR_EACH Source snapshot exceeds the size limit");
    const now = new Date();
    const state: LoopState = { items: source, nextIndex: 0, succeeded: 0, failed: 0, skipped: 0, results: [], errors: [], resultsTruncated: false, errorsTruncated: false, startedAt: now.toISOString() };
    await this.prisma.stepExecution.update({ where: { id: input.loopStepExecution.id }, data: { status: StepExecutionStatus.Running, startedAt: now, inputJson: json({ forEachState: state }), outputJson: json(summary(state, config)), attempt: 1, attemptCount: 1, effectStatus: "running" } });
    await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.loopStepExecution.id, attempt: 1, status: StepExecutionStatus.Running, startedAt: now, effectStatus: "running" });
    await this.audit(input, "loop.started", summary(state, config));
    this.logger?.info("worker.loop.started", { stepExecutionId: input.loopStepExecution.id, total: source.length, mode: config.mode });
    return state;
  }

  private async handleIterationFailure(input: Parameters<ForEachExecutionService["execute"]>[0], config: ReturnType<typeof normalizeConfig>, state: LoopState, iterationIndex: number, stepKey: string, failed: { id: string; errorJson?: unknown }) {
    state.failed += 1;
    const error = errorRecord(failed.errorJson);
    if (state.errors.length < FOR_EACH_LIMITS.maxErrors) state.errors.push({ iterationIndex, stepKey, code: typeof error.code === "string" ? error.code : undefined, message: String(error.message ?? "Iteration failed").slice(0, 500) });
    else state.errorsTruncated = true;
    if (config.continueOnError) await this.prisma.stepExecution.update({ where: { id: failed.id }, data: { errorHandled: true } });
    this.metrics?.recordLoopIteration("failed", "sequential");
  }

  private async skipUnselected(input: Parameters<ForEachExecutionService["execute"]>[0], executionPath: string, iterationIndex: number, controlStepKey: string, selectedStepKey: string, frame: ReturnType<ExecutionRuntimeContext["createIterationFrame"]>) {
    for (const key of branchSkipKeys(input.graph, controlStepKey, selectedStepKey).filter((candidate) => input.bodyStepKeys.has(candidate))) {
      const row = input.stepRowsByKey.get(key);
      if (!row) continue;
      const step = toStep(row);
      const execution = await this.stepExecutor.ensure({ organizationId: input.organizationId, executionId: input.executionId, workflowStepId: row.id, step, executionPath, iterationIndex });
      if (isDone(execution.status)) continue;
      const skipped = await this.stepExecutor.skip({ organizationId: input.organizationId, executionId: input.executionId, workflowStepId: row.id, step, stepExecution: execution, reason: "branch_not_selected" });
      frame.steps[key] = { status: skipped.result.status, output: skipped.result.output };
    }
  }

  private checkpoint(stepExecutionId: string, state: LoopState, output: ForEachOutput) {
    return this.prisma.stepExecution.update({ where: { id: stepExecutionId }, data: { inputJson: json({ forEachState: state }), outputJson: json(output), debugJson: json({ loop: { ...output, currentIteration: state.nextIndex, results: undefined, errors: output.errors?.slice(0, 5) } }) } });
  }

  private async reused(executionId: string, executionPath: string, stepKey: string) {
    if (!(this.prisma as any).executionStepReuse) return null;
    const reuse = await this.prisma.executionStepReuse.findUnique({ where: { recoveryExecutionId_stepKey_executionPath: { recoveryExecutionId: executionId, stepKey, executionPath } }, include: { sourceStepExecution: true } });
    return reuse ? { ...reuse.sourceStepExecution, status: reuse.status } : null;
  }
  private async hydrateControl(executionId: string, target: any, stepKey: string, executionPath: string) {
    const recovery = await this.prisma.execution.findUnique({ where: { id: executionId }, select: { replayOfExecutionId: true, replayFromStepKey: true, replayFromExecutionPath: true } });
    if (!recovery?.replayOfExecutionId || target.inputJson && Object.keys(target.inputJson).length) return target;
    const source = await this.prisma.stepExecution.findFirst({ where: { executionId: recovery.replayOfExecutionId, stepKey, executionPath }, select: { inputJson: true } });
    if (!source?.inputJson) return target;
    const value: any = JSON.parse(JSON.stringify(source.inputJson));
    if (value.tryState && recovery.replayFromExecutionPath?.includes(`/try[${stepKey}]/`)) { const region = recovery.replayFromExecutionPath.split(`/try[${stepKey}]/`)[1]?.split("/")[0]; value.tryState.phase = region; value.tryState.currentStepKey = recovery.replayFromStepKey; if (region === "catch" && value.tryState.originalPrimary) value.tryState.primary = value.tryState.originalPrimary; }
    return this.prisma.stepExecution.update({ where: { id: target.id }, data: { inputJson: value } });
  }

  private audit(input: Parameters<ForEachExecutionService["execute"]>[0], action: string, output: ForEachOutput) {
    return this.prisma.auditLog.create({ data: { organizationId: input.organizationId, actorUserId: null, action, resourceType: "StepExecution", resourceId: input.loopStepExecution.id, correlationId: input.correlationId ?? null, metadataJson: json({ total: output.total, succeeded: output.succeeded, failed: output.failed, skipped: output.skipped, mode: output.mode }) } }).catch(() => undefined);
  }
}

function normalizeConfig(config: Record<string, unknown>) {
  return {
    source: config.source,
    itemVariable: optionalString(config.itemVariable),
    indexVariable: optionalString(config.indexVariable),
    mode: "SEQUENTIAL" as const,
    continueOnError: config.continueOnError === true,
    maxItems: integer(config.maxItems, FOR_EACH_LIMITS.defaultMaxItems),
    collectResults: config.collectResults !== false,
    maxResults: integer(config.maxResults, FOR_EACH_LIMITS.defaultMaxResults)
  };
}

function summary(state: LoopState, config: ReturnType<typeof normalizeConfig>): ForEachOutput {
  return { total: state.items.length, succeeded: state.succeeded, failed: state.failed, skipped: state.skipped, mode: config.mode, ...(config.collectResults ? { results: state.results, resultsTruncated: state.resultsTruncated } : {}), ...(state.errors.length ? { errors: state.errors, errorsTruncated: state.errorsTruncated } : {}) };
}

function readState(input: unknown): LoopState | undefined {
  const record = errorRecord(input);
  const state = errorRecord(record.forEachState);
  return Array.isArray(state.items) && Number.isInteger(state.nextIndex) ? state as unknown as LoopState : undefined;
}

function toStep(row: ForEachStepRow): WorkflowStepDefinition {
  return { id: row.id ?? undefined, key: row.key, name: row.name, type: row.type as any, position: row.position, config: errorRecord(row.configJson), retryPolicy: row.retryPolicyJson as any, timeoutSeconds: row.timeoutSeconds ?? undefined };
}

function isIntentionalWait(step: { effectStatus?: string | null; outputJson?: unknown }) {
  if (step.effectStatus === "approval_waiting") return false;
  return ["delay", "wait_until", "waiting"].includes(step.effectStatus ?? "") || Boolean(step.outputJson && typeof step.outputJson === "object" && "waitReason" in step.outputJson);
}

function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function integer(value: unknown, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) ? parsed : fallback; }
function errorRecord(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function limitPreview(value: unknown) { const serialized = JSON.stringify(value); return serialized && serialized.length > 4096 ? { truncated: true, originalSize: serialized.length, preview: serialized.slice(0, 4096) } : value; }
