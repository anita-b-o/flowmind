import { PrismaClient } from "@prisma/client";
import { InternalEventEmitter } from "../internal-events/internal-event-emitter.service";
import { NotificationMaterializerService } from "./notification-materializer.service";
import { NotificationProcessor } from "./notification.processor";
import { NotificationReconcilerService } from "./notification-reconciler.service";
import { NotificationTemplates } from "./notification-templates";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { ApprovalHandler } from "../engine/handlers/approval.handler";
import { StepType } from "@automation/shared-types";
import { EventDispatcherService } from "../internal-events/event-dispatcher.service";

const prisma = new PrismaClient();
const prefix = `notification-smoke-${Date.now()}`;

describe("durable notification flow", () => {
  afterEach(async () => { const organizations = await prisma.organization.findMany({ where: { slug: { startsWith: prefix } }, select: { id: true } }); await prisma.organization.deleteMany({ where: { id: { in: organizations.map((row) => row.id) } } }); });
  afterAll(async () => prisma.$disconnect());

  it("materializes an execution failure once under concurrent/repeated matching and sends once under duplicate BullMQ delivery", async () => {
    const fixture = await executionFixture("failed", "EXECUTION_FAILED", true);
    const queue = { add: jest.fn(async () => ({ id: "job" })) } as any;
    const materializerA = new NotificationMaterializerService(prisma as any, queue);
    const materializerB = new NotificationMaterializerService(prisma as any, queue);
    await Promise.all([materializerA.materialize(fixture.event, fixture.envelope), materializerB.materialize(fixture.event, fixture.envelope)]);
    await materializerA.materialize(fixture.event, fixture.envelope);
    expect(await prisma.notificationRequest.count({ where: { organizationId: fixture.organizationId } })).toBe(1);
    expect(await prisma.notificationDelivery.count({ where: { organizationId: fixture.organizationId } })).toBe(1);
    const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    expect(request.payloadJson).toMatchObject({ workflowName: "Failure workflow", status: "FAILED", link: expect.stringContaining(`/executions/${fixture.executionId}`) });
    expect(JSON.stringify(request.payloadJson)).not.toMatch(/outputJson|authorization|secret|stack/i);
    const send = jest.fn(async () => ({ messageId: "fake-message" })); const processorA = processor(send, "worker-a"); const processorB = processor(send, "worker-b");
    await Promise.all([processorA.deliver(request.id), processorB.deliver(request.id)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.notificationRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: "SENT" });
    expect(await prisma.notificationDelivery.findUnique({ where: { notificationRequestId: request.id } })).toMatchObject({ status: "SENT", attempts: 1, providerMessageId: "fake-message" });
  });

  it("recovers a missing job and an expired lease without creating another logical delivery", async () => {
    const fixture = await executionFixture("recovery", "EXECUTION_COMPLETED", true); const unavailable = { add: jest.fn(async () => { throw new Error("redis unavailable"); }) } as any;
    await new NotificationMaterializerService(prisma as any, unavailable).materialize(fixture.event, fixture.envelope);
    const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    await prisma.notificationRequest.update({ where: { id: request.id }, data: { status: "PROCESSING", lockedBy: "dead-worker", lockedUntil: new Date(Date.now() - 1_000) } });
    await prisma.notificationDelivery.update({ where: { notificationRequestId: request.id }, data: { status: "PROCESSING" } });
    const recoveredQueue = { add: jest.fn(async () => ({ id: "recovered" })) } as any; const reconciler = new NotificationReconcilerService(prisma as any, new ShutdownStateService(), recoveredQueue);
    await reconciler.reconcile();
    expect(recoveredQueue.add).toHaveBeenCalledWith("notification.deliver", { requestId: request.id }, expect.objectContaining({ attempts: 1 }));
    expect(await prisma.notificationRequest.count({ where: { organizationId: fixture.organizationId } })).toBe(1);
    expect(await prisma.notificationDelivery.count({ where: { organizationId: fixture.organizationId } })).toBe(1);
  });

  it("retries a temporary provider failure and then reaches SENT with one request/delivery", async () => {
    const fixture = await executionFixture("retry", "EXECUTION_FAILED", true); await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(fixture.event, fixture.envelope);
    const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: fixture.organizationId } }); let calls = 0;
    const send = jest.fn(async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); return { messageId: "eventual-success" }; }); const instance = processor(send, "retry-worker");
    await instance.deliver(request.id); expect(await prisma.notificationRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: "FAILED" });
    await prisma.notificationRequest.update({ where: { id: request.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } }); await instance.deliver(request.id);
    expect(send).toHaveBeenCalledTimes(2); expect(await prisma.notificationRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: "SENT" }); expect(await prisma.notificationDelivery.findUnique({ where: { notificationRequestId: request.id } })).toMatchObject({ status: "SENT", attempts: 2 });
  });

  it("dead-letters a permanent provider rejection with safe audit/metrics dimensions", async () => {
    const fixture = await executionFixture("dead", "EXECUTION_FAILED", true); await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(fixture.event, fixture.envelope); const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: fixture.organizationId } });
    const send = jest.fn(async () => { throw Object.assign(new Error("password=top-secret smtp://user:pass@host"), { responseCode: 550 }); }); await processor(send, "dead-worker").deliver(request.id);
    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({ where: { notificationRequestId: request.id } }); expect(delivery).toMatchObject({ status: "DEAD_LETTER", attempts: 1, errorCategory: "PROVIDER_REJECTED", errorMessageSafe: "SMTP rejected the message (550)" }); expect(JSON.stringify(delivery)).not.toContain("top-secret");
    expect(await prisma.auditLog.count({ where: { organizationId: fixture.organizationId, action: "notification.dead_letter", resourceId: request.id } })).toBe(1);
  });

  it("does not materialize disabled or cross-tenant rules", async () => {
    const left = await executionFixture("tenant-left", "EXECUTION_COMPLETED", false); const right = await executionFixture("tenant-right", "EXECUTION_COMPLETED", true);
    await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(left.event, left.envelope);
    expect(await prisma.notificationRequest.count({ where: { organizationId: left.organizationId } })).toBe(0); expect(await prisma.notificationRequest.count({ where: { organizationId: right.organizationId } })).toBe(0);
  });

  it("sends an enabled workflow completion rule and never persists workflow output", async () => { const fixture = await executionFixture("completed", "EXECUTION_COMPLETED", true); await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(fixture.event, fixture.envelope); const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: fixture.organizationId } }); expect(request.payloadJson).toMatchObject({ status: "COMPLETED", link: expect.stringContaining(`/executions/${fixture.executionId}`) }); expect(JSON.stringify(request.payloadJson)).not.toMatch(/must-not-leak|outputJson|secret/i); const send = jest.fn(async () => ({ messageId: "completed-message" })); await processor(send, "completed-worker").deliver(request.id); expect(send).toHaveBeenCalledTimes(1); expect(await prisma.notificationDelivery.findUnique({ where: { notificationRequestId: request.id } })).toMatchObject({ status: "SENT", attempts: 1 }); });

  it("runs ApprovalRequest through APPROVAL_REQUESTED to one safe email delivery", async () => {
    const suffix = `${prefix}-approval-${Math.random().toString(16).slice(2)}`; const organization = await prisma.organization.create({ data: { name: "Approval", slug: suffix } }); const user = await prisma.user.create({ data: { email: `${suffix}@example.com`, name: "Approver", passwordHash: "hash" } });
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Approval workflow", status: "ACTIVE", createdByUserId: user.id } }); const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, versionNumber: 1, status: "ACTIVE", createdByUserId: user.id, definitionJson: { steps: [] } } }); const execution = await prisma.execution.create({ data: { organizationId: organization.id, workflowId: workflow.id, workflowVersionId: version.id, status: "RUNNING", inputJson: {}, contextJson: {}, correlationId: "approval-smoke" } }); const stepExecution = await prisma.stepExecution.create({ data: { organizationId: organization.id, executionId: execution.id, stepKey: "approve", stepType: "approval", status: "RUNNING", inputJson: {} } });
    const connection = await prisma.connection.create({ data: { organizationId: organization.id, name: "SMTP", type: "smtp", status: "ACTIVE", configJson: {}, createdByUserId: user.id } }); await prisma.notificationRule.create({ data: { organizationId: organization.id, eventType: "APPROVAL_REQUESTED", connectionId: connection.id, recipientConfigJson: { kind: "EMAILS", emails: ["approver@example.com"] }, filtersJson: { workflowId: workflow.id }, templateKey: "approval.requested" } });
    const handler = new ApprovalHandler(prisma as any, undefined, new InternalEventEmitter()); const step: any = { key: "approve", name: "Approve", type: StepType.Approval, position: 1, config: { title: "Review payout <script>x</script>", description: "Safe context", allowedRoles: ["editor"] } }; const context: any = { metadata: { runtime: { organizationId: organization.id, executionId: execution.id, stepExecutionId: stepExecution.id, executionPath: "root" } } };
    await handler.execute(step, context); await handler.execute(step, context);
    const events = await prisma.internalEvent.findMany({ where: { organizationId: organization.id, eventType: "APPROVAL_REQUESTED" } }); expect(events).toHaveLength(1);
    const envelope = events[0].envelopeJson as any; const materializer = new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any); await materializer.materialize(events[0], envelope); await materializer.materialize(events[0], envelope);
    const request = await prisma.notificationRequest.findFirstOrThrow({ where: { organizationId: organization.id } }); const send = jest.fn(async (input) => { expect(input.text).toContain(`/approvals/${envelope.data.approvalId}`); expect(input.html).not.toContain("<script>"); expect(JSON.stringify(input)).not.toMatch(/authorization|top-secret/i); return { messageId: "approval-message" }; }); await processor(send, "approval-worker").deliver(request.id);
    expect(send).toHaveBeenCalledTimes(1); expect(await prisma.notificationRequest.count({ where: { organizationId: organization.id } })).toBe(1); expect(await prisma.notificationDelivery.findUnique({ where: { notificationRequestId: request.id } })).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("materializes the real chain-depth diagnostic event without a direct email hook", async () => {
    const fixture = await diagnosticFixture("depth", "EVENT_CHAIN_DEPTH_EXCEEDED"); const emitter = new InternalEventEmitter(); const root = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: fixture.organizationId, type: "DATA_STORE_RECORD_CREATED", source: { type: "api" }, subject: { type: "record", id: "r" }, data: { dataStoreId: "s", recordId: "r", key: "k", version: 1 } })); await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: fixture.organizationId, type: "DATA_STORE_RECORD_UPDATED", source: { type: "execution" }, subject: { type: "record", id: "r" }, data: { dataStoreId: "s", recordId: "r", key: "k", version: 2 }, causality: { rootEventId: root!.id, causationId: root!.id, depth: 8, correlationId: root!.correlationId } }));
    const diagnostic = await prisma.internalEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventType: "EVENT_CHAIN_DEPTH_EXCEEDED" } }); await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(diagnostic, diagnostic.envelopeJson as any); expect(await prisma.notificationRequest.count({ where: { organizationId: fixture.organizationId, type: "EVENT_CHAIN_DEPTH_EXCEEDED" } })).toBe(1);
  });

  it("materializes EVENT_TRIGGER_FAILED only after the event dispatcher reaches terminal failure", async () => {
    const fixture = await diagnosticFixture("trigger", "EVENT_TRIGGER_FAILED"); const emitter = new InternalEventEmitter(); const envelope = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: fixture.organizationId, type: "EXECUTION_FAILED", source: { type: "execution", id: "failed-execution" }, subject: { type: "execution", id: "failed-execution" }, data: { executionId: "failed-execution", workflowId: "workflow", workflowVersionId: null, status: "FAILED", origin: "manual", startedAt: null, completedAt: new Date().toISOString(), durationMs: null, parentExecutionId: null } })); await prisma.internalEvent.update({ where: { id: envelope!.id }, data: { attempts: 10 } }); const dispatcher = new EventDispatcherService(prisma as any, { id: "event-worker" } as any, { isShuttingDown: () => false } as any, { add: jest.fn() } as any); await (dispatcher as any).fail(envelope!.id, Object.assign(new Error("database"), { code: "P1001" }));
    const diagnostic = await prisma.internalEvent.findFirstOrThrow({ where: { organizationId: fixture.organizationId, eventType: "EVENT_TRIGGER_FAILED" } }); await new NotificationMaterializerService(prisma as any, { add: jest.fn(async () => ({ id: "job" })) } as any).materialize(diagnostic, diagnostic.envelopeJson as any); expect(await prisma.notificationRequest.count({ where: { organizationId: fixture.organizationId, type: "EVENT_TRIGGER_FAILED" } })).toBe(1);
  });
});

function processor(send: jest.Mock, workerId: string) { return new NotificationProcessor(prisma as any, { id: workerId } as any, { resolveSmtp: jest.fn(async () => ({ id: "smtp", type: "SMTP", host: "localhost", port: 1025, secure: false, username: "user", password: "not-used", fromEmail: "flowmind@example.com" })) } as any, new NotificationTemplates(), { send } as any); }

async function executionFixture(name: string, type: "EXECUTION_FAILED" | "EXECUTION_COMPLETED", enabled: boolean) {
  const suffix = `${prefix}-${name}-${Math.random().toString(16).slice(2)}`; const organization = await prisma.organization.create({ data: { name, slug: suffix } }); const user = await prisma.user.create({ data: { email: `${suffix}@example.com`, name, passwordHash: "hash" } });
  const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: name === "failed" ? "Failure workflow" : `${name} workflow`, status: "ACTIVE", createdByUserId: user.id } }); const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, versionNumber: 1, status: "ACTIVE", createdByUserId: user.id, definitionJson: { trigger: { key: "trigger" }, steps: [] } } }); await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } });
  const execution = await prisma.execution.create({ data: { organizationId: organization.id, workflowId: workflow.id, workflowVersionId: version.id, status: type === "EXECUTION_FAILED" ? "FAILED" : "COMPLETED", inputJson: {}, contextJson: {}, outputJson: { secret: "must-not-leak" }, errorJson: type === "EXECUTION_FAILED" ? { stack: "must-not-leak" } : undefined, completedAt: new Date() } });
  const connection = await prisma.connection.create({ data: { organizationId: organization.id, name: "SMTP", type: "smtp", status: "ACTIVE", configJson: {}, createdByUserId: user.id } }); await prisma.notificationRule.create({ data: { organizationId: organization.id, eventType: type, enabled, connectionId: connection.id, recipientConfigJson: { kind: "EMAILS", emails: ["ops@example.com"] }, filtersJson: { workflowId: workflow.id, status: type === "EXECUTION_FAILED" ? "FAILED" : "COMPLETED" }, templateKey: type === "EXECUTION_FAILED" ? "workflow.failed" : "workflow.completed" } });
  const emitter = new InternalEventEmitter(); const envelope = await prisma.$transaction((tx) => emitter.emit(tx, { organizationId: organization.id, type, source: { type: "execution", id: execution.id }, subject: { type: "execution", id: execution.id }, data: { executionId: execution.id, workflowId: workflow.id, workflowVersionId: version.id, status: type === "EXECUTION_FAILED" ? "FAILED" : "COMPLETED", origin: "manual", startedAt: null, completedAt: new Date().toISOString(), durationMs: null, parentExecutionId: null } })); const event = await prisma.internalEvent.findUniqueOrThrow({ where: { id: envelope!.id } }); return { organizationId: organization.id, executionId: execution.id, envelope: envelope! as any, event };
}

async function diagnosticFixture(name: string, eventType: "EVENT_CHAIN_DEPTH_EXCEEDED" | "EVENT_TRIGGER_FAILED") { const suffix = `${prefix}-${name}-${Math.random().toString(16).slice(2)}`; const organization = await prisma.organization.create({ data: { name, slug: suffix } }); const user = await prisma.user.create({ data: { email: `${suffix}@example.com`, name, passwordHash: "hash" } }); const connection = await prisma.connection.create({ data: { organizationId: organization.id, name: "SMTP", type: "smtp", status: "ACTIVE", configJson: {}, createdByUserId: user.id } }); await prisma.notificationRule.create({ data: { organizationId: organization.id, eventType, connectionId: connection.id, recipientConfigJson: { kind: "EMAILS", emails: ["ops@example.com"] }, filtersJson: {}, templateKey: eventType === "EVENT_TRIGGER_FAILED" ? "event-trigger.failed" : "event-chain.depth-exceeded" } }); return { organizationId: organization.id }; }
