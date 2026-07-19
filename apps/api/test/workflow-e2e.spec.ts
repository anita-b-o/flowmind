import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";

const prisma = new PrismaClient();

describe("workflow webhook execution e2e", () => {
  let app: INestApplication;
  let workerContext: { close: () => Promise<void>; init: () => Promise<void> };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "test-webhook-token-pepper";

    const redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();
    await redis.quit();
    await cleanDatabase();

    const { AppModule } = await import("../src/app.module");
    const { WorkerModule } = await import("../../worker/src/worker.module");
    const apiModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiModule.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const workerModule = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerContext = workerModule as any;
    await workerContext.init();
  }, 30_000);

  afterAll(async () => {
    await workerContext?.close();
    await app?.close();
    await prisma.$disconnect();
  });

  it("runs webhook -> conditional skip -> database_record and exposes execution detail", async () => {
    const user = await register("owner@example.com", "Acme");
    const workflow = await createWorkflow(user, "Lead workflow");
    const version = await createVersion(user, workflow.id);
    const workflowDetail = await request(app.getHttpServer()).get(`/workflows/${workflow.id}`).set(authHeaders(user)).expect(200);
    expect(workflowDetail.body.versions).toHaveLength(1);
    expect(workflowDetail.body.versions[0].steps.map((step: any) => step.key)).toEqual(["webhook", "check_priority", "notify_sales", "save_lead"]);
    expect(workflowDetail.body.versions[0].createdBy.email).toBe("owner@example.com");
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const firstWebhook = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "lead-1")
      .send({ name: "Ada", email: "ada@example.com", priority: "low" })
      .expect(202);
    const executionId = firstWebhook.body.executionId;

    const detail = await waitForExecution(executionId, "COMPLETED");
    expect(detail.body.status).toBe("COMPLETED");
    expect(detail.body.steps.map((step: any) => [step.stepKey, step.status])).toEqual([
      ["check_priority", "COMPLETED"],
      ["notify_sales", "SKIPPED"],
      ["save_lead", "COMPLETED"]
    ]);

    const records = await prisma.internalRecord.findMany({ where: { executionId } });
    expect(records).toHaveLength(1);
    expect(records[0].collection).toBe("leads");
    expect(records[0].dataJson).toMatchObject({ name: "Ada", email: "ada@example.com", priority: "low" });
    expect(await prisma.internalEvent.count({ where: { eventType: "EXECUTION_COMPLETED", envelopeJson: { path: ["data", "executionId"], equals: executionId } } })).toBe(1);

    const list = await request(app.getHttpServer()).get("/executions").set(authHeaders(user)).expect(200);
    expect(list.body.items).toHaveLength(1);
  }, 30_000);

  it("does not duplicate executions or records for the same Idempotency-Key", async () => {
    const user = await register("idem@example.com", "IdemCo");
    const workflow = await createWorkflow(user, "Idempotent workflow");
    const version = await createVersion(user, workflow.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const payload = { name: "Grace", email: "grace@example.com", priority: "low" };
    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "same-key").send(payload),
      request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "same-key").send(payload)
    ]);
    expect([202, 201]).toContain(a.status);
    expect([202, 201]).toContain(b.status);
    expect(a.body.executionId).toBe(b.body.executionId);

    await waitForExecution(a.body.executionId, "COMPLETED");
    expect(await prisma.execution.count({ where: { workflowId: workflow.id } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { workflowId: workflow.id } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { workflowId: workflow.id } })).toBe(1);
  }, 30_000);

  it("runs a manual execution through BullMQ and the worker", async () => {
    const user = await register("manual-e2e@example.com", "Manual E2E");
    const workflow = await createWorkflow(user, "Manual real workflow");
    const version = await createVersion(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const created = await request(app.getHttpServer())
      .post(`/workflows/${workflow.id}/executions`)
      .set(authHeaders(user))
      .set("Idempotency-Key", "manual-e2e-1")
      .send({
        input: { trigger: { body: { name: "Lin", email: "lin@example.com", priority: "low" } }, metadata: { source: "smoke" } },
        confirmRealEffects: true
      })
      .expect(201);

    const detail = await waitForExecution(created.body.execution.id, "COMPLETED");
    expect(detail.body.publicStatus).toBe("completed");
    expect(detail.body.startedBy.display).toBe("manual-e2e");
    expect(detail.body.steps.map((step: any) => [step.stepKey, step.status])).toEqual([
      ["check_priority", "COMPLETED"],
      ["notify_sales", "SKIPPED"],
      ["save_lead", "COMPLETED"]
    ]);
    expect(await prisma.internalRecord.count({ where: { executionId: created.body.execution.id } })).toBe(1);
  }, 30_000);

  it("runs Transform OBJECT output into a following step for manual and webhook executions", async () => {
    const user = await register("transform-e2e@example.com", "Transform E2E");
    const workflow = await createWorkflow(user, "Transform workflow");
    const version = await createTransformVersion(user, workflow.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const manual = await request(app.getHttpServer())
      .post(`/workflows/${workflow.id}/executions`)
      .set(authHeaders(user))
      .set("Idempotency-Key", "transform-manual-1")
      .send({
        input: {
          trigger: {
            body: { name: "Nora", email: "nora@example.com", priority: "high" },
            headers: { authorization: "Bearer should-not-leak" }
          },
          metadata: { source: "smoke" }
        },
        confirmRealEffects: true
      })
      .expect(201);
    await expectTransformExecution(manual.body.execution.id, {
      name: "Nora",
      email: "nora@example.com",
      priority: "high",
      source: "transform"
    });

    const webhook = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "transform-webhook-1")
      .send({ name: "Vera", email: "vera@example.com", priority: "low" })
      .expect(202);
    await expectTransformExecution(webhook.body.executionId, {
      name: "Vera",
      email: "vera@example.com",
      priority: "low",
      source: "transform"
    });
  }, 30_000);

  it("runs webhook -> transform -> data store upsert/get -> conditional -> database_record", async () => {
    const user = await register("datastore-smoke@example.com", "Data Store Smoke");
    const workflow = await createWorkflow(user, "Data Store workflow");
    const store = await prisma.dataStore.create({
      data: {
        organizationId: user.organizationId,
        name: "Workflow state",
        description: "E2E smoke state"
      }
    });
    const version = await createDataStoreVersion(user, workflow.id, store.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const webhook = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "datastore-webhook-1")
      .send({ sessionId: "session-42", email: "state@example.com", count: 7 })
      .expect(202);

    const detail = await waitForExecution(webhook.body.executionId, "COMPLETED");
    expect(detail.body.steps.map((step: any) => [step.stepKey, step.status])).toEqual([
      ["shape", "COMPLETED"],
      ["save_state", "COMPLETED"],
      ["load_state", "COMPLETED"],
      ["has_state", "COMPLETED"],
      ["save_result", "COMPLETED"]
    ]);

    const record = await prisma.dataStoreRecord.findFirstOrThrow({
      where: { organizationId: user.organizationId, dataStoreId: store.id, key: "session-42", deletedAt: null }
    });
    expect(record.version).toBe(1);
    expect(record.valueJson).toMatchObject({ sessionId: "session-42", email: "state@example.com", count: 7 });

    const getStep = await prisma.stepExecution.findFirstOrThrow({
      where: { executionId: webhook.body.executionId, stepKey: "load_state" }
    });
    expect(getStep.outputJson).toMatchObject({
      found: true,
      key: "session-42",
      version: 1,
      value: { sessionId: "session-42", email: "state@example.com", count: 7 }
    });
    expect(getStep.debugJson).toMatchObject({
      dataStore: { operation: "get", found: true, key: "session-42", version: 1 }
    });
    expect(JSON.stringify(getStep.debugJson)).not.toContain("state@example.com");

    const records = await prisma.internalRecord.findMany({
      where: { executionId: webhook.body.executionId, collection: "datastore_smoke" }
    });
    expect(records).toHaveLength(1);
    expect(records[0].dataJson).toMatchObject({ sessionId: "session-42", version: 1, count: 7 });
  }, 30_000);

  it("runs webhook -> transform -> variables -> conditional -> data store upsert -> database_record on graph v2", async () => {
    const user = await register("variables-smoke@example.com", "Variables Smoke");
    const workflow = await createWorkflow(user, "Variables workflow");
    const store = await prisma.dataStore.create({
      data: {
        organizationId: user.organizationId,
        name: "Variable state",
        description: "Variables E2E smoke state"
      }
    });
    const version = await createVariableDataStoreVersion(user, workflow.id, store.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    const webhook = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "variables-webhook-1")
      .send({ sessionId: "session-99", email: "vars@example.com", count: 11 })
      .expect(202);

    const detail = await waitForExecution(webhook.body.executionId, "COMPLETED");
    expect(detail.body.steps.map((step: any) => [step.stepKey, step.status])).toEqual([
      ["shape", "COMPLETED"],
      ["set_session", "COMPLETED"],
      ["get_session", "COMPLETED"],
      ["has_session", "COMPLETED"],
      ["save_state", "COMPLETED"],
      ["save_result", "COMPLETED"]
    ]);

    const getStep = await prisma.stepExecution.findFirstOrThrow({ where: { executionId: webhook.body.executionId, stepKey: "get_session" } });
    expect(getStep.outputJson).toMatchObject({ exists: true, value: "session-99", type: "string" });
    expect(getStep.debugJson).toMatchObject({ variable: { operation: "GET", scope: "execution", name: "session_id", type: "string", exists: true } });
    expect(JSON.stringify(getStep.debugJson)).not.toContain("vars@example.com");

    const record = await prisma.dataStoreRecord.findFirstOrThrow({
      where: { organizationId: user.organizationId, dataStoreId: store.id, key: "session-99", deletedAt: null }
    });
    expect(record.valueJson).toMatchObject({ sessionId: "session-99", email: "vars@example.com", count: 11 });

    const internal = await prisma.internalRecord.findMany({ where: { executionId: webhook.body.executionId, collection: "variables_smoke" } });
    expect(internal).toHaveLength(1);
    expect(internal[0].dataJson).toMatchObject({ sessionId: "session-99", stored: true });

    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: webhook.body.executionId } });
    expect((execution.contextJson as any).__runtime).toBeUndefined();
    expect((execution.contextJson as any).variables).toEqual({});
  }, 30_000);

  it("runs a controlled FOR_EACH body with Data Store, per-item branching, and DONE once", async () => {
    const user = await register("foreach-smoke@example.com", "For Each Smoke");
    const workflow = await createWorkflow(user, "For Each workflow");
    const store = await prisma.dataStore.create({ data: { organizationId: user.organizationId, name: "Loop records", description: "FOR_EACH smoke" } });
    const version = await createForEachVersion(user, workflow.id, store.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(authHeaders(user)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "foreach-webhook-1").send({ items: [
      { id: "a", amount: 10 }, { id: "b", amount: 20 }, { id: "c", amount: 30 }
    ] }).expect(202);
    const detail = await waitForExecution(webhook.body.executionId, "COMPLETED");
    const loop = detail.body.steps.find((step: any) => step.stepKey === "loop");
    expect(loop.artifact).toMatchObject({ kind: "loop", total: 3, completed: 3, failed: 0 });
    const bodyRows = detail.body.steps.filter((step: any) => step.executionPath !== "root");
    expect(bodyRows.filter((step: any) => step.stepKey === "shape").map((step: any) => step.iterationIndex)).toEqual([0, 1, 2]);
    expect(new Set(bodyRows.map((step: any) => step.executionPath)).size).toBe(3);
    const shapeDetails = await Promise.all(bodyRows.filter((step: any) => step.stepKey === "shape").map((step: any) => request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}/steps/${step.id}`).set(authHeaders(user)).expect(200)));
    expect(shapeDetails.map((response) => ({ path: response.body.executionPath, index: response.body.iterationIndex, attempts: response.body.attempts.map((attempt: any) => [attempt.attempt, attempt.status]) }))).toEqual([
      { path: "root/loop[0]", index: 0, attempts: [[1, "COMPLETED"]] },
      { path: "root/loop[1]", index: 1, attempts: [[1, "COMPLETED"]] },
      { path: "root/loop[2]", index: 2, attempts: [[1, "COMPLETED"]] }
    ]);
    expect(await prisma.dataStoreRecord.count({ where: { organizationId: user.organizationId, dataStoreId: store.id, deletedAt: null } })).toBe(3);
    expect(await prisma.internalRecord.count({ where: { executionId: webhook.body.executionId, collection: "loop_summary" } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: webhook.body.executionId, stepKey: "count_done", executionPath: "root" } })).toBe(1);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: webhook.body.executionId } });
    expect((execution.contextJson as any).item).toBeUndefined();
    expect((execution.contextJson as any).index).toBeUndefined();
  }, 30_000);

  it("handles a structured TRY_CATCH failure, runs Finally and reaches Done once", async () => {
    const user = await register("try-smoke@example.com", "Try Smoke");
    const workflow = await createWorkflow(user, "Try workflow");
    const store = await prisma.dataStore.create({ data: { organizationId: user.organizationId, name: "Try records", description: "TRY smoke" } });
    const version = await createTryVersion(user, workflow.id, store.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(authHeaders(user)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "try-webhook-1").send({ event: "try" }).expect(202);
    const detail = await waitForExecution(webhook.body.executionId, "COMPLETED");
    const failed = detail.body.steps.find((step: any) => step.stepKey === "missing");
    expect(failed).toMatchObject({ status: "FAILED", executionPath: "root/try[guard]/body" });
    expect((await prisma.stepExecution.findFirstOrThrow({ where: { executionId: webhook.body.executionId, stepKey: "missing" } })).errorHandled).toBe(true);
    const failedDetail = await request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}/steps/${failed.id}`).set(authHeaders(user)).expect(200);
    expect(failedDetail.body).toMatchObject({ status: "FAILED", errorHandled: true, attempts: [expect.objectContaining({ attempt: 1, status: "FAILED", errorCategory: "non_retryable" })] });
    expect(JSON.stringify(failedDetail.body)).not.toMatch(/inputJson|outputJson|contextJson|debugJson|stack|must-not-leak/i);
    const catchStep = detail.body.steps.find((step: any) => step.stepKey === "caught");
    const catchDetail = await request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}/steps/${catchStep.id}`).set(authHeaders(user)).expect(200);
    expect(catchDetail.body.attempts).toEqual([expect.objectContaining({ attempt: 1, status: "COMPLETED" })]);
    expect(detail.body.steps.find((step: any) => step.stepKey === "guard").artifact).toMatchObject({ kind: "try_catch", status: "handled", errorHandled: true, bodyStatus: "failed", catchStatus: "succeeded", finallyStatus: "succeeded" });
    expect(await prisma.internalRecord.count({ where: { executionId: webhook.body.executionId, collection: "try_finally" } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: webhook.body.executionId, stepKey: "done", executionPath: "root" } })).toBe(1);
  }, 30_000);

  it("Smoke A: exposes Webhook -> FOR_EACH -> TRY_CATCH -> Data Store through Run History", async () => {
    const user = await register("run-history-a@example.com", "Run History A");
    const workflow = await createWorkflow(user, "Run History smoke A");
    const store = await prisma.dataStore.create({ data: { organizationId: user.organizationId, name: "Run History A Store" } });
    const version = await createRunHistoryAVersion(user, workflow.id, store.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(authHeaders(user)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "run-history-a").send({ authorization: "Bearer must-not-leak", items: [{ id: "ok", fail: false }, { id: "bad", fail: true }] }).expect(202);
    const detail = await waitForExecution(webhook.body.executionId, "COMPLETED");
    const history = await request(app.getHttpServer()).get(`/executions?workflowId=${workflow.id}`).set(authHeaders(user)).expect(200);
    expect(history.body.items).toEqual([expect.objectContaining({ id: webhook.body.executionId, status: "COMPLETED", triggerType: "webhook", relationship: "root" })]);
    const failed = detail.body.steps.find((step: any) => step.stepKey === "missing");
    expect(failed).toMatchObject({ status: "FAILED", errorHandled: true, iterationIndex: 1, executionPath: "root/loop[1]/try[guard]/body" });
    const successfulStore = detail.body.steps.find((step: any) => step.stepKey === "upsert" && step.iterationIndex === 0);
    expect(successfulStore).toMatchObject({ status: "COMPLETED", executionPath: "root/loop[0]/try[guard]/body" });
    const failedStep = await request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}/steps/${failed.id}`).set(authHeaders(user)).expect(200);
    expect(failedStep.body.attempts).toEqual([expect.objectContaining({ attempt: 1, status: "FAILED", errorCategory: "non_retryable" })]);
    const timeline = await request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}/timeline?limit=100`).set(authHeaders(user)).expect(200);
    expect(timeline.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ stepKey: "loop" }), expect.objectContaining({ stepKey: "guard", executionPath: "root/loop[0]" }), expect.objectContaining({ stepKey: "guard", executionPath: "root/loop[1]" }), expect.objectContaining({ stepKey: "caught", iterationIndex: 1 })]));
    const failedIndex = timeline.body.items.findIndex((item: any) => item.stepExecutionId === failed.id);
    const catchIndex = timeline.body.items.findIndex((item: any) => item.stepKey === "caught" && item.iterationIndex === 1);
    expect(failedIndex).toBeGreaterThanOrEqual(0); expect(catchIndex).toBeGreaterThan(failedIndex);
    expect(isTimelineOrdered(timeline.body.items)).toBe(true);
    expect(JSON.stringify({ detail: detail.body, timeline: timeline.body, step: failedStep.body })).not.toMatch(/Bearer must-not-leak|inputJson|outputJson|contextJson|debugJson|stack/i);
  }, 30_000);

  it("executes a published child workflow with isolated executions and explicit output", async () => {
    const user = await register("subworkflow@example.com", "SubworkflowCo");
    const child = await createWorkflow(user, "Reusable child");
    const childVersionResponse = await request(app.getHttpServer()).post(`/workflows/${child.id}/versions`).set(authHeaders(user)).send({
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "subworkflow", name: "Subworkflow Input", type: "subworkflow_trigger", config: {} },
      steps: [
        { key: "shape", name: "Shape", type: "transform", config: { mode: "OBJECT", fields: { customerId: "{{trigger.input.customerId}}", processed: true }, outputType: "OBJECT" } },
        { key: "return", name: "Return", type: "return_workflow_output", config: { output: "{{steps.shape.output}}" } }
      ],
      graph: { entryStepKey: "shape", edges: [{ from: "shape", to: "return", kind: "next" }], terminalStepKeys: ["return"] }
    });
    if (childVersionResponse.status !== 201) throw new Error(JSON.stringify(childVersionResponse.body));
    const childVersion = childVersionResponse.body;
    await request(app.getHttpServer()).patch(`/workflows/${child.id}/versions/${childVersion.id}/activate`).set(authHeaders(user)).expect(200);

    const parent = await createWorkflow(user, "Parent workflow");
    const parentVersion = await request(app.getHttpServer()).post(`/workflows/${parent.id}/versions`).set(authHeaders(user)).send({
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [
        { key: "call", name: "Call child", type: "execute_workflow", config: { workflowId: child.id, versionPolicy: "PUBLISHED", input: "{{trigger.body}}", timeoutSeconds: 30 } },
        { key: "save", name: "Save", type: "database_record", config: { collection: "subworkflow_smoke", data: { customerId: "{{steps.call.output.output.customerId}}", processed: "{{steps.call.output.output.processed}}" } } }
      ],
      graph: { entryStepKey: "call", edges: [{ from: "call", to: "save", kind: "next" }], terminalStepKeys: ["save"] }
    }).expect(201);
    await request(app.getHttpServer()).patch(`/workflows/${parent.id}/versions/${parentVersion.body.id}/activate`).set(authHeaders(user)).expect(200);
    const started = await request(app.getHttpServer()).post(`/workflows/${parent.id}/executions`).set(authHeaders(user)).send({ confirmRealEffects: true, input: { trigger: { body: { customerId: "customer-1" } } } }).expect(201);
    const detail = await waitForExecution(started.body.execution.id, "COMPLETED");
    expect(detail.body.childExecutions).toHaveLength(1);
    const childExecution = await prisma.execution.findUniqueOrThrow({ where: { id: detail.body.childExecutions[0].id }, include: { steps: true } });
    expect(childExecution).toMatchObject({ parentExecutionId: started.body.execution.id, rootExecutionId: started.body.execution.id, depth: 1, status: "COMPLETED", outputJson: { customerId: "customer-1", processed: true } });
    expect(childExecution.steps.map((step) => step.stepKey).sort()).toEqual(["return", "shape"]);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.body.execution.id }, include: { steps: true } })).steps.map((step) => step.stepKey).sort()).toEqual(["call", "save"]);
    const callStep = detail.body.steps.find((step: any) => step.stepKey === "call");
    const callDetail = await request(app.getHttpServer()).get(`/executions/${started.body.execution.id}/steps/${callStep.id}`).set(authHeaders(user)).expect(200);
    expect(callDetail.body.attempts).toEqual([expect.objectContaining({ attempt: 1, status: "COMPLETED" })]);
    expect(JSON.stringify(callDetail.body)).not.toMatch(/inputJson|outputJson|contextJson|debugJson|customer-1/i);
    const childDetail = await request(app.getHttpServer()).get(`/executions/${childExecution.id}`).set(authHeaders(user)).expect(200);
    for (const step of childDetail.body.steps) {
      const stepDetail = await request(app.getHttpServer()).get(`/executions/${childExecution.id}/steps/${step.id}`).set(authHeaders(user)).expect(200);
      expect(stepDetail.body.attempts).toEqual([expect.objectContaining({ attempt: 1, status: "COMPLETED" })]);
    }
  }, 30_000);

  it("prevents cross-tenant trigger and execution access", async () => {
    const userA = await register("tenant-a@example.com", "Tenant A");
    const userB = await register("tenant-b@example.com", "Tenant B");
    const workflow = await createWorkflow(userA, "Private workflow");
    const version = await createVersion(userA, workflow.id);
    const trigger = await createTrigger(userA, workflow.id);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/versions/${version.id}/activate`)
      .set(authHeaders(userA))
      .expect(200);
    const webhook = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "tenant-private")
      .send({ name: "Private", email: "private@example.com", priority: "low" })
      .expect(202);
    await waitForExecution(webhook.body.executionId, "COMPLETED");

    await request(app.getHttpServer()).get(`/workflows/${workflow.id}/triggers`).set(authHeaders(userB)).expect(404);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.id}/triggers/${trigger.id}/rotate`)
      .set(authHeaders(userB))
      .expect(404);
    await request(app.getHttpServer()).get(`/executions/${webhook.body.executionId}`).set(authHeaders(userB)).expect(404);
  }, 30_000);

  it("lists, compares and restores immutable workflow versions without changing the active version", async () => {
    const user = await register("version-restore@example.com", "Version Restore");
    const workflow = await createWorkflow(user, "Versioned workflow");
    const v1 = await createVersion(user, workflow.id);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${v1.id}/activate`).set(authHeaders(user)).expect(200);
    const v2Definition = JSON.parse(JSON.stringify(v1.definitionJson));
    v2Definition.steps[0].config.right = "urgent";
    const v2 = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions`).set(authHeaders(user)).send(v2Definition).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${v2.id}/activate`).set(authHeaders(user)).expect(200);

    const history = await request(app.getHttpServer()).get(`/workflows/${workflow.id}/versions?limit=2`).set(authHeaders(user)).expect(200);
    expect(history.body.items.map((item: any) => item.versionNumber)).toEqual([2, 1]);
    expect(history.body.items[0].isActive).toBe(true);
    const diff = await request(app.getHttpServer()).get(`/workflows/${workflow.id}/versions/${v1.id}/diff/${v2.id}`).set(authHeaders(user)).expect(200);
    expect(diff.body.groups.STEPS_MODIFIED[0].stepKey).toBe("check_priority");
    const preview = await request(app.getHttpServer()).get(`/workflows/${workflow.id}/versions/${v1.id}/restore-preview`).set(authHeaders(user)).expect(200);
    expect(preview.body.possible).toBe(true);
    const viewerRegistration = await register("version-viewer@example.com", "Viewer Home");
    const viewerUser = await prisma.user.findUniqueOrThrow({ where: { email: "version-viewer@example.com" } });
    await prisma.organizationMember.create({ data: { organizationId: user.organizationId, userId: viewerUser.id, role: "viewer" } });
    const viewer = { accessToken: viewerRegistration.accessToken, organizationId: user.organizationId };
    await request(app.getHttpServer()).get(`/workflows/${workflow.id}/versions/${v1.id}/diff/${v2.id}`).set(authHeaders(viewer)).expect(200);
    await request(app.getHttpServer()).get(`/workflows/${workflow.id}/versions/${v1.id}/restore-preview`).set(authHeaders(viewer)).expect(200);
    await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions/${v1.id}/restore`).set(authHeaders(viewer)).send({}).expect(403);

    const [restored, concurrentRestore] = await Promise.all([
      request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions/${v1.id}/restore`).set(authHeaders(user)).send({}),
      request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions/${v1.id}/restore`).set(authHeaders(user)).send({})
    ]);
    expect(restored.status).toBe(201); expect(concurrentRestore.status).toBe(201);
    expect([restored.body.versionNumber, concurrentRestore.body.versionNumber].sort()).toEqual([3, 4]);
    expect(restored.body).toMatchObject({ status: "DRAFT", restoredFromVersionId: v1.id });
    expect(restored.body.definitionJson).toEqual(v1.definitionJson);
    const after = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id }, include: { versions: { orderBy: { versionNumber: "asc" } } } });
    expect(after.activeVersionId).toBe(v2.id);
    expect(after.versions.map((version) => version.status)).toEqual(["ARCHIVED", "ACTIVE", "DRAFT", "DRAFT"]);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${v1.id}/activate`).set(authHeaders(user)).expect(409);
  }, 30_000);

  async function register(email: string, organizationName: string) {
    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, name: email.split("@")[0], password: "password123", organizationName })
      .expect(201);
    return {
      accessToken: response.body.accessToken as string,
      organizationId: response.body.defaultOrganizationId as string
    };
  }

  async function createWorkflow(user: TestUser, name: string) {
    const response = await request(app.getHttpServer()).post("/workflows").set(authHeaders(user)).send({ name }).expect(201);
    return response.body;
  }

  async function createVersion(user: TestUser, workflowId: string) {
    const response = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [
          {
            key: "check_priority",
            name: "Check priority",
            type: "conditional",
            config: { left: "{{trigger.body.priority}}", operator: "equals", right: "high", skipNextOnFalse: true }
          },
          {
            key: "notify_sales",
            name: "Notify sales",
            type: "email_notification",
            config: { to: "sales@example.com", subject: "High priority lead", text: "Lead: {{trigger.body.email}}" }
          },
          {
            key: "save_lead",
            name: "Save lead",
            type: "database_record",
            config: {
              collection: "leads",
              data: {
                name: "{{trigger.body.name}}",
                email: "{{trigger.body.email}}",
                priority: "{{trigger.body.priority}}"
              }
            }
          }
        ]
      })
      .expect(201);
    return response.body;
  }

  async function createTransformVersion(user: TestUser, workflowId: string) {
    const response = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [
          {
            key: "shape",
            name: "Shape lead",
            type: "transform",
            config: {
              mode: "OBJECT",
              fields: {
                name: "{{trigger.body.name}}",
                email: "{{trigger.body.email}}",
                priority: "{{trigger.body.priority}}",
                source: "transform"
              },
              outputType: "OBJECT"
            }
          },
          {
            key: "save_shape",
            name: "Save shaped lead",
            type: "database_record",
            config: {
              collection: "transformed_leads",
              data: {
                name: "{{steps.shape.output.name}}",
                email: "{{steps.shape.output.email}}",
                priority: "{{steps.shape.output.priority}}",
                source: "{{steps.shape.output.source}}"
              }
            }
          }
        ]
      })
      .expect(201);
    return response.body;
  }

  async function createForEachVersion(user: TestUser, workflowId: string, dataStoreId: string) {
    const response = await request(app.getHttpServer()).post(`/workflows/${workflowId}/versions`).set(authHeaders(user)).send({
      workflowDefinitionSchemaVersion: 2,
      expressionMode: "strict",
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [
        { key: "loop", name: "Loop", type: "for_each", config: { source: "{{trigger.body.items}}", itemVariable: "record", indexVariable: "position", mode: "SEQUENTIAL", concurrency: 1, continueOnError: false, maxItems: 100, collectResults: true, maxResults: 20 } },
        { key: "shape", name: "Shape", type: "transform", config: { mode: "OBJECT", fields: { id: "{{item.id}}", amount: "{{item.amount}}", index: "{{index}}", aliasId: "{{variables.record.id}}" }, outputType: "OBJECT" } },
        { key: "upsert", name: "Upsert", type: "data_store_upsert_record", config: { dataStoreId, key: "{{item.id}}", value: { id: "{{item.id}}", amount: "{{item.amount}}", index: "{{index}}" }, mode: "replace" } },
        { key: "route", name: "Route", type: "if", config: { left: "{{item.amount}}", operator: "equals", right: 20, trueStepKey: "high", falseStepKey: "low" } },
        { key: "high", name: "High", type: "database_record", config: { collection: "loop_high", data: { id: "{{item.id}}", index: "{{index}}" } } },
        { key: "low", name: "Low", type: "database_record", config: { collection: "loop_low", data: { id: "{{item.id}}", index: "{{index}}" } } },
        { key: "count_done", name: "Count", type: "data_store_count_records", config: { dataStoreId } },
        { key: "summary", name: "Summary", type: "database_record", config: { collection: "loop_summary", data: { total: "{{steps.loop.output.total}}", records: "{{steps.count_done.output.count}}" } } }
      ],
      graph: { entryStepKey: "loop", edges: [
        { from: "loop", to: "shape", kind: "for_each_body" },
        { from: "loop", to: "count_done", kind: "for_each_done" },
        { from: "shape", to: "upsert", kind: "next" },
        { from: "upsert", to: "route", kind: "next" },
        { from: "route", to: "high", kind: "if_true" },
        { from: "route", to: "low", kind: "if_false" },
        { from: "high", to: "count_done", kind: "next" },
        { from: "low", to: "count_done", kind: "next" },
        { from: "count_done", to: "summary", kind: "next" }
      ], terminalStepKeys: ["summary"] }
    }).expect(201);
    return response.body;
  }

  async function createTryVersion(user: TestUser, workflowId: string, dataStoreId: string) {
    const response = await request(app.getHttpServer()).post(`/workflows/${workflowId}/versions`).set(authHeaders(user)).send({
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [
        { key: "guard", name: "Guard", type: "try_catch", config: {} },
        { key: "missing", name: "Missing", type: "data_store_get_record", config: { dataStoreId, key: "missing", failIfMissing: true } },
        { key: "caught", name: "Caught", type: "set_variable", config: { scope: "execution", name: "lastErrorCategory", expression: "{{error.category}}" } },
        { key: "cleanup", name: "Cleanup", type: "database_record", config: { collection: "try_finally", data: { cleaned: true } } },
        { key: "done", name: "Done", type: "get_variable", config: { scope: "execution", name: "lastErrorCategory" } }
      ],
      graph: { entryStepKey: "guard", edges: [
        { from: "guard", to: "missing", kind: "try_body" }, { from: "guard", to: "caught", kind: "try_catch" },
        { from: "guard", to: "cleanup", kind: "try_finally" }, { from: "guard", to: "done", kind: "try_done" },
        { from: "missing", to: "cleanup", kind: "next" }, { from: "caught", to: "cleanup", kind: "next" }, { from: "cleanup", to: "done", kind: "next" }
      ], terminalStepKeys: ["done"] }
    }).expect(201);
    return response.body;
  }

  async function createRunHistoryAVersion(user: TestUser, workflowId: string, dataStoreId: string) {
    const response = await request(app.getHttpServer()).post(`/workflows/${workflowId}/versions`).set(authHeaders(user)).send({
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [
        { key: "loop", name: "Loop", type: "for_each", config: { source: "{{trigger.body.items}}", mode: "SEQUENTIAL", continueOnError: false, maxItems: 10 } },
        { key: "guard", name: "Guard", type: "try_catch", config: {} },
        { key: "route", name: "Route", type: "if", config: { left: "{{item.fail}}", operator: "equals", right: true, trueStepKey: "missing", falseStepKey: "upsert" } },
        { key: "missing", name: "Controlled failure", type: "data_store_get_record", config: { dataStoreId, key: "missing", failIfMissing: true } },
        { key: "upsert", name: "Persist success", type: "data_store_upsert_record", config: { dataStoreId, key: "{{item.id}}", value: { ok: true }, mode: "replace" } },
        { key: "caught", name: "Catch", type: "set_variable", config: { scope: "execution", name: "handled", value: true } },
        { key: "cleanup", name: "Finally", type: "transform", config: { mode: "OBJECT", fields: { cleaned: true }, outputType: "OBJECT" } },
        { key: "iteration_done", name: "Iteration done", type: "transform", config: { mode: "OBJECT", fields: { done: true }, outputType: "OBJECT" } },
        { key: "done", name: "Done", type: "data_store_count_records", config: { dataStoreId } }
      ],
      graph: { entryStepKey: "loop", edges: [
        { from: "loop", to: "guard", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" },
        { from: "guard", to: "route", kind: "try_body" }, { from: "guard", to: "caught", kind: "try_catch" },
        { from: "guard", to: "cleanup", kind: "try_finally" }, { from: "guard", to: "iteration_done", kind: "try_done" },
        { from: "route", to: "missing", kind: "if_true" }, { from: "route", to: "upsert", kind: "if_false" },
        { from: "missing", to: "cleanup", kind: "next" }, { from: "upsert", to: "cleanup", kind: "next" }, { from: "caught", to: "cleanup", kind: "next" },
        { from: "cleanup", to: "iteration_done", kind: "next" },
        { from: "iteration_done", to: "done", kind: "next" }
      ], terminalStepKeys: ["done"] }
    });
    if (response.status !== 201) throw new Error(`Run History Smoke A definition rejected: ${JSON.stringify(response.body)}`);
    return response.body;
  }

  async function createDataStoreVersion(user: TestUser, workflowId: string, dataStoreId: string) {
    const response = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [
          {
            key: "shape",
            name: "Shape state",
            type: "transform",
            config: {
              mode: "OBJECT",
              fields: {
                sessionId: "{{trigger.body.sessionId}}",
                email: "{{trigger.body.email}}",
                count: "{{trigger.body.count}}"
              },
              outputType: "OBJECT"
            }
          },
          {
            key: "save_state",
            name: "Save state",
            type: "data_store_upsert_record",
            config: {
              dataStoreId,
              key: "{{steps.shape.output.sessionId}}",
              value: "{{steps.shape.output}}",
              metadata: { source: "webhook-smoke" },
              mode: "replace"
            }
          },
          {
            key: "load_state",
            name: "Load state",
            type: "data_store_get_record",
            config: {
              dataStoreId,
              key: "{{steps.shape.output.sessionId}}",
              failIfMissing: true
            }
          },
          {
            key: "has_state",
            name: "Has state",
            type: "conditional",
            config: {
              left: "{{steps.load_state.output.found}}",
              operator: "equals",
              right: true,
              skipNextOnFalse: true
            }
          },
          {
            key: "save_result",
            name: "Save result",
            type: "database_record",
            config: {
              collection: "datastore_smoke",
              data: {
                sessionId: "{{steps.load_state.output.key}}",
                version: "{{steps.load_state.output.version}}",
                count: "{{steps.load_state.output.value.count}}"
              }
            }
          }
        ]
      })
      .expect(201);
    return response.body;
  }

  async function createVariableDataStoreVersion(user: TestUser, workflowId: string, dataStoreId: string) {
    const response = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        workflowDefinitionSchemaVersion: 2,
        workflowVariables: { initial: "published" },
        environmentVariables: { region: "test" },
        graph: {
          entryStepKey: "shape",
          edges: [
            { from: "shape", to: "set_session", kind: "next" },
            { from: "set_session", to: "get_session", kind: "next" },
            { from: "get_session", to: "has_session", kind: "next" },
            { from: "has_session", to: "save_state", kind: "next" },
            { from: "save_state", to: "save_result", kind: "next" }
          ],
          terminalStepKeys: ["save_result"]
        },
        steps: [
          {
            key: "shape",
            name: "Shape state",
            type: "transform",
            config: {
              mode: "OBJECT",
              fields: {
                sessionId: "{{trigger.body.sessionId}}",
                email: "{{trigger.body.email}}",
                count: "{{trigger.body.count}}"
              },
              outputType: "OBJECT"
            }
          },
          {
            key: "set_session",
            name: "Set session variable",
            type: "set_variable",
            config: { scope: "execution", name: "session_id", expression: "{{steps.shape.output.sessionId}}" }
          },
          {
            key: "get_session",
            name: "Get session variable",
            type: "get_variable",
            config: { scope: "execution", name: "session_id" }
          },
          {
            key: "has_session",
            name: "Has session",
            type: "conditional",
            config: { left: "{{variables.session_id}}", operator: "equals", right: "session-99", skipNextOnFalse: true }
          },
          {
            key: "save_state",
            name: "Save variable state",
            type: "data_store_upsert_record",
            config: {
              dataStoreId,
              key: "{{variables.session_id}}",
              value: {
                sessionId: "{{variables.session_id}}",
                email: "{{steps.shape.output.email}}",
                count: "{{steps.shape.output.count}}"
              },
              metadata: { source: "variable-smoke" },
              mode: "replace"
            }
          },
          {
            key: "save_result",
            name: "Save result",
            type: "database_record",
            config: {
              collection: "variables_smoke",
              data: {
                sessionId: "{{variables.session_id}}",
                stored: "{{steps.save_state.output.created}}"
              }
            }
          }
        ]
      })
      .expect(201);
    return response.body;
  }

  async function createTrigger(user: TestUser, workflowId: string) {
    const response = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/triggers`)
      .set(authHeaders(user))
      .send({})
      .expect(201);
    expect(response.body.token).toBeDefined();
    expect(response.body.webhookUrl).toContain(response.body.token);
    return response.body;
  }

  async function waitForExecution(executionId: string, status: string) {
    let lastBody: any;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(app.getHttpServer()).get(`/executions/${executionId}`).set(lastAuthHeaders()).expect(200);
      lastBody = response.body;
      if (response.body.status === status) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Execution ${executionId} did not reach ${status}; last status=${lastBody?.status}; error=${JSON.stringify(lastBody?.errorJson ?? lastBody?.error ?? null)}`);
  }

  async function expectTransformExecution(executionId: string, expected: Record<string, string>) {
    const detail = await waitForExecution(executionId, "COMPLETED");
    expect(detail.body.steps.map((step: any) => [step.stepKey, step.status])).toEqual([
      ["shape", "COMPLETED"],
      ["save_shape", "COMPLETED"]
    ]);

    const transformStep = await prisma.stepExecution.findFirstOrThrow({ where: { executionId, stepKey: "shape" } });
    expect(transformStep.outputJson).toEqual(expected);

    const records = await prisma.internalRecord.findMany({
      where: { executionId, collection: "transformed_leads" },
      orderBy: { createdAt: "asc" }
    });
    expect(records).toHaveLength(1);
    expect(records[0].dataJson).toEqual(expected);
  }
});

type TestUser = { accessToken: string; organizationId: string };
let lastUser: TestUser;

function authHeaders(user: TestUser) {
  lastUser = user;
  return {
    authorization: `Bearer ${user.accessToken}`,
    "x-organization-id": user.organizationId
  };
}

function lastAuthHeaders() {
  return authHeaders(lastUser);
}

function isTimelineOrdered(items: any[]) {
  const priority: Record<string, number> = { event_trigger: 0, execution_created: 10, execution_started: 20, step_attempt: 30, wait: 40, approval_requested: 50, approval_decided: 60, subworkflow: 70, notification: 80, dead_letter: 90, execution_completed: 100 };
  return items.every((item, index) => { if (index === 0) return true; const previous = items[index - 1]; return previous.timestamp < item.timestamp || (previous.timestamp === item.timestamp && ((priority[previous.type] ?? 50) < (priority[item.type] ?? 50) || ((priority[previous.type] ?? 50) === (priority[item.type] ?? 50) && previous.id <= item.id))); });
}

async function cleanDatabase() {
  await prisma.internalRecord.deleteMany();
  await prisma.stepExecution.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.internalEventDelivery.deleteMany();
  await prisma.internalEvent.deleteMany();
  await prisma.internalEventChain.deleteMany();
  await prisma.trigger.deleteMany();
  await prisma.workflowStep.deleteMany();
  await prisma.workflow.updateMany({ data: { activeVersionId: null } });
  await prisma.workflowVersion.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.refreshTokenSession.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
