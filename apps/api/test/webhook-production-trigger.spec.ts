import { createHmac } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();

describe("production webhook trigger", () => {
  let app: INestApplication;
  let user: TestUser;
  let workflowId: string;
  let versionId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL = "https://api.flowmind.test";
    process.env.WEBHOOK_TOKEN_PEPPER = "production-webhook-token-pepper";
    process.env.WEBHOOK_RATE_LIMIT_DISABLED = "true";

    const redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();
    await redis.quit();
    await cleanDatabase();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    user = await register();
    const workflow = await request(app.getHttpServer()).post("/workflows").set(authHeaders(user)).send({ name: "Production webhook" }).expect(201);
    workflowId = workflow.body.id;
    const version = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        workflowDefinitionSchemaVersion: 2,
        graph: { entryStepKey: "save", edges: [], terminalStepKeys: ["save"] },
        steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "leads", data: { name: "{{trigger.body.name}}", method: "{{trigger.method}}" } } }]
      })
      .expect(201);
    versionId = version.body.id;
    await request(app.getHttpServer()).patch(`/workflows/${workflowId}/versions/${versionId}/activate`).set(authHeaders(user)).expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env.WEBHOOK_RATE_LIMIT_DISABLED;
  });

  it("creates a trigger with a one-time token, stores only a hash, and accepts the new public URL", async () => {
    const created = await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).send({}).expect(201);
    expect(created.body.webhookUrl).toBe(`https://api.flowmind.test/webhooks/${created.body.id}/${created.body.token}`);
    expect(created.body.tokenAvailable).toBe(true);

    const persisted = await prisma.trigger.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(persisted.tokenHash).not.toContain(created.body.token);
    expect(persisted.tokenPreview).toContain("...");

    const list = await request(app.getHttpServer()).get(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(list.body[0].maskedWebhookUrl).toContain(created.body.id);

    const accepted = await request(app.getHttpServer())
      .post(`/webhooks/${created.body.id}/${created.body.token}`)
      .set("Idempotency-Key", "prod-new-url")
      .send({ name: "Ada" })
      .expect(202);
    expect(accepted.body.executionId).toBeTruthy();

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { triggerId: created.body.id } });
    expect(event.method).toBe("POST");
    expect(event.payloadJson).toEqual({ name: "Ada" });
  });

  it("rejects reused idempotency keys with different payloads and returns existing execution for same payload", async () => {
    const created = await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).send({ name: "Idem" }).expect(201);
    const first = await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${created.body.token}`).set("Idempotency-Key", "same-key").send({ name: "Ada" }).expect(202);
    const replay = await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${created.body.token}`).set("Idempotency-Key", "same-key").send({ name: "Ada" }).expect(202);
    expect(replay.body.executionId).toBe(first.body.executionId);
    await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${created.body.token}`).set("Idempotency-Key", "same-key").send({ name: "Grace" }).expect(409);
  });

  it("rotates, disables, enables, and soft deletes without exposing old tokens", async () => {
    const created = await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).send({ name: "Lifecycle" }).expect(201);
    const rotated = await request(app.getHttpServer()).patch(`/workflows/${workflowId}/triggers/${created.body.id}/rotate`).set(authHeaders(user)).expect(200);
    await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${created.body.token}`).send({ name: "Old" }).expect(401);
    await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${rotated.body.token}`).send({ name: "New" }).expect(202);

    await request(app.getHttpServer()).patch(`/workflows/${workflowId}/triggers/${created.body.id}/disable`).set(authHeaders(user)).expect(200);
    await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${rotated.body.token}`).send({ name: "Disabled" }).expect(401);
    await request(app.getHttpServer()).patch(`/workflows/${workflowId}/triggers/${created.body.id}/enable`).set(authHeaders(user)).expect(200);
    await request(app.getHttpServer()).delete(`/workflows/${workflowId}/triggers/${created.body.id}`).set(authHeaders(user)).expect(200);
    await request(app.getHttpServer()).post(`/webhooks/${created.body.id}/${rotated.body.token}`).send({ name: "Deleted" }).expect(401);

    const deleted = await prisma.trigger.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(deleted.deletedAt).toBeTruthy();
  });

  it("validates HMAC signature and rejects replayed nonce", async () => {
    const created = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/triggers`)
      .set(authHeaders(user))
      .send({ name: "Signed", signature: { enabled: true } })
      .expect(201);
    expect(created.body.signatureSecret).toBeTruthy();
    const body = { name: "Signed Ada" };
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = "nonce-1";
    const signature = createHmac("sha256", created.body.signatureSecret).update(`${timestamp}.${nonce}.${raw}`).digest("hex");
    await request(app.getHttpServer())
      .post(`/webhooks/${created.body.id}/${created.body.token}`)
      .set("x-flowmind-timestamp", timestamp)
      .set("x-flowmind-nonce", nonce)
      .set("x-flowmind-signature", `sha256=${signature}`)
      .send(body)
      .expect(202);
    await request(app.getHttpServer())
      .post(`/webhooks/${created.body.id}/${created.body.token}`)
      .set("x-flowmind-timestamp", timestamp)
      .set("x-flowmind-nonce", nonce)
      .set("x-flowmind-signature", `sha256=${signature}`)
      .send(body)
      .expect(401);
  });

  async function register() {
    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: "prod-webhook@example.com", name: "prod webhook", password: "password123", organizationName: "ProdWebhookOrg" })
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
  await prisma.webhookReplayNonce.deleteMany();
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
