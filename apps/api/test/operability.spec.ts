import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ExecutionStatus, StepExecutionStatus, StepType } from "@automation/shared-types";
import { ExecutionLeaseService } from "../../worker/src/engine/execution-lease.service";
import { WorkerIdentityService } from "../../worker/src/runtime/worker-identity.service";
import { ExecutionReconcilerService } from "../../worker/src/recovery/execution-reconciler.service";
import { ShutdownStateService as WorkerShutdownState } from "../../worker/src/runtime/shutdown-state.service";
import { DeadLetterService } from "../../worker/src/dlq/dead-letter.service";
import { ExecutionsService } from "../src/executions/executions.service";
import { AuditLogsService } from "../src/audit-logs/audit-logs.service";

const prisma = new PrismaClient();

describe("operability controls", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    await cleanDatabase();
  });

  afterEach(async () => cleanDatabase());
  afterAll(async () => prisma.$disconnect());

  it("allows only one worker to acquire an execution lease and permits recovery after expiry", async () => {
    const seed = await seedExecution();
    const workerA = lease("worker-a");
    const workerB = lease("worker-b");

    expect(await workerA.acquire(seed.executionId, seed.organizationId)).toBe(true);
    expect(await workerB.acquire(seed.executionId, seed.organizationId)).toBe(false);
    const locked = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect(locked.lockedBy).toBe("worker-a");

    await workerA.heartbeat(seed.executionId);
    const heartbeat = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect(heartbeat.lastHeartbeatAt).toBeTruthy();

    await prisma.execution.update({ where: { id: seed.executionId }, data: { lockedUntil: new Date(Date.now() - 1) } });
    expect(await workerB.acquire(seed.executionId, seed.organizationId)).toBe(true);
    await expect(workerA.assertOwned(seed.executionId)).rejects.toThrow("Execution lease was lost");
  });

  it("reconciles a due retry that has no delayed job", async () => {
    const seed = await seedExecution();
    await prisma.execution.update({ where: { id: seed.executionId }, data: { status: "RETRYING" as any } });
    await prisma.stepExecution.create({
      data: {
        organizationId: seed.organizationId,
        executionId: seed.executionId,
        workflowStepId: seed.stepId,
        stepKey: "step1",
        stepType: StepType.Conditional,
        status: StepExecutionStatus.Retrying,
        attempt: 1,
        attemptCount: 1,
        maxAttempts: 2,
        nextRetryAt: new Date(Date.now() - 1),
        inputJson: {}
      }
    });
    const queue = fakeQueue();
    const reconciler = new ExecutionReconcilerService(prisma as any, new WorkerShutdownState(), queue as any);

    await reconciler.reconcile();

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].opts.jobId).toBe(`execution-${seed.executionId}`);
  });

  it("creates persistent DLQ even when publishing to BullMQ fails", async () => {
    const seed = await seedExecution();
    const service = new DeadLetterService(prisma as any, { add: async () => { throw new Error("redis down"); } } as any);

    await service.create({
      organizationId: seed.organizationId,
      executionId: seed.executionId,
      workflowId: seed.workflowId,
      workflowVersionId: seed.workflowVersionId,
      reason: "failed",
      failedStepKey: "step1"
    });

    expect(await prisma.deadLetterExecution.count({ where: { executionId: seed.executionId, resolvedAt: null } })).toBe(1);
  });

  it("manual retry creates a new execution, resolves DLQ, writes audit, and blocks a second active retry", async () => {
    const seed = await seedExecution();
    await prisma.execution.update({ where: { id: seed.executionId }, data: { status: ExecutionStatus.Failed } });
    await prisma.deadLetterExecution.create({
      data: {
        organizationId: seed.organizationId,
        executionId: seed.executionId,
        workflowId: seed.workflowId,
        workflowVersionId: seed.workflowVersionId,
        sourceQueue: "workflow-executions",
        reason: "failed"
      }
    });
    const queue = fakeQueue();
    const service = new ExecutionsService(
      prisma as any,
      { enqueueExecution: (payload: any) => queue.add("execution.run", payload, {}) } as any,
      undefined,
      undefined,
      undefined,
      new AuditLogsService(prisma as any)
    );

    const retry = await service.retry(seed.organizationId, seed.userId, seed.executionId, "try again");
    const original = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    const next = await prisma.execution.findUniqueOrThrow({ where: { id: retry.execution.id } });

    expect(original.status).toBe(ExecutionStatus.Failed);
    expect(next.retryOfExecutionId).toBe(original.id);
    expect(next.workflowVersionId).toBe(original.workflowVersionId);
    expect(next.inputJson).toEqual(original.inputJson);
    expect(await prisma.auditLog.count({ where: { action: "execution.retry_requested", resourceId: original.id } })).toBe(1);
    expect(await prisma.deadLetterExecution.count({ where: { executionId: original.id, resolution: "RETRIED" } })).toBe(1);
    await expect(service.retry(seed.organizationId, seed.userId, seed.executionId, "again")).rejects.toBeInstanceOf(ConflictException);
  });
});

function lease(id: string) {
  return new ExecutionLeaseService(prisma as any, { id } as WorkerIdentityService);
}

function fakeQueue() {
  const jobs: any[] = [];
  return {
    jobs,
    add: async (name: string, data: any, opts: any) => {
      jobs.push({ name, data, opts });
      return { id: opts.jobId };
    }
  };
}

async function seedExecution() {
  const user = await prisma.user.create({ data: { email: `${Math.random()}@example.com`, name: "User", passwordHash: "hash" } });
  const organization = await prisma.organization.create({
    data: { name: "Org", slug: `org-${Math.random()}`, members: { create: { userId: user.id, role: "owner" } } }
  });
  const workflow = await prisma.workflow.create({
    data: { organizationId: organization.id, name: "Workflow", status: "ACTIVE", createdByUserId: user.id }
  });
  const version = await prisma.workflowVersion.create({
    data: {
      organizationId: organization.id,
      workflowId: workflow.id,
      versionNumber: 1,
      status: "ACTIVE",
      definitionJson: {},
      createdByUserId: user.id,
      steps: {
        create: { organizationId: organization.id, key: "step1", name: "Step 1", type: StepType.Conditional, position: 1, configJson: {} }
      }
    },
    include: { steps: true }
  });
  const execution = await prisma.execution.create({
    data: {
      organizationId: organization.id,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      status: ExecutionStatus.Queued,
      inputJson: { trigger: { body: { ok: true } } },
      contextJson: { trigger: { body: { ok: true } }, steps: {}, metadata: {} }
    }
  });
  return {
    userId: user.id,
    organizationId: organization.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    executionId: execution.id,
    stepId: version.steps[0].id
  };
}

async function cleanDatabase() {
  await prisma.deadLetterExecution.deleteMany();
  await prisma.internalRecord.deleteMany();
  await prisma.stepExecution.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.trigger.deleteMany();
  await prisma.workflowStep.deleteMany();
  await prisma.workflow.updateMany({ data: { activeVersionId: null } });
  await prisma.workflowVersion.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.refreshTokenSession.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
