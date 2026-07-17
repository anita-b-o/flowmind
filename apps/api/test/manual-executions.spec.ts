import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { ExecutionStatus, OrganizationRole } from "@automation/shared-types";
import { AppModule } from "../src/app.module";
import { QueueService } from "../src/queues/queue.service";

const prisma = new PrismaClient();

describe("manual executions API", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const queue = { enqueueExecution: jest.fn(async () => ({ id: "queued" })) };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    await cleanDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(QueueService).useValue(queue).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = new JwtService();
  }, 30_000);

  afterEach(async () => {
    queue.enqueueExecution.mockClear();
    await cleanDatabase();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("creates one queued manual execution for an active workflow and records audit", async () => {
    const seed = await seedActiveWorkflow();
    const response = await request(app.getHttpServer())
      .post(`/workflows/${seed.workflowId}/executions`)
      .set(authHeaders(seed.user, seed.organizationId))
      .set("Idempotency-Key", "manual-1")
      .send({ input: { trigger: { lead: "Ada", token: "secret" }, metadata: {} }, confirmRealEffects: true })
      .expect(201);

    expect(response.body.execution).toMatchObject({ status: ExecutionStatus.Queued, publicStatus: "queued", workflowId: seed.workflowId });
    expect(queue.enqueueExecution).toHaveBeenCalledTimes(1);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: response.body.execution.id } });
    expect(execution.startedByUserId).toBe(seed.user.userId);
    expect(execution.manualExecutionKey).toBe("manual-1");
    expect(await prisma.auditLog.count({ where: { organizationId: seed.organizationId, action: "execution.created" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: seed.organizationId, action: "execution.enqueued" } })).toBe(1);
  });

  it("is idempotent for duplicate manual submits and rejects key reuse with different payload", async () => {
    const seed = await seedActiveWorkflow();
    const body = { input: { trigger: { lead: "Ada" }, metadata: {} }, confirmRealEffects: true };
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post(`/workflows/${seed.workflowId}/executions`).set(authHeaders(seed.user, seed.organizationId)).set("Idempotency-Key", "same-manual").send(body),
      request(app.getHttpServer()).post(`/workflows/${seed.workflowId}/executions`).set(authHeaders(seed.user, seed.organizationId)).set("Idempotency-Key", "same-manual").send(body)
    ]);

    expect([201, 200]).toContain(first.status);
    expect([201, 200]).toContain(second.status);
    expect(first.body.execution.id).toBe(second.body.execution.id);
    expect(await prisma.execution.count({ where: { workflowId: seed.workflowId } })).toBe(1);

    await request(app.getHttpServer())
      .post(`/workflows/${seed.workflowId}/executions`)
      .set(authHeaders(seed.user, seed.organizationId))
      .set("Idempotency-Key", "same-manual")
      .send({ input: { trigger: { lead: "Grace" } }, confirmRealEffects: true })
      .expect(409);
  });

  it("rejects inactive workflows and isolates tenants", async () => {
    const seed = await seedActiveWorkflow();
    const other = await seedUser("other-manual@example.com");

    await request(app.getHttpServer())
      .post(`/workflows/${seed.workflowId}/executions`)
      .set(authHeaders(other, seed.organizationId))
      .send({ confirmRealEffects: true })
      .expect(403);

    await prisma.workflow.update({ where: { id: seed.workflowId }, data: { status: "PAUSED" } });
    await request(app.getHttpServer())
      .post(`/workflows/${seed.workflowId}/executions`)
      .set(authHeaders(seed.user, seed.organizationId))
      .send({ confirmRealEffects: true })
      .expect(400);
  });

  it("cancels active executions idempotently and rejects terminal cancellation", async () => {
    const seed = await seedActiveWorkflow();
    const execution = await prisma.execution.create({
      data: {
        organizationId: seed.organizationId,
        workflowId: seed.workflowId,
        workflowVersionId: seed.workflowVersionId,
        status: ExecutionStatus.Queued,
        executionMode: "REAL",
        inputJson: { trigger: {} },
        contextJson: { trigger: {}, steps: {}, metadata: {} }
      }
    });

    const cancelled = await request(app.getHttpServer())
      .post(`/executions/${execution.id}/cancel`)
      .set(authHeaders(seed.user, seed.organizationId))
      .send({ reason: "stop" })
      .expect(201);
    expect(cancelled.body.execution).toMatchObject({ status: ExecutionStatus.Cancelled, publicStatus: "cancelled" });
    expect(await prisma.auditLog.count({ where: { organizationId: seed.organizationId, action: "execution.cancelled" } })).toBe(1);

    await request(app.getHttpServer()).post(`/executions/${execution.id}/cancel`).set(authHeaders(seed.user, seed.organizationId)).send({}).expect(409);
  });

  async function seedActiveWorkflow() {
    const user = await seedUser(`manual-${Date.now()}@example.com`);
    const organization = await prisma.organization.create({
      data: { name: "Manual Org", slug: `manual-${Date.now()}`, members: { create: { userId: user.userId, role: OrganizationRole.Owner } } }
    });
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Manual", status: "ACTIVE", createdByUserId: user.userId } });
    const version = await prisma.workflowVersion.create({
      data: {
        organizationId: organization.id,
        workflowId: workflow.id,
        versionNumber: 1,
        status: "ACTIVE",
        definitionJson: { trigger: { key: "webhook" }, steps: [{ key: "save", type: "database_record", config: {} }] },
        createdByUserId: user.userId,
        steps: { create: { organizationId: organization.id, key: "save", name: "Save", type: "database_record", position: 1, configJson: { collection: "items", data: { ok: true } } } }
      }
    });
    await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } });
    return { user, organizationId: organization.id, workflowId: workflow.id, workflowVersionId: version.id };
  }

  async function seedUser(email: string) {
    const user = await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: "hash" } });
    return { userId: user.id, accessToken: await jwt.signAsync({ sub: user.id, email, tokenType: "access", jti: user.id }, { secret: process.env.JWT_ACCESS_SECRET }) };
  }
});

function authHeaders(user: { accessToken: string }, organizationId: string) {
  return { authorization: `Bearer ${user.accessToken}`, "x-organization-id": organizationId };
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
