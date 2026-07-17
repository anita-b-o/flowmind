import { PrismaClient } from "@prisma/client";
import { ScheduledCronService } from "../src/triggers/scheduled-cron.service";
import { ScheduledTriggersService } from "../src/triggers/scheduled-triggers.service";
import { AuditLogsService } from "../src/audit-logs/audit-logs.service";

const prisma = new PrismaClient();

describe("scheduled triggers", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    await cleanDatabase();
  });

  afterEach(async () => cleanDatabase());
  afterAll(async () => prisma.$disconnect());

  it("creates, pauses, resumes, disables and deletes a scheduled trigger", async () => {
    const seed = await seedWorkflow();
    const queue = fakeQueue();
    const service = serviceWith(queue);

    const created = await service.create(seed.organizationId, seed.userId, seed.workflowId, {
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      metadata: { source: "test" }
    });
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).toBeTruthy();
    expect(queue.schedulers).toHaveLength(1);

    const paused = await service.setPaused(seed.organizationId, seed.userId, seed.workflowId, created.id, true);
    expect(paused.paused).toBe(true);
    expect(queue.removed).toContain(`scheduled-trigger:${created.id}`);

    const resumed = await service.setPaused(seed.organizationId, seed.userId, seed.workflowId, created.id, false);
    expect(resumed.paused).toBe(false);

    const disabled = await service.setEnabled(seed.organizationId, seed.userId, seed.workflowId, created.id, false);
    expect(disabled.enabled).toBe(false);

    await service.delete(seed.organizationId, seed.userId, seed.workflowId, created.id);
    expect(await prisma.trigger.count({ where: { id: created.id, deletedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { resourceId: created.id, action: { startsWith: "scheduled.trigger" } } })).toBeGreaterThan(0);
  });

  it("creates one immutable execution per scheduled instant and prevents duplicates", async () => {
    const seed = await seedWorkflow();
    const queue = fakeQueue();
    const service = serviceWith(queue);
    const scheduledFor = new Date(Date.now() - 60_000);
    const trigger = await prisma.trigger.create({
      data: {
        organizationId: seed.organizationId,
        workflowId: seed.workflowId,
        type: "scheduled",
        configJson: {},
        cron: "*/5 * * * *",
        timezone: "UTC",
        nextRunAt: scheduledFor
      }
    });

    const first = await service.runDue(trigger.id, seed.organizationId);
    await prisma.execution.updateMany({ where: { scheduledTriggerId: trigger.id }, data: { status: "COMPLETED" as any, completedAt: new Date() } });
    await prisma.trigger.update({ where: { id: trigger.id }, data: { nextRunAt: scheduledFor } });

    await expect(service.runDue(trigger.id, seed.organizationId)).rejects.toThrow("Scheduled execution already exists for this run");
    expect(first).toHaveProperty("executionId");
    expect(await prisma.execution.count({ where: { scheduledTriggerId: trigger.id, scheduledFor } })).toBe(1);
    const execution = await prisma.execution.findFirstOrThrow({ where: { scheduledTriggerId: trigger.id } });
    expect(execution.workflowVersionId).toBe(seed.workflowVersionId);
    expect(queue.executions).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "scheduled.execution.created", resourceId: execution.id } })).toBe(1);
  });

  it("does not create an execution when the workflow has no active version", async () => {
    const seed = await seedWorkflow();
    const service = serviceWith(fakeQueue());
    await prisma.workflow.update({ where: { id: seed.workflowId }, data: { activeVersionId: null } });
    const trigger = await prisma.trigger.create({
      data: {
        organizationId: seed.organizationId,
        workflowId: seed.workflowId,
        type: "scheduled",
        configJson: {},
        cron: "0 9 * * *",
        timezone: "UTC",
        nextRunAt: new Date(Date.now() - 60_000)
      }
    });

    const result = await service.runDue(trigger.id, seed.organizationId);

    expect(result).toMatchObject({ skipped: true, reason: "inactive_workflow" });
    expect(await prisma.execution.count({ where: { scheduledTriggerId: trigger.id } })).toBe(0);
  });
});

function serviceWith(queue: ReturnType<typeof fakeQueue>) {
  return new ScheduledTriggersService(prisma as any, queue as any, new ScheduledCronService(), new AuditLogsService(prisma as any), metrics() as any);
}

function fakeQueue() {
  const queue = {
    schedulers: [] as any[],
    removed: [] as string[],
    executions: [] as any[],
    upsertScheduledTriggerScheduler: async (input: any) => {
      queue.schedulers.push(input);
      return { id: `scheduled-trigger:${input.triggerId}` };
    },
    removeScheduledTriggerScheduler: async (triggerId: string) => {
      queue.removed.push(`scheduled-trigger:${triggerId}`);
      return true;
    },
    enqueueExecution: async (payload: any) => {
      queue.executions.push(payload);
      return { id: `execution-${payload.executionId}` };
    }
  };
  return queue;
}

function metrics() {
  return {
    recordScheduledExecutionCreated: jest.fn(),
    recordScheduledLatency: jest.fn(),
    recordScheduledSchedulerLatency: jest.fn(),
    recordScheduledDuplicatePrevented: jest.fn(),
    recordScheduledMissed: jest.fn(),
    recordScheduledRecovered: jest.fn(),
    recordScheduledTriggers: jest.fn(),
    recordEnqueueFailure: jest.fn()
  };
}

async function seedWorkflow() {
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
      createdByUserId: user.id
    }
  });
  await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } });
  return { userId: user.id, organizationId: organization.id, workflowId: workflow.id, workflowVersionId: version.id };
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
