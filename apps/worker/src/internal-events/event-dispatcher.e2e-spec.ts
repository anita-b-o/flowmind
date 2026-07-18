import { PrismaClient } from "@prisma/client";
import { InternalEventEmitter } from "./internal-event-emitter.service";
import { EventDispatcherService } from "./event-dispatcher.service";
import { ExecutionReconcilerService } from "../recovery/execution-reconciler.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";

const prisma = new PrismaClient();

describe("durable internal event dispatcher", () => {
  beforeEach(async () => clean());
  afterAll(async () => { await clean(); await prisma.$disconnect(); });

  it("materializes one execution per event and trigger and pins the active version", async () => {
    const organization = await prisma.organization.create({ data: { name: "Events", slug: `events-${Date.now()}` } });
    const user = await prisma.user.create({ data: { email: `events-${Date.now()}@example.com`, name: "Events", passwordHash: "hash" } });
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Target", status: "ACTIVE", createdByUserId: user.id } });
    const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, versionNumber: 1, status: "ACTIVE", createdByUserId: user.id, definitionJson: { trigger: { key: "trigger", name: "Trigger", type: "webhook_trigger", position: 0, config: {} }, steps: [] } } });
    await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } });
    const trigger = await prisma.trigger.create({ data: { organizationId: organization.id, workflowId: workflow.id, type: "event", eventType: "DATA_STORE_RECORD_CREATED", configJson: { name: "Created", filters: { dataStoreId: "store-1", keyPrefix: "customers/" } } } });
    const emitter = new InternalEventEmitter();
    const envelope = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: organization.id, type: "DATA_STORE_RECORD_CREATED", source: { type: "api" }, subject: { type: "data_store_record", id: "record-1" }, data: { dataStoreId: "store-1", recordId: "record-1", key: "customers/1", version: 1, value: { name: "Ada" } } }));
    const jobs: any[] = [];
    const queue = { add: async (...args: any[]) => { jobs.push(args); return { id: args[2].jobId }; } } as any;
    const dispatcher = new EventDispatcherService(prisma as any, { id: "test-dispatcher-1" } as any, { isShuttingDown: () => false } as any, queue);
    const concurrent = new EventDispatcherService(prisma as any, { id: "test-dispatcher-2" } as any, { isShuttingDown: () => false } as any, queue);
    await Promise.all([dispatcher.dispatch(), concurrent.dispatch()]); await dispatcher.dispatch();
    const deliveries = await prisma.internalEventDelivery.findMany({ where: { internalEventId: envelope!.id }, include: { execution: true } });
    expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ triggerId: trigger.id, status: "MATERIALIZED" });
    expect(deliveries[0].execution).toMatchObject({ workflowVersionId: version.id, organizationId: organization.id, status: "QUEUED", eventRootId: envelope!.id });
    expect((deliveries[0].execution!.inputJson as any).trigger.event.data).toMatchObject({ key: "customers/1" });
    expect(jobs).toHaveLength(1);
    expect(await prisma.execution.count({ where: { eventDeliveryId: deliveries[0].id } })).toBe(1);
  });

  it("suppresses a descendant beyond the configured depth without rolling back the chain", async () => {
    const organization = await prisma.organization.create({ data: { name: "Loop", slug: `loop-${Date.now()}` } });
    const emitter = new InternalEventEmitter();
    const root = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: organization.id, type: "DATA_STORE_RECORD_CREATED", source: { type: "api" }, subject: { type: "data_store_record", id: "r1" }, data: { dataStoreId: "s1", recordId: "r1", key: "k", version: 1 } }));
    const suppressed = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: organization.id, type: "DATA_STORE_RECORD_UPDATED", source: { type: "execution", id: "e1" }, subject: { type: "data_store_record", id: "r1" }, data: { dataStoreId: "s1", recordId: "r1", key: "k", version: 2 }, causality: { rootEventId: root!.id, causationId: root!.id, depth: 8, correlationId: root!.correlationId } }));
    expect(suppressed).toBeNull(); expect(await prisma.internalEvent.count({ where: { rootEventId: root!.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: "internal_event.suppressed" } })).toBe(1);
  });

  it("keeps a materialized execution recoverable when Redis enqueue is unavailable", async () => {
    const { organization, workflow } = await target("Redis recovery");
    await prisma.trigger.create({ data: { organizationId: organization.id, workflowId: workflow.id, type: "event", eventType: "EXECUTION_COMPLETED", configJson: { name: "Completed", filters: {} } } });
    const emitter = new InternalEventEmitter();
    const envelope = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: organization.id, type: "EXECUTION_COMPLETED", source: { type: "execution", id: "source-execution" }, subject: { type: "execution", id: "source-execution" }, data: { executionId: "source-execution", workflowId: workflow.id, workflowVersionId: workflow.activeVersionId!, status: "COMPLETED", origin: "manual", startedAt: null, completedAt: new Date().toISOString(), durationMs: null, parentExecutionId: null } }));
    const unavailableQueue = { add: jest.fn(async () => { throw Object.assign(new Error("Redis unavailable"), { code: "ECONNREFUSED" }); }) } as any;
    const dispatcher = new EventDispatcherService(prisma as any, { id: "redis-down" } as any, { isShuttingDown: () => false } as any, unavailableQueue);
    await dispatcher.dispatch();
    const delivery = await prisma.internalEventDelivery.findFirstOrThrow({ where: { internalEventId: envelope!.id }, include: { execution: true } });
    expect(delivery).toMatchObject({ status: "MATERIALIZED", enqueuedAt: null });
    expect(delivery.execution).toMatchObject({ status: "QUEUED" });
    const recoveredJobs: any[] = [];
    const recoveredQueue = { close: jest.fn(), add: jest.fn(async (...args: any[]) => { recoveredJobs.push(args); return { id: args[2].jobId }; }) } as any;
    const reconciler = new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), recoveredQueue);
    await reconciler.reconcile();
    expect(recoveredJobs.filter((job) => job[1].executionId === delivery.executionId)).toHaveLength(1);
    expect(await prisma.execution.count({ where: { eventDeliveryId: delivery.id } })).toBe(1);
  });

  it("never matches an event against another organization's trigger", async () => {
    const left = await target("Tenant left"); const right = await target("Tenant right");
    const leftTrigger = await prisma.trigger.create({ data: { organizationId: left.organization.id, workflowId: left.workflow.id, type: "event", eventType: "APPROVAL_APPROVED", configJson: { name: "Left", filters: {} } } });
    await prisma.trigger.create({ data: { organizationId: right.organization.id, workflowId: right.workflow.id, type: "event", eventType: "APPROVAL_APPROVED", configJson: { name: "Right", filters: {} } } });
    const emitter = new InternalEventEmitter();
    const event = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: left.organization.id, type: "APPROVAL_APPROVED", source: { type: "approval", id: "approval-1" }, subject: { type: "approval_request", id: "approval-1" }, data: { approvalId: "approval-1", executionId: "execution-1", workflowId: left.workflow.id, workflowVersionId: left.workflow.activeVersionId!, stepKey: "approval", outcome: "APPROVED", requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString() } }));
    const dispatcher = new EventDispatcherService(prisma as any, { id: "tenant-dispatcher" } as any, { isShuttingDown: () => false } as any, { add: jest.fn(async () => ({ id: "job" })) } as any);
    await dispatcher.dispatch();
    const deliveries = await prisma.internalEventDelivery.findMany({ where: { internalEventId: event!.id } });
    expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ organizationId: left.organization.id, triggerId: leftTrigger.id });
  });
});

async function target(name: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const organization = await prisma.organization.create({ data: { name, slug: `event-${suffix}` } });
  const user = await prisma.user.create({ data: { email: `event-${suffix}@example.com`, name, passwordHash: "hash" } });
  const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name, status: "ACTIVE", createdByUserId: user.id } });
  const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, versionNumber: 1, status: "ACTIVE", createdByUserId: user.id, definitionJson: { trigger: { key: "trigger", name: "Trigger", type: "webhook_trigger", position: 0, config: {} }, steps: [] } } });
  return { organization, workflow: await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } }) };
}

async function clean() {
  await prisma.execution.deleteMany(); await prisma.internalEventDelivery.deleteMany(); await prisma.internalEvent.deleteMany(); await prisma.internalEventChain.deleteMany();
  await prisma.trigger.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany();
  await prisma.auditLog.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany();
}
