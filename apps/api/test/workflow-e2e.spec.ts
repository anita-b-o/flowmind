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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(app.getHttpServer()).get(`/executions/${executionId}`).set(lastAuthHeaders()).expect(200);
      if (response.body.status === status) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Execution ${executionId} did not reach ${status}`);
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
