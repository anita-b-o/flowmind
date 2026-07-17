import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { QueueService } from "../src/queues/queue.service";

const prisma = new PrismaClient();

describe("webhook enqueue failure", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "test-webhook-token-pepper";
    await cleanDatabase();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(QueueService)
      .useValue({ enqueueExecution: jest.fn().mockRejectedValue(new Error("redis unavailable")) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("does not mark idempotency as enqueued when BullMQ enqueue fails", async () => {
    const user = await register();
    const workflow = await request(app.getHttpServer())
      .post("/workflows")
      .set(authHeaders(user))
      .send({ name: "Failure workflow" })
      .expect(201);
    const version = await request(app.getHttpServer())
      .post(`/workflows/${workflow.body.id}/versions`)
      .set(authHeaders(user))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "leads", data: { name: "Ada" } } }]
      })
      .expect(201);
    const trigger = await request(app.getHttpServer())
      .post(`/workflows/${workflow.body.id}/triggers`)
      .set(authHeaders(user))
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.body.id}/versions/${version.body.id}/activate`)
      .set(authHeaders(user))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/webhooks/${workflow.body.id}/${trigger.body.token}`)
      .set("Idempotency-Key", "enqueue-fails")
      .send({ name: "Ada" })
      .expect(503);

    const idempotency = await prisma.idempotencyKey.findFirstOrThrow({
      where: { organizationId: user.organizationId, scope: `webhook:${trigger.body.id}`, key: "enqueue-fails" }
    });
    expect(idempotency.status).toBe("FAILED");
    expect(await prisma.execution.count({ where: { workflowId: workflow.body.id, status: "FAILED" } })).toBe(1);
  });

  async function register() {
    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: "enqueue@example.com", name: "enqueue", password: "password123", organizationName: "QueueFail" })
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
