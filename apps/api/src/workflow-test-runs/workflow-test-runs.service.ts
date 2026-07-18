import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ExecutionMode,
  ExecutionStatus,
  OrganizationRole,
  StepExecutionStatus,
  StepType,
  type WorkflowDefinition,
  type DebugStepInspector,
  type DebugTimelineEvent,
  type DebugTimelineStatus,
  type WorkflowTestRunComparison,
  type WorkflowTestRunDetail
} from "@automation/shared-types";
import { newTraceId } from "@automation/observability";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queues/queue.service";
import { AuditLogsService } from "../audit-logs/audit-logs.service";
import { RequestContextService } from "../observability/request-context.service";
import { sanitizePublic } from "../common/public-sanitizer";
import { validateWorkflowGraph } from "../workflows/workflow-graph-validator";
import { CreateWorkflowTestRunDto } from "./dto/create-workflow-test-run.dto";

@Injectable()
export class WorkflowTestRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly requestContext?: RequestContextService,
    private readonly auditLogs?: AuditLogsService
  ) {}

  async create(organizationId: string, userId: string, workflowId: string, dto: CreateWorkflowTestRunDto) {
    const externalMode = dto.externalMode ?? "mock";
    if (externalMode === "real") {
      await this.assertCanRunRealMode(organizationId, userId);
    }
    if (externalMode === "real" && dto.realModeConfirmed !== true) {
      throw new BadRequestException("Real mode requires explicit confirmation");
    }
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } }
    });
    if (!workflow) throw new NotFoundException("Workflow not found");
    const { workflowVersionId, snapshot, source } = await this.resolveSnapshot(organizationId, workflowId, dto, workflow.activeVersionId ?? workflow.versions[0]?.id);
    const sideEffectNodes = collectSideEffectNodes(snapshot);

    const correlationId = this.requestContext?.getCorrelationId() ?? newTraceId();
    const input = sanitizePublic({ trigger: dto.payload?.trigger ?? {}, metadata: { ...(dto.payload?.metadata ?? {}), testRun: true, externalMode } }) as {
      trigger: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    const payload = sanitizePublic(dto.payload ?? { trigger: {} });
    const stepMocks = sanitizePublic(dto.stepMocks ?? {});
    const snapshotJson = sanitizePublic(snapshot);
    const created = await this.prisma.$transaction(async (tx) => {
      const execution = await tx.execution.create({
        data: {
          organizationId,
          workflowId,
          workflowVersionId,
          correlationId,
          status: ExecutionStatus.Queued,
          executionMode: ExecutionMode.Test,
          inputJson: toJson(input),
          contextJson: toJson({ trigger: input.trigger, steps: {}, metadata: input.metadata })
        }
      });
      const testRun = await tx.workflowTestRun.create({
        data: {
          organizationId,
          workflowId,
          workflowVersionId,
          executionId: execution.id,
          createdByUserId: userId,
          externalMode,
          payloadJson: toJson(payload),
          stepMocksJson: toJson(stepMocks),
          snapshotDefinitionJson: toJson(snapshotJson),
          draftDefinitionJson: source === "draft" ? toJson(snapshotJson) : undefined,
          source,
          realModeConfirmedAt: externalMode === "real" ? new Date() : undefined,
          realModeConfirmedByUserId: externalMode === "real" ? userId : undefined,
          compareWithLastReal: dto.compareWithLastReal === true
        }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "workflow.test_run.created",
          resourceType: "WorkflowTestRun",
          resourceId: testRun.id,
          correlationId,
          metadata: { workflowId, workflowVersionId, externalMode, source }
        },
        tx
      );
      if (externalMode === "real") {
        await this.auditLogs?.record(
          {
            organizationId,
            actorUserId: userId,
            action: "workflow.test_run.real_mode_enabled",
            resourceType: "WorkflowTestRun",
            resourceId: testRun.id,
            correlationId,
            metadata: { workflowId, workflowVersionId, sideEffectNodes: sideEffectNodes.map((node) => ({ key: node.key, type: node.type })) }
          },
          tx
        );
      }
      return { execution, testRun };
    });

    await this.queueService.enqueueExecution({
      organizationId,
      executionId: created.execution.id,
      workflowId,
      workflowVersionId: workflowVersionId ?? undefined,
      requestId: this.requestContext?.getRequestId() ?? `test-run-${created.testRun.id}`,
      correlationId,
      enqueuedAt: new Date().toISOString(),
      executionMode: ExecutionMode.Test,
      testRunId: created.testRun.id
    });
    return this.detail(organizationId, workflowId, created.testRun.id);
  }

  async list(organizationId: string, workflowId: string) {
    await this.assertWorkflow(organizationId, workflowId);
    const items = await this.prisma.workflowTestRun.findMany({
      where: { organizationId, workflowId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        createdBy: { select: { id: true, email: true, name: true } },
        execution: { select: { status: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true } }
      }
    });
    return { items: items.map(summary), total: items.length };
  }

  async detail(organizationId: string, workflowId: string, testRunId: string): Promise<WorkflowTestRunDetail> {
    const testRun = await this.load(organizationId, workflowId, testRunId);
    const base = summary(testRun);
    const steps = testRun.execution.steps;
    const comparison = testRun.compareWithLastReal ? await this.compareLastReal(organizationId, workflowId, testRunId) : null;
    return {
      ...base,
      payload: sanitizePublic(testRun.payloadJson),
      stepMocks: sanitizePublic(testRun.stepMocksJson) as any,
      sideEffectNodes: collectSideEffectNodes(testRun.snapshotDefinitionJson as unknown as WorkflowDefinition),
      timeline: timeline(testRun.execution, steps, testRun.execution.deadLetters),
      graph: graphState(testRun.execution.status, steps, testRun.execution.deadLetters),
      inspector: Object.fromEntries(steps.map((step) => [step.executionPath === "root" ? step.stepKey : `${step.executionPath}:${step.stepKey}`, inspector(step)])),
      comparison
    };
  }

  async cancel(organizationId: string, userId: string, workflowId: string, testRunId: string) {
    const testRun = await this.load(organizationId, workflowId, testRunId);
    if (![ExecutionStatus.Completed, ExecutionStatus.Failed, ExecutionStatus.Cancelled].includes(testRun.execution.status as ExecutionStatus)) {
      await this.prisma.execution.update({
        where: { id: testRun.executionId },
        data: { status: ExecutionStatus.Cancelled, completedAt: new Date(), lockedBy: null, lockedUntil: null, lastHeartbeatAt: null }
      });
      await this.auditLogs?.record({
        organizationId,
        actorUserId: userId,
        action: "workflow.test_run.cancelled",
        resourceType: "WorkflowTestRun",
        resourceId: testRun.id,
        correlationId: testRun.execution.correlationId,
        metadata: { workflowId, executionId: testRun.executionId }
      });
    }
    return this.detail(organizationId, workflowId, testRunId);
  }

  async rerun(organizationId: string, userId: string, workflowId: string, testRunId: string) {
    const original = await this.load(organizationId, workflowId, testRunId);
    if (original.externalMode === "real") {
      await this.assertCanRunRealMode(organizationId, userId);
    }
    return this.create(organizationId, userId, workflowId, {
      workflowVersionId: original.workflowVersionId ?? undefined,
      draftDefinition: original.snapshotDefinitionJson as any,
      payload: original.payloadJson as any,
      externalMode: original.externalMode as any,
      stepMocks: original.stepMocksJson as any,
      compareWithLastReal: original.compareWithLastReal,
      realModeConfirmed: original.externalMode === "real"
    });
  }

  async skipWait(organizationId: string, userId: string, workflowId: string, testRunId: string, stepKey: string) {
    const testRun = await this.load(organizationId, workflowId, testRunId);
    const step = testRun.execution.steps.find((entry) => entry.stepKey === stepKey);
    if (step?.status === StepExecutionStatus.Completed && isRecord(step.outputJson) && step.outputJson.skippedWait === true) {
      return this.detail(organizationId, workflowId, testRunId);
    }
    const snapshotStep = findSnapshotStep(testRun.snapshotDefinitionJson as unknown as WorkflowDefinition, stepKey);
    if (!step || !snapshotStep || ![StepType.Delay, StepType.WaitUntil].includes(snapshotStep.type as StepType) || step.status !== StepExecutionStatus.Retrying || !step.nextRetryAt || !isIntentionalWait(step)) {
      throw new BadRequestException("Step is not waiting in this test run");
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.stepExecution.update({
        where: { id: step.id },
        data: {
          status: StepExecutionStatus.Completed,
          completedAt: now,
          nextRetryAt: null,
          durationMs: step.startedAt ? Math.max(0, now.getTime() - step.startedAt.getTime()) : 0,
          outputJson: toJson({ ...(isRecord(step.outputJson) ? step.outputJson : {}), skippedWait: true, skippedAt: now.toISOString() }),
          effectStatus: "succeeded"
        }
      });
      await tx.execution.update({
        where: { id: testRun.executionId },
        data: { status: ExecutionStatus.Queued, lockedBy: null, lockedUntil: null }
      });
      await this.auditLogs?.record(
        {
          organizationId,
          actorUserId: userId,
          action: "workflow.test_run.wait_skipped",
          resourceType: "WorkflowTestRun",
          resourceId: testRun.id,
          correlationId: testRun.execution.correlationId,
          metadata: { workflowId, executionId: testRun.executionId, stepKey }
        },
        tx
      );
    });
    await this.queueService.enqueueExecution({
      organizationId,
      executionId: testRun.executionId,
      workflowId,
      workflowVersionId: testRun.workflowVersionId ?? undefined,
      requestId: this.requestContext?.getRequestId() ?? `test-skip-wait-${testRun.id}`,
      correlationId: testRun.execution.correlationId ?? newTraceId(),
      enqueuedAt: new Date().toISOString(),
      executionMode: ExecutionMode.Test,
      testRunId
    });
    return this.detail(organizationId, workflowId, testRunId);
  }

  async compareLastReal(organizationId: string, workflowId: string, testRunId: string): Promise<WorkflowTestRunComparison> {
    const testRun = await this.load(organizationId, workflowId, testRunId);
    const real = await this.prisma.execution.findFirst({
      where: {
        organizationId,
        workflowId,
        ...(testRun.workflowVersionId ? { workflowVersionId: testRun.workflowVersionId } : {}),
        executionMode: ExecutionMode.Real
      },
      orderBy: { createdAt: "desc" },
      include: { steps: true }
    });
    if (!real) {
      return { testRunId, realExecutionId: null, statusChanged: true, durationDeltaMs: null, steps: [] };
    }
    const realSteps = new Map(real.steps.map((step) => [step.stepKey, step]));
    return {
      testRunId,
      realExecutionId: real.id,
      statusChanged: testRun.execution.status !== real.status,
      durationDeltaMs: durationMs(testRun.execution.startedAt, testRun.execution.completedAt, real.startedAt, real.completedAt),
      steps: testRun.execution.steps.map((step) => {
        const counterpart = realSteps.get(step.stepKey);
        return {
          stepKey: step.stepKey,
          testStatus: step.status,
          realStatus: counterpart?.status ?? null,
          durationDeltaMs: counterpart ? (step.durationMs ?? 0) - (counterpart.durationMs ?? 0) : null,
          outputShapeChanged: shape(step.outputJson) !== shape(counterpart?.outputJson)
        };
      })
    };
  }

  private async assertWorkflow(organizationId: string, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId }, select: { id: true } });
    if (!workflow) throw new NotFoundException("Workflow not found");
  }

  private async assertCanRunRealMode(organizationId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: "ACTIVE" },
      select: { role: true }
    });
    if (![OrganizationRole.Admin, OrganizationRole.Owner].includes(membership?.role as OrganizationRole)) {
      throw new ForbiddenException("Real mode test runs require admin or owner role");
    }
  }

  private async resolveSnapshot(
    organizationId: string,
    workflowId: string,
    dto: CreateWorkflowTestRunDto,
    fallbackVersionId?: string | null
  ): Promise<{ workflowVersionId: string | null; snapshot: WorkflowDefinition; source: "draft" | "version" }> {
    if (dto.draftDefinition) {
      const snapshot = dto.draftDefinition as WorkflowDefinition;
      validateSnapshot(snapshot);
      if (dto.workflowVersionId) {
        const version = await this.prisma.workflowVersion.findFirst({ where: { id: dto.workflowVersionId, workflowId, organizationId }, select: { id: true } });
        if (!version) throw new NotFoundException("Workflow version not found");
      }
      return { workflowVersionId: dto.workflowVersionId ?? fallbackVersionId ?? null, snapshot, source: "draft" };
    }
    const workflowVersionId = dto.workflowVersionId ?? fallbackVersionId;
    if (!workflowVersionId) throw new BadRequestException("Workflow has no version to test");
    const version = await this.prisma.workflowVersion.findFirst({
      where: { id: workflowVersionId, workflowId, organizationId },
      select: { id: true, definitionJson: true }
    });
    if (!version) throw new NotFoundException("Workflow version not found");
    const snapshot = version.definitionJson as unknown as WorkflowDefinition;
    validateSnapshot(snapshot);
    return { workflowVersionId: version.id, snapshot, source: "version" };
  }

  private async load(organizationId: string, workflowId: string, testRunId: string) {
    const testRun = await this.prisma.workflowTestRun.findFirst({
      where: { id: testRunId, workflowId, organizationId },
      include: {
        createdBy: { select: { id: true, email: true, name: true } },
        execution: {
          include: {
            steps: { orderBy: { createdAt: "asc" } },
            deadLetters: { orderBy: { createdAt: "desc" } }
          }
        }
      }
    });
    if (!testRun) throw new NotFoundException("Test run not found");
    return testRun;
  }
}

function summary(testRun: any) {
  return {
    id: testRun.id,
    workflowId: testRun.workflowId,
    workflowVersionId: testRun.workflowVersionId,
    executionId: testRun.executionId,
    status: testRun.execution.status,
    externalMode: testRun.externalMode,
    source: testRun.source ?? (testRun.draftDefinitionJson ? "draft" : "version"),
    createdAt: testRun.createdAt.toISOString(),
    updatedAt: testRun.updatedAt.toISOString(),
    startedAt: testRun.execution.startedAt?.toISOString() ?? null,
    completedAt: testRun.execution.completedAt?.toISOString() ?? null,
    durationMs: simpleDuration(testRun.execution.startedAt, testRun.execution.completedAt),
    createdBy: testRun.createdBy
  };
}

function timeline(execution: any, steps: any[], deadLetters: any[]): DebugTimelineEvent[] {
  const events: Array<Omit<DebugTimelineEvent, "timestamp"> & { timestamp: Date | string }> = [
    { id: `${execution.id}:queued`, status: "QUEUED", timestamp: execution.createdAt, message: "Test run queued" },
    ...(execution.startedAt ? [{ id: `${execution.id}:running`, status: "RUNNING" as const, timestamp: execution.startedAt, message: "Test run started" }] : [])
  ];
  for (const step of steps) {
    if (step.startedAt) events.push({ id: `${step.id}:running`, status: "RUNNING", stepKey: step.stepKey, timestamp: step.startedAt, attempt: step.attemptCount, message: `${step.stepKey} running` });
    const status = (step.status === StepExecutionStatus.Retrying && step.nextRetryAt ? "WAITING" : step.status) as DebugTimelineStatus;
    const timestamp = step.completedAt ?? step.updatedAt ?? step.createdAt;
    events.push({
      id: `${step.id}:${status}`,
      status,
      stepKey: step.stepKey,
      timestamp,
      durationMs: step.durationMs,
      attempt: step.attemptCount,
      message: `${step.stepKey} ${String(status).toLowerCase()}`,
      nextRetryAt: step.nextRetryAt?.toISOString() ?? null
    });
  }
  for (const deadLetter of deadLetters) {
    events.push({ id: `${deadLetter.id}:dlq`, status: "DLQ", stepKey: deadLetter.failedStepKey, timestamp: deadLetter.createdAt, message: "Test run failed" });
  }
  if (execution.completedAt) {
    events.push({ id: `${execution.id}:${execution.status}`, status: execution.status, timestamp: execution.completedAt, message: `Test run ${String(execution.status).toLowerCase()}` });
  }
  return events
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map((event) => ({ ...event, timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp }));
}

function graphState(executionStatus: string, steps: any[], deadLetters: any[]) {
  const dlqKeys = new Set(deadLetters.map((entry) => entry.failedStepKey).filter(Boolean));
  return Object.fromEntries(
    steps.map((step) => {
      const status = dlqKeys.has(step.stepKey)
        ? "dlq"
        : step.status === StepExecutionStatus.Completed
          ? "completed"
          : step.status === StepExecutionStatus.Skipped
            ? "skipped"
            : step.status === StepExecutionStatus.Failed
              ? "failed"
              : step.status === StepExecutionStatus.Retrying
                ? step.nextRetryAt
                  ? "waiting"
                  : "retrying"
                : step.status === StepExecutionStatus.Running
                  ? "active"
                  : "pending";
      return [step.stepKey, executionStatus === ExecutionStatus.Cancelled && status === "active" ? "failed" : status];
    })
  );
}

function inspector(step: any): DebugStepInspector {
  const debug = isRecord(step.debugJson) ? step.debugJson : {};
  const input = isRecord(step.inputJson) ? step.inputJson : {};
  return {
    stepKey: step.stepKey,
    stepType: step.stepType,
    executionPath: step.executionPath ?? "root",
    iterationIndex: step.iterationIndex ?? null,
    status: step.status,
    errorHandled: step.errorHandled ?? false,
    input: step.stepType === "for_each" ? loopDebugInput(input) : sanitizePublic(input),
    resolvedVariables: (Array.isArray(debug.resolvedVariables) ? sanitizePublic(debug.resolvedVariables) : []) as DebugStepInspector["resolvedVariables"],
    expressions: (Array.isArray(debug.expressions) ? sanitizePublic(debug.expressions) : []) as DebugStepInspector["expressions"],
    resolvedConfig: sanitizePublic(debug.resolvedConfig ?? input.config ?? {}),
    output: sanitizePublic(step.outputJson),
    durationMs: step.durationMs,
    retry: {
      attempt: step.attempt,
      attemptCount: step.attemptCount,
      maxAttempts: step.maxAttempts,
      nextRetryAt: step.nextRetryAt?.toISOString() ?? null
    },
    error: sanitizePublic(step.errorJson),
    connection: (isRecord(debug.connection) ? sanitizePublic(debug.connection) : null) as DebugStepInspector["connection"],
    variable: (isRecord(debug.variable) ? sanitizePublic(debug.variable) : null) as DebugStepInspector["variable"]
  };
}

function loopDebugInput(input: Record<string, unknown>) {
  const state = isRecord(input.forEachState) ? input.forEachState : {};
  return sanitizePublic({ total: Array.isArray(state.items) ? state.items.length : 0, nextIteration: state.nextIndex ?? 0, currentStepKey: state.currentStepKey ?? null });
}

function simpleDuration(start?: Date | null, end?: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

function durationMs(aStart?: Date | null, aEnd?: Date | null, bStart?: Date | null, bEnd?: Date | null) {
  const a = simpleDuration(aStart, aEnd);
  const b = simpleDuration(bStart, bEnd);
  return a === null || b === null ? null : a - b;
}

function shape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (!isRecord(value)) return typeof value;
  return Object.keys(value).sort().join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateSnapshot(definition: WorkflowDefinition) {
  if (!definition || !isRecord(definition) || !isRecord(definition.trigger) || !Array.isArray(definition.steps)) {
    throw new BadRequestException("Workflow definition is invalid");
  }
  const schemaVersion = definition.workflowDefinitionSchemaVersion ?? (definition.graph ? 2 : 1);
  if (schemaVersion === 2) {
    validateWorkflowGraph(definition.steps as any, definition.graph as any);
  }
}

function findSnapshotStep(definition: WorkflowDefinition, stepKey: string) {
  return definition.steps?.find((step) => step.key === stepKey);
}

function collectSideEffectNodes(definition: WorkflowDefinition) {
  const steps = Array.isArray(definition?.steps) ? definition.steps : [];
  return steps
    .filter((step) => isSideEffectStep(step.type))
    .map((step) => ({
      key: step.key,
      name: step.name,
      type: step.type,
      realModeAllowed: step.type !== StepType.DatabaseRecord
    }));
}

function isSideEffectStep(type: string) {
  return type === StepType.HttpRequest || type === StepType.EmailNotification || type === StepType.DatabaseRecord || String(type).startsWith("ai_");
}

function isIntentionalWait(step: { effectStatus: string | null; outputJson?: unknown }) {
  if (step.effectStatus === "delay" || step.effectStatus === "wait_until" || step.effectStatus === "waiting") return true;
  const output = step.outputJson;
  return Boolean(output && typeof output === "object" && "waitReason" in output);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
