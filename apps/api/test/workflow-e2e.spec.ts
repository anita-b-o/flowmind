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

    const list = await request(app.getHttpServer()).get("/executions").set(authHeaders(user)).expect(200);
    expect(list.body.total).toBe(1);
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

async function cleanDatabase() {
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
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
