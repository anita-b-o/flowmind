import { Injectable } from "@nestjs/common";
import { ExecutionJobPayload, ExecutionStatus, StepExecutionStatus, WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StepExecutor } from "./step-executor";
import { ContextReconstructor } from "./context-reconstructor";
import { ExecutionLeaseService } from "./execution-lease.service";
import { LeaseLostError } from "./lease-lost.error";
import { DeadLetterService } from "../dlq/dead-letter.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { branchSkipKeys, isDone, isTerminal, selectedNextStepKey } from "./graph/graph-planner";
import { parseRuntimeGraph, validateRuntimeGraph, type RuntimeGraph } from "./graph/graph-validator";

export type WorkflowRunResult = { status: "completed" | "skipped" | "lost_lease" } | { status: "waiting"; nextRetryAt: Date };

@Injectable()
export class WorkflowRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: StepExecutor,
    private readonly contextReconstructor: ContextReconstructor,
    private readonly leaseService: ExecutionLeaseService,
    private readonly deadLetterService: DeadLetterService,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
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
    if ([ExecutionStatus.Completed, ExecutionStatus.Cancelled].includes(execution.status as ExecutionStatus)) {
      await this.leaseService.release(execution.id);
      if (heartbeat) clearInterval(heartbeat);
      return { status: "completed" };
    }
      await this.prisma.execution.update({ where: { id: execution.id }, data: { startedAt: execution.startedAt ?? new Date(), completedAt: null } });

    try {
      let skipNext = false;
      let current = await this.loadExecution(payload);
      if (!current) {
        throw new Error(`Execution ${payload.executionId} not found`);
      }
      const graph = parseRuntimeGraph(current.workflowVersion.definitionJson);
      if (graph) {
        return await this.runGraph(payload, execution, current, graph, () => {
          if (heartbeat) clearInterval(heartbeat);
        });
      }

      for (const dbStep of current.workflowVersion.steps) {
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
          await this.updateContextCache(current.id);
          skipNext = false;
          current = await this.reload(payload);
          continue;
        }

        const context = await this.reconstructContext(current);
        const outcome = await this.stepExecutor.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step,
          context,
          stepExecution
        });
        await this.leaseService.assertOwned(current.id);
        await this.updateContextCache(current.id);

        if (outcome.outcome === "retrying") {
          await this.markWaiting(current.id);
          if (heartbeat) clearInterval(heartbeat);
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: outcome.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt };
        }
        skipNext = Boolean(outcome.result.control?.skipNext);
        current = await this.reload(payload);
      }

      const context = await this.reconstructContextForExecution(execution.id);
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: toJson(context), errorJson: undefined }
      });
      if (heartbeat) clearInterval(heartbeat);
      await this.leaseService.release(execution.id);
      this.logger?.info("worker.execution.completed", { durationMs: execution.startedAt ? Date.now() - execution.startedAt.getTime() : undefined });
      this.metrics?.executionsCompleted.inc();
      return { status: "completed" };
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (error instanceof LeaseLostError) {
        this.logger?.warn("worker.lease.lost");
        return { status: "lost_lease" };
      }
      const context = await this.reconstructContextForExecution(execution.id);
      const failedStep = await this.prisma.stepExecution.findFirst({
        where: { executionId: execution.id, status: StepExecutionStatus.Failed },
        orderBy: { updatedAt: "desc" }
      });
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: ExecutionStatus.Failed,
          completedAt: new Date(),
          contextJson: toJson(context),
          errorJson: { message: error instanceof Error ? error.message : String(error) }
        }
      });
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
      this.metrics?.executionsFailed.inc({ error_category: (failedStep?.errorJson as any)?.classification ?? "unknown" });
      await this.leaseService.release(execution.id);
      throw error;
    }
  }

  private loadExecution(payload: ExecutionJobPayload) {
    return this.prisma.execution.findFirst({
      where: { id: payload.executionId, organizationId: payload.organizationId },
      include: {
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
    stopHeartbeat: () => void
  ): Promise<WorkflowRunResult> {
    const stepRows = currentExecution.workflowVersion.steps.filter((step) => step.position > 0);
    const stepRowsByKey = new Map(stepRows.map((step) => [step.key, step]));
    validateRuntimeGraph(graph, new Set(stepRowsByKey.keys()));

    let current = currentExecution;
    let nextStepKey: string | undefined = graph.entryStepKey;
    while (nextStepKey) {
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
        await this.stepExecutor.completeWait({ step, stepExecution });
        await this.updateContextCache(current.id);
        current = await this.reload(payload);
        stepExecution = current.steps.find((entry) => entry.workflowStepId === dbStep.id) as typeof stepExecution;
      }

      if (stepExecution.status === StepExecutionStatus.Failed && stepExecution.attemptCount >= stepExecution.maxAttempts) {
        throw new Error(`Step ${step.key} failed after ${stepExecution.attemptCount} attempts`);
      }

      if (!isDone(stepExecution.status)) {
        const context = await this.reconstructContext(current);
        const outcome = await this.stepExecutor.execute({
          organizationId: current.organizationId,
          executionId: current.id,
          workflowStepId: dbStep.id,
          step,
          context,
          stepExecution
        });
        await this.leaseService.assertOwned(current.id);
        await this.updateContextCache(current.id);

        if (outcome.outcome === "retrying") {
          await this.markWaiting(current.id);
          stopHeartbeat();
          await this.leaseService.release(current.id);
          this.logger?.info("worker.step.retry_scheduled", {
            stepExecutionId: stepExecution.id,
            stepKey: step.key,
            stepType: step.type,
            nextRetryAt: outcome.nextRetryAt
          });
          return { status: "waiting", nextRetryAt: outcome.nextRetryAt };
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
          await this.skipUnselectedBranches(current, graph, step.key, selected, stepRowsByKey);
        }
        current = await this.reload(payload);
      }

      const latest = current.steps.find((entry) => entry.workflowStepId === dbStep.id);
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

    const context = await this.reconstructContextForExecution(initialExecution.id);
    await this.prisma.execution.update({
      where: { id: initialExecution.id },
      data: { status: ExecutionStatus.Completed, completedAt: new Date(), contextJson: toJson(context), errorJson: undefined }
    });
    stopHeartbeat();
    await this.leaseService.release(initialExecution.id);
    this.logger?.info("worker.execution.completed", { durationMs: initialExecution.startedAt ? Date.now() - initialExecution.startedAt.getTime() : undefined });
    this.metrics?.executionsCompleted.inc();
    return { status: "completed" };
  }

  private async skipUnselectedBranches(
    execution: { id: string; organizationId: string },
    graph: RuntimeGraph,
    controlStepKey: string,
    selectedStepKey: string,
    stepRowsByKey: Map<string, { id: string; key: string; name: string; type: string; position: number; configJson: unknown; retryPolicyJson: unknown; timeoutSeconds: number | null }>
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
      await this.stepExecutor.skip({
        organizationId: execution.organizationId,
        executionId: execution.id,
        workflowStepId: dbStep.id,
        step,
        stepExecution,
        reason: "branch_not_selected"
      });
      this.logger?.info("worker.flow.branch_skipped", { stepKey: skipKey, controlStepKey });
    }
  }

  private async reconstructContextForExecution(executionId: string) {
    const execution = await this.prisma.execution.findUniqueOrThrow({
      where: { id: executionId },
      include: { workflowVersion: { include: { workflow: { include: { organization: true } } } }, steps: { orderBy: { createdAt: "asc" } } }
    });
    return this.reconstructContext(execution);
  }

  private async reconstructContext(execution: {
    id: string;
    organizationId: string;
    workflowId: string;
    workflowVersionId: string;
    correlationId?: string | null;
    retryOfExecutionId?: string | null;
    startedAt?: Date | null;
    inputJson: unknown;
    workflowVersion?: { definitionJson: unknown; workflow?: { name: string; organization?: { id: string; slug?: string | null } } | null } | null;
    steps: Array<{ stepKey: string; status: string; outputJson: unknown }>;
  }) {
    const context = this.contextReconstructor.reconstruct(execution, execution.steps);
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
      }
    };
    return context;
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

  private async updateContextCache(executionId: string) {
    const context = await this.reconstructContextForExecution(executionId);
    await this.prisma.execution.update({ where: { id: executionId }, data: { contextJson: toJson(context) } });
  }

  private markWaiting(executionId: string) {
    return this.prisma.execution.update({
      where: { id: executionId },
      data: { status: ExecutionStatus.Retrying, completedAt: null }
    });
  }
}

function toStepDefinition(dbStep: {
  id: string;
  key: string;
  name: string;
  type: string;
  position: number;
  configJson: unknown;
  retryPolicyJson: unknown;
  timeoutSeconds: number | null;
}): WorkflowStepDefinition {
  return {
    id: dbStep.id,
    key: dbStep.key,
    name: dbStep.name,
    type: dbStep.type as any,
    position: dbStep.position,
    config: dbStep.configJson as Record<string, unknown>,
    retryPolicy: dbStep.retryPolicyJson as any,
    timeoutSeconds: dbStep.timeoutSeconds ?? undefined
  };
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
  return stepType === "if" || stepType === "switch";
}

function isIntentionalWait(stepExecution: { effectStatus: string | null; outputJson?: unknown }) {
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
