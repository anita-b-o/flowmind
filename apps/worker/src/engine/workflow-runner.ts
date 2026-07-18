import { Injectable, Optional } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ACTIVE_EXECUTION_STATUSES, ExecutionJobPayload, ExecutionStatus, StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepExecutor } from "./step-executor";
import { ContextReconstructor } from "./context-reconstructor";
import { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ExecutionLeaseService } from "./execution-lease.service";
import { LeaseLostError } from "./lease-lost.error";
import { DeadLetterService } from "../dlq/dead-letter.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { branchSkipKeys, isDone, isTerminal, selectedNextStepKey } from "./graph/graph-planner";
import { parseRuntimeGraph, validateRuntimeGraph, type RuntimeGraph } from "./graph/graph-validator";
import { ForEachExecutionService } from "./for-each-execution.service";
import { TryCatchExecutionService } from "./try-catch-execution.service";
import { ExecuteWorkflowExecutionService } from "./execute-workflow-execution.service";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "../queues/queue.constants";

export type WorkflowRunResult = { status: "completed" | "skipped" | "lost_lease" } | { status: "waiting"; nextRetryAt: Date | null; waitReason?: string };

type RuntimeStepRow = {
  id?: string | null;
  key: string;
  name: string;
  type: string;
  position: number;
  configJson: unknown;
  retryPolicyJson: unknown;
  timeoutSeconds: number | null;
};

@Injectable()
export class WorkflowRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor,
    private readonly contextReconstructor: ContextReconstructor,
    private readonly leaseService: ExecutionLeaseService,
    private readonly deadLetterService: DeadLetterService,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService,
    private readonly forEach?: ForEachExecutionService,
    private readonly tryCatch?: TryCatchExecutionService,
    private readonly executeWorkflow?: ExecuteWorkflowExecutionService,
    @Optional() @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly executionQueue?: Queue
  ) {}

  async run(payload: ExecutionJobPayload): Promise<WorkflowRunResult> {
    const acquired = await this.leaseService.acquire(payload.executionId, payload.organizationId);
    if (!acquired) {
      this.logger?.info("worker.lease.rejected");
      return { status: "skipped" };
    }
    this.logger?.info("worker.lease.acquired");
    let heartbeat: NodeJS.Timeout | undefined;
    const startHeartbeat = () => {
      heartbeat = setInterval(() => {
        void this.leaseService.heartbeat(payload.executionId).catch(() => undefined);
      }, this.leaseService.heartbeatIntervalMs());
    };
    startHeartbeat();
    const execution = await this.loadExecution(payload);
    if (!execution) {
      throw new Error(`Execution ${payload.executionId} not found`);
    }
    if ([ExecutionStatus.Completed, ExecutionStatus.Failed, ExecutionStatus.Cancelled].includes(execution.status as ExecutionStatus)) {
      await this.leaseService.release(execution.id);
      if (heartbeat) clearInterval(heartbeat);
      return { status: "completed" };
    }
    await this.prisma.execution.updateMany({
      where: { id: execution.id, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
      data: { startedAt: execution.startedAt ?? new Date(), completedAt: null }
    });

    let runtimeContext: ExecutionRuntimeContext | undefined;
    try {
      let skipNext = false;
      let current = await this.loadExecution(payload);
      if (!current) {
        throw new Error(`Execution ${payload.executionId} not found`);
      }
      const definition = runtimeDefinition(current);
      const graph = parseRuntimeGraph(definition);
      runtimeContext = await this.createRuntimeContext(current);
      if (graph) {
        return await this.runGraph(payload, execution, current, graph, runtimeContext, () => {
          if (heartbeat) clearInterval(heartbeat);
        });
      }

      for (const dbStep of runtimeStepRows(current)) {
        if (current.status === ExecutionStatus.Cancelled) {
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          return { status: "completed" };
        }
        await this.leaseService.assertOwned(current.id);
        if (dbStep.position === 0) {
          continue;
        }

        const step = toStepDefinition(dbStep);
        let stepExecution = await this.stepExecutor.ensure({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step
        });

        if (stepExecution.status === StepExecutionStatus.Completed) {
          skipNext = shouldSkipNext(step, stepExecution.outputJson);
          continue;
        }
        if (stepExecution.status === StepExecutionStatus.Skipped) {
          skipNext = false;
          continue;
        }
        if (stepExecution.status === StepExecutionStatus.Retrying && stepExecution.nextRetryAt && stepExecution.nextRetryAt > new Date()) {
          await this.markWaiting(current.id);
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: stepExecution.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: stepExecution.nextRetryAt };
        }
        if (stepExecution.status === StepExecutionStatus.Failed && stepExecution.attemptCount >= stepExecution.maxAttempts) {
          throw new Error(`Step ${step.key} failed after ${stepExecution.attemptCount} attempts`);
        }

        if (skipNext) {
          const { result } = await this.stepExecutor.skip({
            organizationId: current.organizationId,
            executionId: current.id,
            workflowStepId: dbStep.id,
            step,
            stepExecution,
            reason: "skipNextOnFalse"
          });
          runtimeContext.setStepResult(step.key, result.status, result.output);
          await this.updateContextCache(current.id, runtimeContext);
          skipNext = false;
          current = await this.reload(payload);
          continue;
        }

        const outcome = await this.stepExecutor.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step,
          context: runtimeContext.context,
          stepExecution
        });
        await this.leaseService.assertOwned(current.id);
        if (outcome.outcome === "completed") runtimeContext.setStepResult(step.key, outcome.result.status, outcome.result.output);
        await this.updateContextCache(current.id, runtimeContext);

        if (outcome.outcome === "retrying" || outcome.outcome === "durable_wait") {
          await this.markWaiting(current.id, outcome.waitReason);
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: outcome.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt, waitReason: outcome.waitReason };
        }
        skipNext = Boolean(outcome.result.control?.skipNext);
        current = await this.reload(payload);
      }

      await this.leaseService.assertOwned(execution.id);
      const context = runtimeContext.snapshot({ includeRuntime: false });
      await this.assertNoFailedSteps(execution.id);
      const completed = await this.prisma.execution.updateMany({
        where: { id: execution.id, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
        data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: toJson(context), errorJson: undefined, waitReason: null }
      });
      if (heartbeat) clearInterval(heartbeat);
      await this.leaseService.release(execution.id);
      if (completed.count !== 1) return { status: "completed" };
      this.logger?.info("worker.execution.completed", { durationMs: execution.startedAt ? Date.now() - execution.startedAt.getTime() : undefined });
      await this.recordAudit(execution.organizationId, "execution.completed", "Execution", execution.id, (execution as any).correlationId, {
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId
      });
      if ((execution as any).executionMode !== "TEST") this.metrics?.executionsCompleted.inc();
      await this.wakeParent(execution.id);
      return { status: "completed" };
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (error instanceof LeaseLostError) {
        this.logger?.warn("worker.lease.lost");
        return { status: "lost_lease" };
      }
      const latest = await this.prisma.execution.findUnique({ where: { id: execution.id }, select: { status: true } });
      if (latest?.status === ExecutionStatus.Cancelled || latest?.status === ExecutionStatus.Completed) {
        await this.leaseService.release(execution.id).catch(() => undefined);
        return { status: "completed" };
      }
      const context = runtimeContext?.snapshot({ includeRuntime: false }) ?? await this.reconstructContextForExecution(execution.id);
      const failedStep = await this.prisma.stepExecution.findFirst({
        where: { executionId: execution.id, status: StepExecutionStatus.Failed },
        orderBy: { updatedAt: "desc" }
      });
      const failed = await this.prisma.execution.updateMany({
        where: { id: execution.id, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
        data: {
          status: ExecutionStatus.Failed,
          waitReason: null,
          completedAt: new Date(),
          contextJson: toJson(context),
          errorJson: { message: error instanceof Error ? error.message : String(error) }
        }
      });
      if (failed.count !== 1) {
        await this.leaseService.release(execution.id).catch(() => undefined);
        return { status: "completed" };
      }
      if ((execution as any).executionMode !== "TEST") {
        if (!execution.workflowVersionId) {
          throw new Error(`Execution ${execution.id} is missing workflowVersionId`);
        }
        await this.deadLetterService.create({
          organizationId: execution.organizationId,
          executionId: execution.id,
          workflowId: execution.workflowId,
          workflowVersionId: execution.workflowVersionId,
          reason: deadLetterReason(failedStep?.stepType, failedStep?.effectStatus, failedStep?.errorJson),
          failedStepKey: failedStep?.stepKey,
          failedStepExecutionId: failedStep?.id,
          attempts: failedStep?.attemptCount,
          lastErrorJson: failedStep?.errorJson ?? { message: error instanceof Error ? error.message : String(error) },
          jobId: `execution-${execution.id}`
        });
      }
      await this.recordAudit(execution.organizationId, "execution.failed", "Execution", execution.id, (execution as any).correlationId, {
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
        failedStepKey: failedStep?.stepKey
      });
      await this.wakeParent(execution.id);
      this.logger?.error("worker.execution.failed", {
        failedStepKey: failedStep?.stepKey,
        stepExecutionId: failedStep?.id,
        errorCategory: (failedStep?.errorJson as any)?.classification
      });
      this.logger?.warn("worker.execution.dead_lettered", {
        failedStepKey: failedStep?.stepKey,
        stepExecutionId: failedStep?.id,
        reason: failedStep?.effectStatus === "ambiguous" ? "ambiguous" : "failed"
      });
      if ((execution as any).executionMode !== "TEST") this.metrics?.executionsFailed.inc({ error_category: (failedStep?.errorJson as any)?.classification ?? "unknown" });
      await this.leaseService.release(execution.id);
      throw error;
    }
  }

  private loadExecution(payload: ExecutionJobPayload) {
    return this.prisma.execution.findFirst({
      where: { id: payload.executionId, organizationId: payload.organizationId },
      include: {
        workflow: { include: { organization: true } },
        testRun: { select: { snapshotDefinitionJson: true } },
        workflowVersion: { include: { workflow: { include: { organization: true } }, steps: { orderBy: { position: "asc" } } } },
        steps: { orderBy: { createdAt: "asc" } }
      }
    });
  }

  private async reload(payload: ExecutionJobPayload) {
    const execution = await this.loadExecution(payload);
    if (!execution) {
      throw new Error(`Execution ${payload.executionId} not found`);
    }
    return execution;
  }

  private async runGraph(
    payload: ExecutionJobPayload,
    initialExecution: { id: string; startedAt?: Date | null; organizationId: string },
    currentExecution: Awaited<ReturnType<WorkflowRunner["loadExecution"]>> & {},
    graph: RuntimeGraph,
    runtimeContext: ExecutionRuntimeContext,
    stopHeartbeat: () => void
  ): Promise<WorkflowRunResult> {
    const stepRows = runtimeStepRows(currentExecution).filter((step) => step.position > 0);
    const stepRowsByKey = new Map(stepRows.map((step) => [step.key, step]));
    validateRuntimeGraph(graph, new Set(stepRowsByKey.keys()));

    let current = currentExecution;
    let nextStepKey: string | undefined = graph.entryStepKey;
    while (nextStepKey) {
      if ((current as any).status === ExecutionStatus.Cancelled) {
        stopHeartbeat();
        await this.leaseService.release(current.id);
        return { status: "completed" };
      }
      await this.leaseService.assertOwned(current.id);
      const dbStep = stepRowsByKey.get(nextStepKey);
      if (!dbStep) {
        throw new Error(`Workflow graph references missing step ${nextStepKey}`);
      }
      const step = toStepDefinition(dbStep);
      let stepExecution = await this.stepExecutor.ensure({
        organizationId: current.organizationId,
        executionId: current.id,
        workflowStepId: dbStep.id,
        step
      });

      if (step.type === "for_each") {
        if (!this.forEach) throw new Error("FOR_EACH runtime service is unavailable");
        const bodyEdge = graph.edges.find((edge) => edge.from === step.key && edge.kind === "for_each_body");
        const doneEdge = graph.edges.find((edge) => edge.from === step.key && edge.kind === "for_each_done");
        if (!bodyEdge || !doneEdge || bodyEdge.to === doneEdge.to) throw new Error("FOR_EACH graph connections are invalid");
        if (stepExecution.status === StepExecutionStatus.Completed) { runtimeContext.setStepResult(step.key, StepExecutionStatus.Completed, stepExecution.outputJson); nextStepKey = doneEdge.to; continue; }
        const bodyStepKeys = bodyRegion(graph, bodyEdge.to, doneEdge.to);
        const outcome = await this.forEach.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          correlationId: (current as any).correlationId,
          loopStep: step,
          loopStepExecution: stepExecution as any,
          graph,
          bodyEntryStepKey: bodyEdge.to,
          doneStepKey: doneEdge.to,
          bodyStepKeys,
          stepRowsByKey,
          runtimeContext
          , parentContext: runtimeContext.context, parentPath: "root"
        });
        await this.updateContextCache(current.id, runtimeContext);
        if (outcome.outcome === "waiting") {
          await this.markWaiting(current.id, outcome.waitReason);
          stopHeartbeat();
          await this.leaseService.release(current.id);
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt, waitReason: outcome.waitReason };
        }
        runtimeContext.setStepResult(step.key, StepExecutionStatus.Completed, outcome.output);
        current = await this.reload(payload);
        nextStepKey = doneEdge.to;
        continue;
      }

      if (step.type === "try_catch") {
        if (!this.tryCatch) throw new Error("TRY_CATCH runtime service is unavailable");
        const required = ["try_body", "try_catch", "try_done"].every((kind) => graph.edges.some((edge) => edge.from === step.key && edge.kind === kind));
        if (!required) throw new Error("TRY_CATCH graph connections are invalid");
        const doneEdge = graph.edges.find((edge) => edge.from === step.key && edge.kind === "try_done")!;
        if (stepExecution.status === StepExecutionStatus.Completed) { runtimeContext.setStepResult(step.key, StepExecutionStatus.Completed, stepExecution.outputJson); nextStepKey = doneEdge.to; continue; }
        const outcome = await this.tryCatch.execute({ organizationId: current.organizationId, executionId: current.id, correlationId: (current as any).correlationId, tryStep: step, tryStepExecution: stepExecution as any, graph, stepRowsByKey, runtimeContext, parentContext: runtimeContext.context, parentPath: "root" });
        await this.updateContextCache(current.id, runtimeContext);
        if (outcome.outcome === "waiting") { await this.markWaiting(current.id, outcome.waitReason); stopHeartbeat(); await this.leaseService.release(current.id); return { status: "waiting", nextRetryAt: outcome.nextRetryAt, waitReason: outcome.waitReason }; }
        runtimeContext.setStepResult(step.key, StepExecutionStatus.Completed, outcome.output);
        current = await this.reload(payload);
        nextStepKey = doneEdge.to;
        continue;
      }

      if (step.type === "execute_workflow") {
        if (!this.executeWorkflow) throw new Error("EXECUTE_WORKFLOW runtime service is unavailable");
        const outcome = await this.executeWorkflow.execute({ organizationId: current.organizationId, executionId: current.id, correlationId: (current as any).correlationId, step, stepExecution: stepExecution as any, context: runtimeContext.context });
        await this.updateContextCache(current.id, runtimeContext);
        if (outcome.outcome === "waiting") { await this.markWaiting(current.id); stopHeartbeat(); await this.leaseService.release(current.id); return { status: "waiting", nextRetryAt: outcome.nextRetryAt }; }
        runtimeContext.setStepResult(step.key, StepExecutionStatus.Completed, outcome.output);
        current = await this.reload(payload);
        nextStepKey = selectedNextStepKey(graph, step.key, outcome.output);
        continue;
      }

      if (stepExecution.status === StepExecutionStatus.Retrying && stepExecution.nextRetryAt && stepExecution.nextRetryAt > new Date()) {
        await this.markWaiting(current.id);
        stopHeartbeat();
        await this.leaseService.release(current.id);
        this.logger?.info("worker.step.retry_scheduled", {
          stepExecutionId: stepExecution.id,
          stepKey: step.key,
          stepType: step.type,
          nextRetryAt: stepExecution.nextRetryAt
        });
        return { status: "waiting", nextRetryAt: stepExecution.nextRetryAt };
      }

      if (stepExecution.status === StepExecutionStatus.Retrying && isIntentionalWait(stepExecution)) {
        const outcome = await this.stepExecutor.completeWait({ step, stepExecution });
        runtimeContext.setStepResult(step.key, outcome.result.status, outcome.result.output);
        await this.updateContextCache(current.id, runtimeContext);
        current = await this.reload(payload);
          stepExecution = current.steps.find((entry) => entry.stepKey === step.key && (entry as any).executionPath === "root") as typeof stepExecution;
      }

      if (stepExecution.status === StepExecutionStatus.Failed && stepExecution.attemptCount >= stepExecution.maxAttempts) {
        throw new Error(`Step ${step.key} failed after ${stepExecution.attemptCount} attempts`);
      }

      if (!isDone(stepExecution.status)) {
        const outcome = await this.stepExecutor.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step,
          context: runtimeContext.context,
          stepExecution
        });
        await this.leaseService.assertOwned(current.id);
        if (outcome.outcome === "completed") runtimeContext.setStepResult(step.key, outcome.result.status, outcome.result.output);
        await this.updateContextCache(current.id, runtimeContext);

        if (outcome.outcome === "retrying" || outcome.outcome === "durable_wait") {
          await this.markWaiting(current.id, outcome.waitReason);
          stopHeartbeat();
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: outcome.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt, waitReason: outcome.waitReason };
        }

        if (step.type === "return_workflow_output") {
          await this.prisma.execution.update({ where: { id: current.id }, data: { outputJson: toJson(outcome.result.output) } });
          nextStepKey = undefined;
          current = await this.reload(payload);
          break;
        }

        const selected = selectedNextStepKey(graph, step.key, outcome.result.output);
        if (selected && isControlStep(step.type)) {
          this.logger?.info(step.type === "switch" ? "worker.flow.switch_case_selected" : "worker.flow.branch_selected", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextStepKey: selected
          });
          this.metrics?.recordBranch(step.type, String((outcome.result.output as any)?.branch ?? (outcome.result.output as any)?.matchedCaseKey ?? "default"));
          await this.skipUnselectedBranches(current, graph, step.key, selected, stepRowsByKey, runtimeContext);
        }
        current = await this.reload(payload);
      }

      const latest = current.steps.find((entry) => entry.stepKey === step.key && (entry as any).executionPath === "root");
      const selected = selectedNextStepKey(graph, step.key, latest?.outputJson);
      if (selected) {
        nextStepKey = selected;
        continue;
      }
      if (isTerminal(graph, step.key)) {
        nextStepKey = undefined;
        break;
      }
      throw new Error(`Workflow graph cannot resolve next step after ${step.key}`);
    }

    await this.leaseService.assertOwned(initialExecution.id);
    const context = runtimeContext.snapshot({ includeRuntime: false });
    await this.assertNoFailedSteps(initialExecution.id);
    const completed = await this.prisma.execution.updateMany({
      where: { id: initialExecution.id, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
      data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: toJson(context), errorJson: undefined, waitReason: null }
    });
    stopHeartbeat();
    await this.leaseService.release(initialExecution.id);
    if (completed.count !== 1) return { status: "completed" };
    this.logger?.info("worker.execution.completed", { durationMs: initialExecution.startedAt ? Date.now() - initialExecution.startedAt.getTime() : undefined });
    const fullExecution = await this.prisma.execution.findUnique({ where: { id: initialExecution.id }, select: { executionMode: true } });
    const auditExecution = await this.prisma.execution.findUnique({ where: { id: initialExecution.id }, select: { organizationId: true, workflowId: true, workflowVersionId: true, correlationId: true } });
    if (auditExecution) {
      await this.recordAudit(auditExecution.organizationId, "execution.completed", "Execution", initialExecution.id, auditExecution.correlationId, {
        workflowId: auditExecution.workflowId,
        workflowVersionId: auditExecution.workflowVersionId
      });
    }
    if (fullExecution?.executionMode !== "TEST") this.metrics?.executionsCompleted.inc();
    await this.wakeParent(initialExecution.id);
    return { status: "completed" };
  }

  private async skipUnselectedBranches(
    execution: { id: string; organizationId: string },
    graph: RuntimeGraph,
    controlStepKey: string,
    selectedStepKey: string,
    stepRowsByKey: Map<string, RuntimeStepRow>,
    runtimeContext: ExecutionRuntimeContext
  ) {
    for (const skipKey of branchSkipKeys(graph, controlStepKey, selectedStepKey)) {
      const dbStep = stepRowsByKey.get(skipKey);
      if (!dbStep) continue;
      const step = toStepDefinition(dbStep);
      const stepExecution = await this.stepExecutor.ensure({
        organizationId: execution.organizationId,
        executionId: execution.id,
        workflowStepId: dbStep.id,
        step
      });
      if (isDone(stepExecution.status)) continue;
      const { result } = await this.stepExecutor.skip({
        organizationId: execution.organizationId,
        executionId: execution.id,
        workflowStepId: dbStep.id,
        step,
        stepExecution,
        reason: "branch_not_selected"
      });
      runtimeContext.setStepResult(step.key, result.status, result.output);
      this.logger?.info("worker.flow.branch_skipped", { stepKey: skipKey, controlStepKey });
    }
  }

  private async reconstructContextForExecution(executionId: string) {
    const execution = await this.prisma.execution.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        workflow: { include: { organization: true } },
        testRun: { select: { snapshotDefinitionJson: true } },
        workflowVersion: { include: { workflow: { include: { organization: true } } } },
        steps: { orderBy: { createdAt: "asc" } }
      }
    });
    return this.reconstructContext(execution);
  }

  private async reconstructContext(execution: {
    id: string;
    organizationId: string;
    workflowId: string;
    workflowVersionId?: string | null;
    correlationId?: string | null;
    retryOfExecutionId?: string | null;
    startedAt?: Date | null;
    inputJson: unknown;
    contextJson?: unknown;
    workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null;
    testRun?: { snapshotDefinitionJson: unknown } | null;
    workflowVersion?: { definitionJson: unknown; workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null } | null;
    steps: Array<{ stepKey: string; status: string; outputJson: unknown }>;
  }) {
    const context = this.contextReconstructor.reconstruct(withRuntimeDefinition(execution), execution.steps.filter((step: any) => (step.executionPath ?? "root") === "root"));
    const [organizationVariables, workflowVariables] = await Promise.all([
      this.loadOrganizationVariables(execution.organizationId),
      this.loadWorkflowVariables(execution.organizationId, execution.workflowId)
    ]);
    context.organization = {
      ...(context.organization ?? {}),
      variables: Object.fromEntries(organizationVariables.map((variable) => [variable.key, variable.valueJson]))
    };
    context.workflow = {
      ...(context.workflow ?? {}),
      variables: {
        ...((context.workflow?.variables as Record<string, unknown> | undefined) ?? {}),
        ...Object.fromEntries(workflowVariables.map((variable) => [variable.key, variable.valueJson]))
      },
      environment: {
        ...((context.workflow?.environment as Record<string, unknown> | undefined) ?? {})
      }
    };
    return context;
  }

  private async createRuntimeContext(execution: Parameters<WorkflowRunner["reconstructContext"]>[0]) {
    const context = await this.reconstructContext(execution);
    const cached = execution.contextJson && typeof execution.contextJson === "object" && !Array.isArray(execution.contextJson)
      ? (execution.contextJson as Record<string, unknown>).__runtime
      : undefined;
    return new ExecutionRuntimeContext(context, cached);
  }

  private async loadOrganizationVariables(organizationId: string) {
    try {
      return await this.prisma.organizationVariable.findMany({ where: { organizationId } });
    } catch (error: any) {
      if (error?.code === "P2021") return [];
      throw error;
    }
  }

  private async loadWorkflowVariables(organizationId: string, workflowId: string) {
    try {
      return await this.prisma.workflowVariable.findMany({ where: { organizationId, workflowId } });
    } catch (error: any) {
      if (error?.code === "P2021") return [];
      throw error;
    }
  }

  private async updateContextCache(executionId: string, runtimeContext?: ExecutionRuntimeContext) {
    const context = runtimeContext?.snapshot({ includeRuntime: true }) ?? await this.reconstructContextForExecution(executionId);
    await this.prisma.execution.update({ where: { id: executionId }, data: { contextJson: toJson(context) } });
  }

  private markWaiting(executionId: string, waitReason?: string) {
    return this.prisma.execution.updateMany({
      where: { id: executionId, status: { in: ACTIVE_EXECUTION_STATUSES as any } },
      data: { status: ExecutionStatus.Retrying, completedAt: null, waitReason: waitReason ?? "retry" }
    });
  }

  private async assertNoFailedSteps(executionId: string) {
    const failed = await this.prisma.stepExecution.count({ where: { executionId, status: StepExecutionStatus.Failed, errorHandled: false } });
    if (failed > 0) throw new Error("Execution cannot complete with failed steps");
  }

  private async recordAudit(organizationId: string, action: string, resourceType: string, resourceId: string, correlationId: string | null | undefined, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action,
        resourceType,
        resourceId,
        correlationId: correlationId ?? null,
        metadataJson: toJson(metadata)
      }
    }).catch(() => undefined);
  }

  private async wakeParent(executionId: string) {
    if (!this.executionQueue) return;
    const child = await this.prisma.execution.findUnique({ where: { id: executionId }, select: { parentExecution: { select: { id: true, organizationId: true, workflowId: true, workflowVersionId: true, correlationId: true, executionMode: true } } } });
    const parent = child?.parentExecution;
    if (!parent) return;
    await this.executionQueue.add(EXECUTION_RUN_JOB, { organizationId: parent.organizationId, executionId: parent.id, workflowId: parent.workflowId, workflowVersionId: parent.workflowVersionId ?? undefined, requestId: `subworkflow-wake-${executionId}`, correlationId: parent.correlationId ?? randomCorrelationId(), enqueuedAt: new Date().toISOString(), executionMode: parent.executionMode }, { jobId: `execution-${parent.id}-child-${executionId}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false }).catch(() => undefined);
  }
}

function randomCorrelationId() { return `subworkflow-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function toStepDefinition(dbStep: RuntimeStepRow): WorkflowStepDefinition {
  return {
    id: dbStep.id ?? undefined,
    key: dbStep.key,
    name: dbStep.name,
    type: dbStep.type as any,
    position: dbStep.position,
    config: dbStep.configJson as Record<string, unknown>,
    retryPolicy: dbStep.retryPolicyJson as any,
    timeoutSeconds: dbStep.timeoutSeconds ?? undefined
  };
}

function runtimeDefinition(execution: {
  executionMode?: string | null;
  testRun?: { snapshotDefinitionJson: unknown } | null;
  workflowVersion?: { definitionJson: unknown } | null;
}) {
  return execution.executionMode === "TEST" && execution.testRun?.snapshotDefinitionJson ? execution.testRun.snapshotDefinitionJson : execution.workflowVersion?.definitionJson;
}

function runtimeStepRows(execution: {
  executionMode?: string | null;
  testRun?: { snapshotDefinitionJson: unknown } | null;
  workflowVersion?: { steps?: RuntimeStepRow[] | null } | null;
}) {
  if (execution.executionMode === "TEST" && execution.testRun?.snapshotDefinitionJson) {
    const definition = execution.testRun.snapshotDefinitionJson as { trigger?: any; steps?: any[] };
    return [
      ...(definition.trigger ? [definition.trigger] : []),
      ...(Array.isArray(definition.steps) ? definition.steps : [])
    ].map((step, index) => ({
      id: null,
      key: String(step.key),
      name: String(step.name ?? step.key),
      type: String(step.type),
      position: Number.isFinite(Number(step.position)) ? Number(step.position) : index,
      configJson: step.config ?? {},
      retryPolicyJson: step.retryPolicy ?? null,
      timeoutSeconds: typeof step.timeoutSeconds === "number" ? step.timeoutSeconds : null
    }));
  }
  return execution.workflowVersion?.steps ?? [];
}

function withRuntimeDefinition<T extends {
  executionMode?: string | null;
  testRun?: { snapshotDefinitionJson: unknown } | null;
  workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null;
  workflowVersion?: { definitionJson: unknown; workflow?: { name: string; organization?: { id: string; slug?: string | null } | null } | null } | null;
}>(execution: T) {
  if (execution.executionMode === "TEST" && execution.testRun?.snapshotDefinitionJson) {
    return {
      ...execution,
      workflowVersion: {
        ...(execution.workflowVersion ?? {}),
        definitionJson: execution.testRun.snapshotDefinitionJson,
        workflow: execution.workflowVersion?.workflow ?? execution.workflow ?? null
      }
    };
  }
  return execution;
}

function shouldSkipNext(step: WorkflowStepDefinition, output: unknown) {
  return (
    step.type === "conditional" &&
    Boolean((step.config as any).skipNextOnFalse) &&
    output !== null &&
    typeof output === "object" &&
    (output as any).passed === false
  );
}

function isControlStep(stepType: string) {
  return stepType === "if" || stepType === "switch" || stepType === "approval";
}

function isIntentionalWait(stepExecution: { effectStatus: string | null; outputJson?: unknown }) {
  if (stepExecution.effectStatus === "approval_waiting") return false;
  if (stepExecution.effectStatus === "delay" || stepExecution.effectStatus === "wait_until" || stepExecution.effectStatus === "waiting") return true;
  const output = stepExecution.outputJson;
  return Boolean(output && typeof output === "object" && "waitReason" in output);
}

function deadLetterReason(stepType?: string, effectStatus?: string | null, errorJson?: unknown) {
  if (effectStatus === "ambiguous") return "ambiguous";
  if (stepType === "delay" || stepType === "wait_until") return "invalid_wait";
  if (stepType === "if" || stepType === "switch") return "branch_resolution_failed";
  const message = errorJson && typeof errorJson === "object" ? String((errorJson as any).message ?? "") : "";
  if (message.toLowerCase().includes("graph")) return "control_validation_failed";
  return "failed";
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function bodyRegion(graph: RuntimeGraph, start: string, done: string) {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (key === done || seen.has(key)) return;
    seen.add(key);
    for (const edge of graph.edges.filter((candidate) => candidate.from === key)) visit(edge.to);
  };
  visit(start);
  return seen;
}
