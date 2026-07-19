import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";

const prisma = new PrismaClient();

describe("internal event workflow flows", () => {
  let app: INestApplication;
  let workerContext: { init: () => Promise<void>; close: () => Promise<void> };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "test-webhook-token-pepper";
    process.env.INTERNAL_EVENT_POLL_INTERVAL_MS = "100";
    const redis = new Redis(process.env.REDIS_URL); await redis.flushdb(); await redis.quit();
    await cleanDatabase();
    const { AppModule } = await import("../src/app.module");
    const { WorkerModule } = await import("../../worker/src/worker.module");
    const apiModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiModule.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init(); activeServer = app.getHttpServer();
    const workerModule = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerContext = workerModule as any; await workerContext.init();
  }, 30_000);

  afterAll(async () => {
    await workerContext?.close(); await app?.close(); await cleanDatabase(); await prisma.$disconnect();
    delete process.env.INTERNAL_EVENT_POLL_INTERVAL_MS;
  });

  it("cuts A -> Data Store -> A at the configured causal depth and remains operational", async () => {
    const owner = await createOwner("loop-self");
    const store = await prisma.dataStore.create({ data: { organizationId: owner.organizationId, name: "Self loop" } });
    const workflowA = await createWorkflow(owner, "Loop A", dataStoreDefinition(store.id, "self/key"));
    await createEventTrigger(owner, workflowA.id, "DATA_STORE_RECORD_CREATED", { dataStoreId: store.id, keyPrefix: "self/" });
    await createEventTrigger(owner, workflowA.id, "DATA_STORE_RECORD_UPDATED", { dataStoreId: store.id, keyPrefix: "self/" });
    const initialId = await start(owner, workflowA.id);

    await waitFor(async () => (await prisma.auditLog.count({ where: { organizationId: owner.organizationId, action: "internal_event.suppressed", metadataJson: { path: ["reason"], equals: "depth" } } })) >= 1);
    await waitForStable(owner.organizationId);

    const executions = await prisma.execution.findMany({ where: { organizationId: owner.organizationId, workflowId: workflowA.id }, orderBy: { createdAt: "asc" } });
    const root = await prisma.internalEvent.findFirstOrThrow({ where: { organizationId: owner.organizationId, eventType: "DATA_STORE_RECORD_CREATED", depth: 0 }, orderBy: { occurredAt: "asc" } });
    const events = await prisma.internalEvent.findMany({ where: { organizationId: owner.organizationId, rootEventId: root.id }, orderBy: [{ depth: "asc" }, { occurredAt: "asc" }] });
    const deliveries = await prisma.internalEventDelivery.findMany({ where: { organizationId: owner.organizationId, internalEvent: { rootEventId: root.id } } });
    expect(executions).toHaveLength(10); expect(executions[0].id).toBe(initialId);
    expect(events).toHaveLength(17); expect(deliveries).toHaveLength(9);
    expect(new Set(events.map((event) => event.rootEventId))).toEqual(new Set([root.id]));
    expect(new Set(events.map((event) => event.correlationId))).toEqual(new Set([root.correlationId]));
    expect(events.filter((event) => event.eventType.startsWith("DATA_STORE")).map((event) => event.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(executions.slice(1).map((execution) => execution.eventDepth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await prisma.internalEventChain.findUniqueOrThrow({ where: { rootEventId: root.id } })).toMatchObject({ eventCount: 17 });
    expect(await prisma.internalEventDelivery.count({ where: { organizationId: owner.organizationId, status: "PENDING" } })).toBe(0);
    expect(await prisma.execution.count({ where: { organizationId: owner.organizationId, status: { in: ["QUEUED", "RUNNING", "RETRYING"] } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: owner.organizationId, action: "internal_event.suppressed", metadataJson: { path: ["reason"], equals: "depth" } } })).toBe(2);

    const unrelatedAt = new Date();
    const unrelated = await prisma.$transaction((tx) => tx.internalEvent.create({ data: { organizationId: owner.organizationId, eventType: "APPROVAL_APPROVED", schemaVersion: 1, envelopeJson: { id: "unrelated-event", schemaVersion: 1, type: "APPROVAL_APPROVED", organizationId: owner.organizationId, occurredAt: unrelatedAt.toISOString(), source: { type: "test" }, subject: { type: "approval", id: "none" }, correlationId: "unrelated-correlation", rootEventId: "unrelated-event", causationId: null, depth: 0, data: {} }, occurredAt: unrelatedAt, rootEventId: "unrelated-event", correlationId: "unrelated-correlation" } }));
    await waitFor(async () => (await prisma.internalEvent.findUnique({ where: { id: unrelated.id } }))?.status === "PROCESSED");
  }, 45_000);

  it("cuts A -> B -> A with one delivery and execution per causal data event", async () => {
    const owner = await createOwner("loop-pair");
    const store = await prisma.dataStore.create({ data: { organizationId: owner.organizationId, name: "Pair loop" } });
    const workflowA = await createWorkflow(owner, "Pair A", dataStoreDefinition(store.id, "a/key"));
    const workflowB = await createWorkflow(owner, "Pair B", dataStoreDefinition(store.id, "b/key"));
    await createEventTrigger(owner, workflowB.id, "DATA_STORE_RECORD_CREATED", { dataStoreId: store.id, keyPrefix: "a/" });
    await createEventTrigger(owner, workflowB.id, "DATA_STORE_RECORD_UPDATED", { dataStoreId: store.id, keyPrefix: "a/" });
    await createEventTrigger(owner, workflowA.id, "DATA_STORE_RECORD_CREATED", { dataStoreId: store.id, keyPrefix: "b/" });
    await createEventTrigger(owner, workflowA.id, "DATA_STORE_RECORD_UPDATED", { dataStoreId: store.id, keyPrefix: "b/" });
    await start(owner, workflowA.id);

    await waitFor(async () => (await prisma.auditLog.count({ where: { organizationId: owner.organizationId, action: "internal_event.suppressed", metadataJson: { path: ["reason"], equals: "depth" } } })) >= 1);
    await waitForStable(owner.organizationId);
    const root = await prisma.internalEvent.findFirstOrThrow({ where: { organizationId: owner.organizationId, eventType: "DATA_STORE_RECORD_CREATED", depth: 0 }, orderBy: { occurredAt: "asc" } });
    const dataEvents = await prisma.internalEvent.findMany({ where: { organizationId: owner.organizationId, rootEventId: root.id, eventType: { startsWith: "DATA_STORE" } }, orderBy: { depth: "asc" } });
    const deliveries = await prisma.internalEventDelivery.findMany({ where: { organizationId: owner.organizationId, internalEvent: { rootEventId: root.id } }, include: { execution: true, internalEvent: true } });
    const executions = await prisma.execution.findMany({ where: { organizationId: owner.organizationId, workflowId: { in: [workflowA.id, workflowB.id] } }, orderBy: { createdAt: "asc" } });
    expect(executions).toHaveLength(10); expect(dataEvents).toHaveLength(9); expect(deliveries).toHaveLength(9);
    expect(dataEvents.map((event) => event.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dataEvents.slice(1).map((event) => event.causationId)).toEqual(dataEvents.slice(0, -1).map((event) => event.id));
    expect(new Set(dataEvents.map((event) => event.rootEventId))).toEqual(new Set([root.id]));
    expect(new Set(dataEvents.map((event) => event.correlationId))).toEqual(new Set([root.correlationId]));
    expect(new Set(executions.map((execution) => execution.organizationId))).toEqual(new Set([owner.organizationId]));
    expect(deliveries.every((delivery) => delivery.status === "MATERIALIZED" && delivery.execution)).toBe(true);
    expect(new Set(deliveries.map((delivery) => `${delivery.internalEventId}:${delivery.triggerId}`)).size).toBe(9);
    expect(await prisma.internalEventChain.findUniqueOrThrow({ where: { rootEventId: root.id } })).toMatchObject({ eventCount: 17 });
    expect(await prisma.internalEventDelivery.count({ where: { organizationId: owner.organizationId, status: "PENDING" } })).toBe(0);
  }, 45_000);

  it("Smoke D: dispatches one sanitized EXECUTION_FAILED event to B and exposes safe notification metadata", async () => {
    const owner = await createOwner("failed-event");
    const store = await prisma.dataStore.create({ data: { organizationId: owner.organizationId, name: "Missing records" } });
    const workflowA = await createWorkflow(owner, "Failing A", failingDefinition(store.id));
    const workflowB = await createWorkflow(owner, "Failure handler B", recordDefinition("failure_handler"));
    await createEventTrigger(owner, workflowB.id, "EXECUTION_FAILED", { workflowId: workflowA.id });
    const connection = await prisma.connection.create({ data: { organizationId: owner.organizationId, name: "Smoke SMTP", type: "smtp", status: "ACTIVE", configJson: {}, createdByUserId: owner.userId } });
    await prisma.notificationRule.create({ data: { organizationId: owner.organizationId, eventType: "EXECUTION_FAILED", connectionId: connection.id, recipientConfigJson: { kind: "EMAILS", emails: ["secret-recipient@example.com"] }, filtersJson: { workflowId: workflowA.id, status: "FAILED" }, templateKey: "workflow.failed" } });
    const failedId = await start(owner, workflowA.id, { trigger: { body: { password: "must-not-leak" } } });
    await waitFor(async () => (await prisma.execution.findUnique({ where: { id: failedId } }))?.status === "FAILED");
    await waitFor(async () => (await prisma.execution.count({ where: { organizationId: owner.organizationId, workflowId: workflowB.id, status: "COMPLETED" } })) === 1);

    const failedEvent = await prisma.internalEvent.findFirstOrThrow({ where: { organizationId: owner.organizationId, eventType: "EXECUTION_FAILED", envelopeJson: { path: ["data", "executionId"], equals: failedId } } });
    const envelope = failedEvent.envelopeJson as any;
    expect(JSON.stringify(envelope)).not.toMatch(/password|must-not-leak|stack|authorization|secret/i);
    expect(envelope.data).toMatchObject({ executionId: failedId, workflowId: workflowA.id, status: "FAILED", origin: "manual" });
    const delivery = await prisma.internalEventDelivery.findFirstOrThrow({ where: { internalEventId: failedEvent.id }, include: { execution: true } });
    expect(delivery).toMatchObject({ status: "MATERIALIZED" }); expect(delivery.execution).toMatchObject({ workflowId: workflowB.id, status: "COMPLETED" });
    expect((delivery.execution!.inputJson as any).trigger.event.id).toBe(failedEvent.id);
    expect(await prisma.execution.count({ where: { eventDeliveryId: delivery.id } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: delivery.executionId!, collection: "failure_handler" } })).toBe(1);
    await waitFor(async () => (await prisma.notificationRequest.count({ where: { organizationId: owner.organizationId, sourceEventId: failedEvent.id } })) === 1);
    const history = await request(app.getHttpServer()).get(`/executions?workflowId=${workflowA.id}&failed=true`).set(headers(owner)).expect(200);
    expect(history.body.items).toEqual([expect.objectContaining({ id: failedId, status: "FAILED", failedStep: expect.objectContaining({ stepKey: "missing", errorCategory: "non_retryable" }) })]);
    const failedDetail = await request(app.getHttpServer()).get(`/executions/${failedId}`).set(headers(owner)).expect(200);
    expect(failedDetail.body.notifications).toEqual([expect.objectContaining({ type: "EXECUTION_FAILED", channel: "EMAIL", status: expect.any(String), attempts: expect.any(Number) })]);
    expect(JSON.stringify(failedDetail.body)).not.toMatch(/must-not-leak|secret-recipient|providerMessageId|payloadJson|inputJson|contextJson|outputJson|debugJson|stack/i);
    const triggeredDetail = await request(app.getHttpServer()).get(`/executions/${delivery.executionId}`).set(headers(owner)).expect(200);
    expect(triggeredDetail.body.eventCausality).toMatchObject({ eventType: "EXECUTION_FAILED", rootEventId: failedEvent.rootEventId, causationId: failedEvent.causationId, correlationId: failedEvent.correlationId, depth: failedEvent.depth });

    const completed = await createWorkflow(owner, "Completed A", graphDefinition([{ key: "save", name: "Save", type: "database_record", config: { collection: "completed_source", data: { completed: true } } }]));
    const completedId = await start(owner, completed.id); await waitFor(async () => (await prisma.execution.findUnique({ where: { id: completedId } }))?.status === "COMPLETED");
    await waitForStable(owner.organizationId);
    expect(await prisma.internalEventDelivery.count({ where: { organizationId: owner.organizationId, internalEvent: { eventType: "EXECUTION_COMPLETED" } } })).toBe(0);
    expect(await prisma.execution.count({ where: { organizationId: owner.organizationId, workflowId: workflowB.id } })).toBe(1);
  }, 30_000);

  it("Smoke C: materializes Event Trigger -> EXECUTE_WORKFLOW -> child with public causality and tree", async () => {
    const owner = await createOwner("run-history-event-child");
    const child = await createWorkflow(owner, "Run History child", subworkflowDefinition());
    const parent = await createWorkflow(owner, "Run History event parent", executeWorkflowDefinition(child.id));
    await createEventTrigger(owner, parent.id, "APPROVAL_APPROVED", {});
    const eventId = `run-history-${Date.now()}`;
    const occurredAt = new Date();
    await prisma.internalEvent.create({ data: { id: eventId, organizationId: owner.organizationId, eventType: "APPROVAL_APPROVED", schemaVersion: 1, envelopeJson: { id: eventId, schemaVersion: 1, type: "APPROVAL_APPROVED", organizationId: owner.organizationId, occurredAt: occurredAt.toISOString(), source: { type: "smoke" }, subject: { type: "approval", id: "safe" }, correlationId: "run-history-correlation", rootEventId: eventId, causationId: "run-history-cause", depth: 0, data: {} }, occurredAt, rootEventId: eventId, causationId: "run-history-cause", correlationId: "run-history-correlation", depth: 0 } });
    await waitFor(async () => (await prisma.execution.count({ where: { organizationId: owner.organizationId, workflowId: parent.id, status: "COMPLETED" } })) === 1);
    const parentExecution = await prisma.execution.findFirstOrThrow({ where: { organizationId: owner.organizationId, workflowId: parent.id } });
    const detail = await request(app.getHttpServer()).get(`/executions/${parentExecution.id}`).set(headers(owner)).expect(200);
    expect(detail.body.eventCausality).toMatchObject({ eventType: "APPROVAL_APPROVED", rootEventId: eventId, causationId: "run-history-cause", correlationId: "run-history-correlation", depth: 0 });
    const tree = await request(app.getHttpServer()).get(`/executions/${parentExecution.id}/tree`).set(headers(owner)).expect(200);
    expect(tree.body).toMatchObject({ id: parentExecution.id, depth: 0, status: "COMPLETED", children: [expect.objectContaining({ parentExecutionId: parentExecution.id, rootExecutionId: parentExecution.id, depth: 1, status: "COMPLETED" })] });
    const call = detail.body.steps.find((step: any) => step.stepKey === "call");
    const callDetail = await request(app.getHttpServer()).get(`/executions/${parentExecution.id}/steps/${call.id}`).set(headers(owner)).expect(200);
    expect(callDetail.body).toMatchObject({ attempts: [expect.objectContaining({ attempt: 1, status: "COMPLETED" })], artifact: expect.objectContaining({ kind: "subworkflow" }) });
    expect(JSON.stringify(callDetail.body)).not.toMatch(/inputJson|outputJson|contextJson|debugJson|event-secret/i);
    const timeline = await request(app.getHttpServer()).get(`/executions/${parentExecution.id}/timeline`).set(headers(owner)).expect(200);
    expect(timeline.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "event_trigger" }), expect.objectContaining({ type: "subworkflow", relatedExecutionId: tree.body.children[0].id })]));
  }, 30_000);
});

type Owner = { organizationId: string; userId: string; token: string };
async function createOwner(prefix: string): Promise<Owner> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const organization = await prisma.organization.create({ data: { name: prefix, slug: `${prefix}-${suffix}` } });
  const user = await prisma.user.create({ data: { email: `${prefix}-${suffix}@example.com`, name: prefix, passwordHash: "hash" } });
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id, role: "owner" } });
  const token = await new JwtService().signAsync({ sub: user.id, email: user.email, tokenType: "access", jti: user.id }, { secret: process.env.JWT_ACCESS_SECRET });
  return { organizationId: organization.id, userId: user.id, token };
}
function headers(owner: Owner) { return { authorization: `Bearer ${owner.token}`, "x-organization-id": owner.organizationId }; }
async function createWorkflow(owner: Owner, name: string, definition: any) {
  const workflow = (await request(appServer()).post("/workflows").set(headers(owner)).send({ name }).expect(201)).body;
  const version = (await request(appServer()).post(`/workflows/${workflow.id}/versions`).set(headers(owner)).send(definition).expect(201)).body;
  await request(appServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(headers(owner)).expect(200); return workflow;
}
async function createEventTrigger(owner: Owner, workflowId: string, eventType: string, filters: Record<string, unknown>) { await request(appServer()).post(`/workflows/${workflowId}/triggers/event`).set(headers(owner)).send({ name: `${eventType}-${Math.random()}`, eventType, filters }).expect(201); }
async function start(owner: Owner, workflowId: string, input: any = { trigger: { body: {} } }) { const response = await request(appServer()).post(`/workflows/${workflowId}/executions`).set(headers(owner)).send({ confirmRealEffects: true, input }).expect(201); return response.body.execution.id as string; }
let activeServer: any;
function appServer() { return activeServer; }

function dataStoreDefinition(dataStoreId: string, key: string) { return graphDefinition([{ key: "mutate", name: "Mutate", type: "data_store_upsert_record", config: { dataStoreId, key, value: { touched: true }, mode: "replace" } }]); }
function failingDefinition(dataStoreId: string) { return graphDefinition([{ key: "missing", name: "Missing", type: "data_store_get_record", config: { dataStoreId, key: "absent", failIfMissing: true } }]); }
function recordDefinition(collection: string) { return graphDefinition([{ key: "save", name: "Save", type: "database_record", config: { collection, data: { handled: true, eventType: "{{trigger.event.type}}" } } }]); }
function subworkflowDefinition() { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "subworkflow", name: "Subworkflow", type: "subworkflow_trigger", config: {} }, steps: [{ key: "shape", name: "Shape", type: "transform", config: { mode: "OBJECT", fields: { handled: true }, outputType: "OBJECT" } }, { key: "return", name: "Return", type: "return_workflow_output", config: { output: "{{steps.shape.output}}" } }], graph: { entryStepKey: "shape", edges: [{ from: "shape", to: "return", kind: "next" }], terminalStepKeys: ["return"] } }; }
function executeWorkflowDefinition(workflowId: string) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "entry", name: "Event entry", type: "webhook_trigger", config: {} }, steps: [{ key: "call", name: "Call child", type: "execute_workflow", config: { workflowId, versionPolicy: "PUBLISHED", input: { safe: true }, timeoutSeconds: 30 } }], graph: { entryStepKey: "call", edges: [], terminalStepKeys: ["call"] } }; }
function graphDefinition(steps: any[]) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "entry", name: "Entry", type: "webhook_trigger", config: {} }, steps, graph: { entryStepKey: steps[0].key, edges: [], terminalStepKeys: [steps[0].key] } }; }

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Timed out waiting for durable condition"); }
async function waitForStable(organizationId: string) { let previous = ""; let stable = 0; await waitFor(async () => { const counts = await Promise.all([prisma.execution.count({ where: { organizationId } }), prisma.internalEvent.count({ where: { organizationId } }), prisma.internalEventDelivery.count({ where: { organizationId } }), prisma.internalEvent.count({ where: { organizationId, status: { in: ["PENDING", "PROCESSING"] } } })]); const current = counts.join(":"); stable = current === previous && counts[3] === 0 ? stable + 1 : 0; previous = current; return stable >= 3; }); }

async function cleanDatabase() {
  await prisma.notificationDelivery.deleteMany(); await prisma.notificationRequest.deleteMany(); await prisma.notificationRule.deleteMany(); await prisma.approvalRequest.deleteMany(); await prisma.dataStoreRecord.deleteMany(); await prisma.dataStore.deleteMany(); await prisma.internalRecord.deleteMany(); await prisma.stepExecution.deleteMany(); await prisma.execution.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.internalEventDelivery.deleteMany(); await prisma.internalEvent.deleteMany(); await prisma.internalEventChain.deleteMany(); await prisma.trigger.deleteMany(); await prisma.workflowStep.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany(); await prisma.connection.deleteMany(); await prisma.auditLog.deleteMany(); await prisma.refreshTokenSession.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany();
}
