import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();

describe("webhook limits and validation", () => {
  let app: INestApplication;
  let user: TestUser;
  let workflowId: string;
  let versionId: string;
  let token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER = "limits-webhook-token-pepper";
    process.env.WEBHOOK_PAYLOAD_MAX_BYTES = "128";
    process.env.WEBHOOK_RATE_LIMIT_MAX = "2";
    process.env.WEBHOOK_BURST_LIMIT_MAX = "50";

    const redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();
    await redis.quit();
    await cleanDatabase();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    user = await register();
    const workflow = await request(app.getHttpServer()).post("/workflows").set(authHeaders(user)).send({ name: "Limits" }).expect(201);
    workflowId = workflow.body.id;
    const version = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "leads", data: { name: "{{trigger.body.name}}" } } }]
      })
      .expect(201);
    versionId = version.body.id;
    const trigger = await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).send({}).expect(201);
    token = trigger.body.token;
    await request(app.getHttpServer()).patch(`/workflows/${workflowId}/versions/${versionId}/activate`).set(authHeaders(user)).expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env.WEBHOOK_PAYLOAD_MAX_BYTES;
    delete process.env.WEBHOOK_RATE_LIMIT_MAX;
    delete process.env.WEBHOOK_BURST_LIMIT_MAX;
  });

  it("accepts an allowed JSON payload", async () => {
    await request(app.getHttpServer())
      .post(`/webhooks/${workflowId}/${token}`)
      .set("Idempotency-Key", "allowed")
      .send({ name: "Ada" })
      .expect(202);
  });

  it("rejects oversized payloads", async () => {
    await request(app.getHttpServer())
      .post(`/webhooks/${workflowId}/${token}`)
      .set("Idempotency-Key", "too-large")
      .send({ name: "x".repeat(200) })
      .expect(413);
  });

  it("rejects unsupported content types", async () => {
    await request(app.getHttpServer())
      .post(`/webhooks/${workflowId}/${token}`)
      .set("Content-Type", "text/plain")
      .send("plain text")
      .expect(415);
  });

  it("rate limits webhook requests after the configured max", async () => {
    await request(app.getHttpServer())
      .post(`/webhooks/${workflowId}/${token}`)
      .set("Idempotency-Key", "rate-1")
      .send({ name: "First" })
      .expect(202);
    await request(app.getHttpServer())
      .post(`/webhooks/${workflowId}/${token}`)
      .set("Idempotency-Key", "rate-2")
      .send({ name: "Second" })
      .expect(429);
  });

  it("rejects invalid trigger token and inactive workflows", async () => {
    process.env.WEBHOOK_RATE_LIMIT_DISABLED = "true";
    await request(app.getHttpServer()).post(`/webhooks/${workflowId}/wrong-token`).send({ name: "Bad" }).expect(401);
    await prisma.workflow.update({ where: { id: workflowId }, data: { status: "PAUSED" } });
    await request(app.getHttpServer()).post(`/webhooks/${workflowId}/${token}`).send({ name: "Paused" }).expect(404);
    delete process.env.WEBHOOK_RATE_LIMIT_DISABLED;
  });

  async function register() {
    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: "limits@example.com", name: "limits", password: "password123", organizationName: "LimitsOrg" })
      .expect(201);
    return { accessToken: response.body.accessToken as string, organizationId: response.body.defaultOrganizationId as string };
  }
});

type TestUser = { accessToken: string; organizationId: string };

function authHeaders(user: TestUser) {
  return {
    authorization: `Bearer ${user.accessToken}`,
    "x-organization-id": user.organizationId
  };
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
