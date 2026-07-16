import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { ExecutionStatus, OrganizationRole, StepExecutionStatus, StepType } from "@automation/shared-types";
import { AppModule } from "../src/app.module";
import { QueueService } from "../src/queues/queue.service";

const prisma = new PrismaClient();

describe("DLQ, retry and audit log API", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const queue = { enqueueExecution: jest.fn(async () => ({ id: "queued" })) };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
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

  it("lets viewers list and inspect sanitized DLQ entries but not retry", async () => {
    const seed = await seedFailure();
    const viewer = await addMember(seed.organizationId, OrganizationRole.Viewer, "viewer@example.com");

    const list = await request(app.getHttpServer()).get("/dead-letter-executions?status=active&page=1&pageSize=10").set(authHeaders(viewer, seed.organizationId)).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      id: seed.deadLetterId,
      active: true,
      reason: "attempts_exhausted",
      correlationId: "correlation-dlq-1"
    });
    expect(JSON.stringify(list.body)).not.toMatch(/secret|worker-1|lockedBy|job-/i);

    const detail = await request(app.getHttpServer()).get(`/dead-letter-executions/${seed.deadLetterId}`).set(authHeaders(viewer, seed.organizationId)).expect(200);
    expect(detail.body.lastError).toMatchObject({ category: "timeout", code: "STEP_TIMEOUT" });
    expect(JSON.stringify(detail.body)).not.toMatch(/top-secret|authorization|cookie|worker-1|lockedBy|job-/i);

    await request(app.getHttpServer()).post(`/executions/${seed.executionId}/retry`).set(authHeaders(viewer, seed.organizationId)).send({ reason: "try" }).expect(403);
  });

  it("keeps DLQ tenant isolated and supports filters and resolved entries", async () => {
    const seed = await seedFailure();
    const other = await seedFailure("other");
    const viewer = await addMember(seed.organizationId, OrganizationRole.Viewer, "viewer2@example.com");

    await prisma.deadLetterExecution.update({ where: { id: seed.deadLetterId }, data: { resolvedAt: new Date(), resolution: "RETRIED" } });

    await request(app.getHttpServer()).get(`/dead-letter-executions/${other.deadLetterId}`).set(authHeaders(viewer, seed.organizationId)).expect(404);
    const resolved = await request(app.getHttpServer())
      .get(`/dead-letter-executions?status=resolved&reason=attempts_exhausted&workflowId=${seed.workflowId}`)
      .set(authHeaders(viewer, seed.organizationId))
      .expect(200);
    expect(resolved.body.items).toHaveLength(1);
    expect(resolved.body.items[0]).toMatchObject({ id: seed.deadLetterId, active: false });
  });

  it("lets editors retry once, preserves original execution, resolves DLQ and creates audit logs", async () => {
    const seed = await seedFailure();
    const editor = await addMember(seed.organizationId, OrganizationRole.Editor, "editor@example.com");

    const retry = await request(app.getHttpServer())
      .post(`/executions/${seed.executionId}/retry`)
      .set(authHeaders(editor, seed.organizationId))
      .send({ reason: "manual review" })
      .expect(201);

    expect(retry.body.execution).toMatchObject({ status: ExecutionStatus.Queued, retryOfExecutionId: seed.executionId, correlationId: "correlation-dlq-1" });
    const original = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    const next = await prisma.execution.findUniqueOrThrow({ where: { id: retry.body.execution.id } });
    expect(original.status).toBe(ExecutionStatus.Failed);
    expect(next.workflowVersionId).toBe(seed.workflowVersionId);
    expect(next.inputJson).toEqual(original.inputJson);
    expect(next.correlationId).toBe(original.correlationId);
    expect(await prisma.deadLetterExecution.count({ where: { id: seed.deadLetterId, resolvedAt: { not: null }, resolution: "RETRIED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: seed.organizationId, action: "execution.retry_requested" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: seed.organizationId, action: "dead_letter.resolved" } })).toBe(1);

    await request(app.getHttpServer()).post(`/executions/${seed.executionId}/retry`).set(authHeaders(editor, seed.organizationId)).send({}).expect(409);
  });

  it("returns a recoverable enqueue error without creating another execution on repeat", async () => {
    const seed = await seedFailure();
    const editor = await addMember(seed.organizationId, OrganizationRole.Editor, "editor2@example.com");
    queue.enqueueExecution.mockRejectedValueOnce(new Error("redis down"));

    const response = await request(app.getHttpServer()).post(`/executions/${seed.executionId}/retry`).set(authHeaders(editor, seed.organizationId)).send({}).expect(503);
    expect(response.body.recoverable).toBe(true);
    expect(response.body.execution.id).toBeDefined();
    expect(await prisma.execution.count({ where: { retryOfExecutionId: seed.executionId } })).toBe(1);

    await request(app.getHttpServer()).post(`/executions/${seed.executionId}/retry`).set(authHeaders(editor, seed.organizationId)).send({}).expect(409);
    expect(await prisma.execution.count({ where: { retryOfExecutionId: seed.executionId } })).toBe(1);
  });

  it("exposes audit logs to admins only with sanitized metadata and filters", async () => {
    const seed = await seedFailure();
    const admin = await addMember(seed.organizationId, OrganizationRole.Admin, "admin@example.com");
    const viewer = await addMember(seed.organizationId, OrganizationRole.Viewer, "viewer3@example.com");
    await prisma.auditLog.create({
      data: {
        organizationId: seed.organizationId,
        actorUserId: admin.userId,
        action: "trigger.created",
        resourceType: "Trigger",
        resourceId: "trigger-1",
        correlationId: "audit-correlation",
        metadataJson: { token: "secret-token", ok: true }
      }
    });

    await request(app.getHttpServer()).get("/audit-logs").set(authHeaders(viewer, seed.organizationId)).expect(403);
    const response = await request(app.getHttpServer())
      .get("/audit-logs?action=trigger.created&correlationId=audit-correlation&page=1&pageSize=10")
      .set(authHeaders(admin, seed.organizationId))
      .expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ action: "trigger.created", resourceType: "Trigger", correlationId: "audit-correlation" });
    expect(JSON.stringify(response.body)).not.toContain("secret-token");
  });

  it("audits trigger changes, workflow activation and logout-all", async () => {
    process.env.WEBHOOK_TOKEN_PEPPER = "audit-test-webhook-pepper";
    const owner = await seedUser("critical-owner@example.com");
    const organization = await prisma.organization.create({
      data: { name: "Critical Org", slug: `critical-${Date.now()}`, members: { create: { userId: owner.userId, role: OrganizationRole.Owner } } }
    });
    const workflow = await request(app.getHttpServer())
      .post("/workflows")
      .set(authHeaders(owner, organization.id))
      .send({ name: "Critical workflow" })
      .expect(201);
    const version = await request(app.getHttpServer())
      .post(`/workflows/${workflow.body.id}/versions`)
      .set(authHeaders(owner, organization.id))
      .send({
        trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
        steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "leads", data: { ok: true } } }]
      })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/workflows/${workflow.body.id}/versions/${version.body.id}/activate`)
      .set(authHeaders(owner, organization.id))
      .expect(200);
    const trigger = await request(app.getHttpServer()).post(`/workflows/${workflow.body.id}/triggers`).set(authHeaders(owner, organization.id)).send({}).expect(201);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.body.id}/triggers/${trigger.body.id}/rotate`).set(authHeaders(owner, organization.id)).expect(200);
    await request(app.getHttpServer()).post("/auth/logout-all").set(authHeaders(owner, organization.id)).set("Origin", "http://localhost:3000").expect(204);

    await expectAudit(organization.id, "workflow.activated");
    await expectAudit(organization.id, "trigger.created");
    await expectAudit(organization.id, "trigger.rotated");
    await expectAudit(organization.id, "auth.logout_all");
  });

  async function seedFailure(suffix = "main") {
    const owner = await seedUser(`owner-${suffix}@example.com`);
    const organization = await prisma.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}-${Date.now()}`, members: { create: { userId: owner.userId, role: OrganizationRole.Owner } } }
    });
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: `Workflow ${suffix}`, status: "ACTIVE", createdByUserId: owner.userId } });
    const version = await prisma.workflowVersion.create({
      data: {
        organizationId: organization.id,
        workflowId: workflow.id,
        versionNumber: 1,
        status: "ACTIVE",
        definitionJson: {},
        createdByUserId: owner.userId,
        steps: { create: { organizationId: organization.id, key: "notify", name: "Notify", type: StepType.HttpRequest, position: 1, configJson: {} } }
      },
      include: { steps: true }
    });
    const execution = await prisma.execution.create({
      data: {
        organizationId: organization.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        correlationId: "correlation-dlq-1",
        status: ExecutionStatus.Failed,
        inputJson: { trigger: { body: { lead: "Ada" } } },
        contextJson: { trigger: { body: { lead: "Ada" } }, steps: {}, metadata: {} },
        errorJson: { message: "failed" },
        lockedBy: "worker-1"
      }
    });
    const step = await prisma.stepExecution.create({
      data: {
        organizationId: organization.id,
        executionId: execution.id,
        workflowStepId: version.steps[0].id,
        stepKey: "notify",
        stepType: StepType.HttpRequest,
        status: StepExecutionStatus.Failed,
        attempt: 3,
        attemptCount: 3,
        maxAttempts: 3,
        effectStatus: "failed",
        workerId: "worker-1",
        inputJson: {},
        errorJson: { classification: "timeout", message: "top-secret authorization cookie" }
      }
    });
    const deadLetter = await prisma.deadLetterExecution.create({
      data: {
        organizationId: organization.id,
        executionId: execution.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        sourceQueue: "workflow-executions",
        reason: "failed",
        failedStepKey: "notify",
        failedStepExecutionId: step.id,
        attempts: 3,
        lastErrorJson: { classification: "timeout", message: "top-secret authorization cookie", token: "secret" },
        jobId: "job-secret"
      }
    });
    return { organizationId: organization.id, workflowId: workflow.id, workflowVersionId: version.id, executionId: execution.id, deadLetterId: deadLetter.id };
  }

  async function addMember(organizationId: string, role: OrganizationRole, email: string) {
    const user = await seedUser(email);
    await prisma.organizationMember.create({ data: { organizationId, userId: user.userId, role } });
    return user;
  }

  async function seedUser(email: string) {
    const user = await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: "hash" } });
    return { userId: user.id, accessToken: await jwt.signAsync({ sub: user.id, email, tokenType: "access", jti: user.id }, { secret: process.env.JWT_ACCESS_SECRET }) };
  }
});

async function expectAudit(organizationId: string, action: string) {
  expect(await prisma.auditLog.count({ where: { organizationId, action } })).toBe(1);
}

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
