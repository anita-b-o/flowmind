import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { ExecutionMode, ExecutionStatus, normalizeExecuteWorkflowConfig, RetryPolicyDefinition, StepExecutionStatus, SUBWORKFLOW_LIMITS, SubworkflowExecutionError, assertSubworkflowJson, type ExecutionContext, type WorkflowStepDefinition } from "@automation/shared-types";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "../queues/queue.constants";
import { ExpressionResolver } from "./expression-resolver";
import { RetryPolicyResolver } from "./retry-policy-resolver";
import type { StepExecutionRecord } from "./step-executor";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";
import { recordStepAttempt } from "./step-attempt-recorder";

type Input = { organizationId: string; executionId: string; correlationId?: string | null; step: WorkflowStepDefinition; stepExecution: StepExecutionRecord & { startedAt?: Date | null }; context: ExecutionContext; executionPath?: string; iterationIndex?: number | null };
export type ExecuteWorkflowRunResult = { outcome: "completed"; output: unknown } | { outcome: "waiting"; nextRetryAt: Date };

@Injectable()
export class ExecuteWorkflowExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expressions: ExpressionResolver,
    private readonly retries: RetryPolicyResolver,
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue,
    private readonly metrics?: WorkerMetricsService
  ) {}

  async execute(input: Input): Promise<ExecuteWorkflowRunResult> {
    const raw = this.expressions.resolveValue(input.step.config, input.context, { mode: input.context.metadata?.expressionMode === "strict" ? "strict" : "legacy" });
    const config = normalizeExecuteWorkflowConfig(raw);
    const children = await this.prisma.execution.findMany({ where: { parentStepExecutionId: input.stepExecution.id, organizationId: input.organizationId }, orderBy: { createdAt: "desc" } });
    let child: (typeof children)[number] | undefined = children[0];
    if (child && ["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(child.status)) {
      if (Date.now() - child.createdAt.getTime() >= (config.timeoutSeconds ?? 120) * 1000) {
        await this.cancelChild(child.id, input.organizationId, "Subworkflow timeout");
        const policy = this.retries.resolve(input.step);
        if (input.stepExecution.attemptCount >= policy.maxAttempts) return this.fail(input, config.workflowId, child.id, "TIMEOUT", "Subworkflow execution timed out");
        child = undefined;
      }
      return this.wait(input.stepExecution.id);
    }
    if (child?.status === ExecutionStatus.Completed) {
      const output = assertSubworkflowJson(child.outputJson ?? null, "output");
      const result = { output, childExecutionId: child.id, workflowId: child.workflowId, workflowVersionId: child.workflowVersionId!, status: "COMPLETED", durationMs: child.startedAt && child.completedAt ? child.completedAt.getTime() - child.startedAt.getTime() : null, depth: child.depth };
      const now = new Date();
      await this.prisma.stepExecution.update({ where: { id: input.stepExecution.id }, data: { status: StepExecutionStatus.Completed, outputJson: json(result), errorJson: Prisma.JsonNull, completedAt: now, durationMs: input.stepExecution.startedAt ? now.getTime() - input.stepExecution.startedAt.getTime() : null, nextRetryAt: null, effectStatus: "succeeded", debugJson: json({ subworkflow: result }) } });
      await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.stepExecution.id, attempt: Math.max(1, input.stepExecution.attemptCount), status: StepExecutionStatus.Completed, startedAt: input.stepExecution.startedAt ?? undefined, completedAt: now, durationMs: input.stepExecution.startedAt ? now.getTime() - input.stepExecution.startedAt.getTime() : null, effectStatus: "succeeded" });
      await this.audit(input, "subworkflow.completed", config, child, "completed");
      this.metrics?.recordSubworkflow("success", config.versionPolicy, result.durationMs ? result.durationMs / 1000 : 0);
      return { outcome: "completed", output: result };
    }
    if (child && ["FAILED", "CANCELLED"].includes(child.status)) {
      const policy = this.retries.resolve(input.step);
      if (input.stepExecution.attemptCount >= policy.maxAttempts) return this.fail(input, config.workflowId, child.id, child.status, child.status === ExecutionStatus.Cancelled ? "Subworkflow execution was cancelled" : "Subworkflow execution failed");
      child = undefined;
    }

    const policy = this.retries.resolve(input.step);
    const nextAttempt = input.stepExecution.attemptCount + 1;
    const parent = await this.prisma.execution.findFirstOrThrow({ where: { id: input.executionId, organizationId: input.organizationId }, select: { id: true, workflowId: true, rootExecutionId: true, depth: true, executionMode: true, eventRootId: true, eventCausationId: true, eventDepth: true } });
    if (parent.depth + 1 > SUBWORKFLOW_LIMITS.maxDepth) { this.metrics?.recordSubworkflowDepthExceeded(); return this.fail(input, config.workflowId, undefined, "DEPTH_LIMIT", "Subworkflow depth limit exceeded"); }
    const ancestry = await this.ancestry(parent.id, input.organizationId);
    if (ancestry.has(config.workflowId)) return this.fail(input, config.workflowId, undefined, "RECURSION", "Subworkflow recursion detected");
    const rootId = parent.rootExecutionId ?? parent.id;
    const count = await this.prisma.execution.count({ where: { organizationId: input.organizationId, rootExecutionId: rootId } });
    if (count >= SUBWORKFLOW_LIMITS.maxChildrenPerRoot) return this.fail(input, config.workflowId, undefined, "CHILD_LIMIT", "Subworkflow child execution limit exceeded");
    const target = await this.resolveTarget(input.organizationId, config.workflowId, config.versionPolicy, config.workflowVersionId);
    const definition = record(target.definitionJson);
    if (record(definition.trigger).type !== "subworkflow_trigger") return this.fail(input, config.workflowId, undefined, "INVALID_ENTRYPOINT", "Target workflow is not invocable");
    const childInput = assertSubworkflowJson((raw as any).input ?? null, "input");
    const childId = randomUUID();
    const correlationId = input.correlationId ?? String(input.context.execution?.correlationId ?? randomUUID());
    await this.prisma.$transaction(async (tx) => {
      await tx.stepExecution.update({ where: { id: input.stepExecution.id }, data: { status: StepExecutionStatus.Retrying, attempt: nextAttempt, attemptCount: nextAttempt, maxAttempts: policy.maxAttempts, startedAt: input.stepExecution.startedAt ?? new Date(), nextRetryAt: new Date(Date.now() + SUBWORKFLOW_LIMITS.recheckMilliseconds), effectStatus: "subworkflow_waiting", inputJson: json({ workflowId: config.workflowId, versionPolicy: config.versionPolicy }) } });
      await recordStepAttempt(tx, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.stepExecution.id, attempt: nextAttempt, status: StepExecutionStatus.Retrying, startedAt: input.stepExecution.startedAt ?? new Date(), nextRetryAt: new Date(Date.now() + SUBWORKFLOW_LIMITS.recheckMilliseconds), waitReason: "subworkflow", effectStatus: "subworkflow_waiting" });
      await tx.execution.create({ data: { id: childId, organizationId: input.organizationId, workflowId: config.workflowId, workflowVersionId: target.id, parentExecutionId: parent.id, parentStepExecutionId: input.stepExecution.id, rootExecutionId: rootId, depth: parent.depth + 1, eventRootId: parent.eventRootId, eventCausationId: parent.eventCausationId, eventDepth: parent.eventDepth, correlationId, status: ExecutionStatus.Queued, executionMode: parent.executionMode as ExecutionMode, inputJson: json({ trigger: { input: childInput }, metadata: { subworkflow: true, depth: parent.depth + 1 } }), contextJson: json({ trigger: { input: childInput }, steps: {}, metadata: { subworkflow: true } }) } });
    });
    await this.queue.add(EXECUTION_RUN_JOB, { organizationId: input.organizationId, executionId: childId, workflowId: config.workflowId, workflowVersionId: target.id, requestId: `subworkflow-${childId}`, correlationId, enqueuedAt: new Date().toISOString(), executionMode: parent.executionMode }, { jobId: `execution-${childId}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false });
    await this.audit(input, "subworkflow.started", config, { id: childId, workflowId: config.workflowId, workflowVersionId: target.id, depth: parent.depth + 1 }, "started");
    this.metrics?.recordSubworkflow("started", config.versionPolicy);
    return this.wait(input.stepExecution.id);
  }

  private async resolveTarget(organizationId: string, workflowId: string, policy: string, versionId?: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, select: { activeVersionId: true } });
    if (!workflow) throw new SubworkflowExecutionError({ workflowId, status: "FAILED", category: "validation", code: "TARGET_NOT_FOUND", safeMessage: "Subworkflow target is unavailable" });
    const id = policy === "PINNED_VERSION" ? versionId : workflow.activeVersionId;
    const version = id ? await this.prisma.workflowVersion.findFirst({ where: { id, workflowId, organizationId, activatedAt: { not: null }, status: { in: ["ACTIVE", "ARCHIVED"] } } }) : null;
    if (!version) throw new SubworkflowExecutionError({ workflowId, status: "FAILED", category: "validation", code: "VERSION_NOT_PUBLISHED", safeMessage: "Subworkflow version is unavailable" });
    return version;
  }

  private async ancestry(executionId: string, organizationId: string) { const ids = new Set<string>(); let id: string | null = executionId; while (id) { const row: { workflowId: string; parentExecutionId: string | null } | null = await this.prisma.execution.findFirst({ where: { id, organizationId }, select: { workflowId: true, parentExecutionId: true } }); if (!row) break; ids.add(row.workflowId); id = row.parentExecutionId; } return ids; }
  private wait(stepId: string) { const nextRetryAt = new Date(Date.now() + SUBWORKFLOW_LIMITS.recheckMilliseconds); return this.prisma.stepExecution.update({ where: { id: stepId }, data: { status: StepExecutionStatus.Retrying, nextRetryAt, effectStatus: "subworkflow_waiting" } }).then(() => ({ outcome: "waiting" as const, nextRetryAt })); }
  private async fail(input: Input, workflowId: string, childId: string | undefined, code: string, message: string): Promise<never> { const now = new Date(); const error = new SubworkflowExecutionError({ childExecutionId: childId, workflowId, status: code === "CANCELLED" ? "CANCELLED" : "FAILED", category: "subworkflow", code, safeMessage: message }); await this.prisma.stepExecution.update({ where: { id: input.stepExecution.id }, data: { status: StepExecutionStatus.Failed, errorJson: json({ message, code, classification: "non_retryable" }), completedAt: now, nextRetryAt: null, effectStatus: "failed" } }); await recordStepAttempt(this.prisma, { organizationId: input.organizationId, executionId: input.executionId, stepExecutionId: input.stepExecution.id, attempt: Math.max(1, input.stepExecution.attemptCount), status: StepExecutionStatus.Failed, startedAt: input.stepExecution.startedAt ?? undefined, completedAt: now, effectStatus: "failed", errorCategory: "non_retryable", errorCodeSafe: code, errorMessageSafe: message }); const cancelled = code === "CANCELLED"; this.metrics?.recordSubworkflow(cancelled ? "cancellation" : "failure", String(input.step.config.versionPolicy ?? "PUBLISHED")); await this.prisma.auditLog.create({ data: { organizationId: input.organizationId, actorUserId: null, action: cancelled ? "subworkflow.cancelled" : "subworkflow.failed", resourceType: "StepExecution", resourceId: input.stepExecution.id, correlationId: input.correlationId ?? null, metadataJson: json({ workflowId, versionPolicy: input.step.config.versionPolicy ?? "PUBLISHED", outcome: cancelled ? "cancelled" : "failed", code }) } }).catch(() => undefined); throw error; }
  private cancelChild(id: string, organizationId: string, reason: string) { const now = new Date(); return this.prisma.execution.updateMany({ where: { id, organizationId, status: { in: ["PENDING", "QUEUED", "RUNNING", "RETRYING"] } }, data: { status: ExecutionStatus.Cancelled, cancelledAt: now, completedAt: now, cancelReason: reason, lockedBy: null, lockedUntil: null } }); }
  private audit(input: Input, action: string, config: any, child: any, outcome: string) { return this.prisma.auditLog.create({ data: { organizationId: input.organizationId, actorUserId: null, action, resourceType: "StepExecution", resourceId: input.stepExecution.id, correlationId: input.correlationId ?? null, metadataJson: json({ workflowId: child.workflowId, workflowVersionId: child.workflowVersionId, versionPolicy: config.versionPolicy, depth: child.depth, outcome }) } }).catch(() => undefined); }
}

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
