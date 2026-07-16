import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { sanitizeForLog, sanitizeUrl } from "@automation/observability";
import { QueueService } from "../src/queues/queue.service";
import { RequestContextService } from "../src/observability/request-context.service";

const prisma = new PrismaClient();
const queued: any[] = [];
let app: INestApplication;

describe("traceability", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "test-webhook-token-pepper";
    process.env.LOG_LEVEL = "silent";
    await cleanDatabase();

    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(QueueService)
      .useValue({ enqueueExecution: jest.fn(async (payload) => queued.push(payload)) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 30_000);

  afterEach(async () => {
    queued.length = 0;
    await cleanDatabase();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("generates, preserves, replaces, and returns trace headers", async () => {
    const generated = await request(app.getHttpServer()).get("/health/live").expect(200);
    expect(generated.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(generated.headers["x-correlation-id"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);

    const preserved = await request(app.getHttpServer())
      .get("/health/live")
      .set("x-request-id", "req.valid-123")
      .set("x-correlation-id", "corr.valid-123")
      .expect(200);
    expect(preserved.headers["x-request-id"]).toBe("req.valid-123");
    expect(preserved.headers["x-correlation-id"]).toBe("corr.valid-123");

    const replaced = await request(app.getHttpServer())
      .get("/health/live")
      .set("x-request-id", "bad")
      .set("x-correlation-id", "contains space")
      .expect(200);
    expect(replaced.headers["x-request-id"]).not.toBe("bad");
    expect(replaced.headers["x-correlation-id"]).not.toBe("contains space");
  });

  it("isolates request context across concurrent async work", async () => {
    const service = app.get(RequestContextService);
    const [a, b] = await Promise.all([
      service.run({ requestId: "request-a", correlationId: "correlation-a" }, async () => {
        await delay(20);
        return service.getContext();
      }),
      service.run({ requestId: "request-b", correlationId: "correlation-b" }, async () => {
        await delay(5);
        return service.getContext();
      })
    ]);
    expect(a).toMatchObject({ requestId: "request-a", correlationId: "correlation-a" });
    expect(b).toMatchObject({ requestId: "request-b", correlationId: "correlation-b" });
  });

  it("persists webhook trace IDs, propagates jobs, and preserves idempotent correlation", async () => {
    const user = await register("trace@example.com", "Trace Org");
    const workflow = await createWorkflow(user);
    const version = await createVersion(user, workflow.id);
    const trigger = await createTrigger(user, workflow.id);
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(authHeaders(user)).expect(200);

    const first = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "trace-key")
      .set("x-request-id", "webhook-request-1")
      .set("x-correlation-id", "webhook-correlation-1")
      .send({ token: "should-not-appear", ok: true })
      .expect(202);

    expect(first.headers["x-request-id"]).toBe("webhook-request-1");
    expect(first.headers["x-correlation-id"]).toBe("webhook-correlation-1");
    expect(first.body.correlationId).toBe("webhook-correlation-1");
    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { workflowId: workflow.id } });
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: first.body.executionId } });
    expect(event.requestId).toBe("webhook-request-1");
    expect(event.correlationId).toBe("webhook-correlation-1");
    expect(execution.correlationId).toBe("webhook-correlation-1");
    expect(queued[0]).toMatchObject({
      executionId: execution.id,
      requestId: "webhook-request-1",
      correlationId: "webhook-correlation-1"
    });
    expect(JSON.stringify(queued[0])).not.toContain(trigger.token);

    const second = await request(app.getHttpServer())
      .post(`/webhooks/${workflow.id}/${trigger.token}`)
      .set("Idempotency-Key", "trace-key")
      .set("x-request-id", "webhook-request-2")
      .set("x-correlation-id", "webhook-correlation-2")
      .send({ token: "should-not-appear", ok: true })
      .expect(202);
    expect(second.body.executionId).toBe(first.body.executionId);
    expect(second.body.correlationId).toBe("webhook-correlation-1");
    expect(second.headers["x-correlation-id"]).toBe("webhook-correlation-1");
  });

  it("manual retry inherits correlationId and stores it in AuditLog", async () => {
    const user = await register("retry-trace@example.com", "Retry Trace Org");
    const workflow = await createWorkflow(user);
    const version = await createVersion(user, workflow.id);
    const execution = await prisma.execution.create({
      data: {
        organizationId: user.organizationId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        status: "FAILED",
        correlationId: "retry-correlation-1",
        inputJson: { trigger: { body: { ok: true } } },
        contextJson: { trigger: {}, steps: {}, metadata: {} }
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/executions/${execution.id}/retry`)
      .set(authHeaders(user))
      .set("x-request-id", "retry-request-1")
      .send({ reason: "again" })
      .expect(201);

    const retry = await prisma.execution.findUniqueOrThrow({ where: { id: response.body.executionId } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: execution.id, action: "execution.retry" } });
    expect(retry.retryOfExecutionId).toBe(execution.id);
    expect(retry.correlationId).toBe("retry-correlation-1");
    expect(audit.correlationId).toBe("retry-correlation-1");
    expect(queued.at(-1)).toMatchObject({ executionId: retry.id, requestId: "retry-request-1", correlationId: "retry-correlation-1" });
  });

  it("returns correlationId from execution and DLQ detail", async () => {
    const user = await register("dlq-trace@example.com", "DLQ Trace Org");
    const workflow = await createWorkflow(user);
    const version = await createVersion(user, workflow.id);
    const execution = await prisma.execution.create({
      data: {
        organizationId: user.organizationId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        status: "FAILED",
        correlationId: "dlq-correlation-1",
        inputJson: {},
        contextJson: {}
      }
    });
    const dlq = await prisma.deadLetterExecution.create({
      data: {
        organizationId: user.organizationId,
        executionId: execution.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        sourceQueue: "workflow-executions",
        reason: "failed"
      }
    });
    const detail = await request(app.getHttpServer()).get(`/executions/${execution.id}`).set(authHeaders(user)).expect(200);
    const dlqDetail = await request(app.getHttpServer()).get(`/dead-letter-executions/${dlq.id}`).set(authHeaders(user)).expect(200);
    expect(detail.body.correlationId).toBe("dlq-correlation-1");
    expect(dlqDetail.body.correlationId).toBe("dlq-correlation-1");
  });

  it("sanitizes sensitive headers, nested objects, and URLs", () => {
    const sanitized = sanitizeForLog({
      headers: { authorization: "Bearer secret", cookie: "a=b" },
      nested: { refreshToken: "refresh", safeId: "id-123" }
    });
    expect(JSON.stringify(sanitized)).not.toContain("Bearer secret");
    expect(JSON.stringify(sanitized)).not.toContain('"refreshToken":"refresh"');
    expect(JSON.stringify(sanitized)).toContain("id-123");
    expect(sanitizeUrl("https://user:pass@example.com/path?token=secret&ok=1")).toBe("https://example.com/path?token=%5BREDACTED%5D&ok=1");
  });
});

type TestUser = { accessToken: string; organizationId: string };

async function register(email: string, organizationName: string): Promise<TestUser> {
  const response = await request(app.getHttpServer())
    .post("/auth/register")
    .send({ email, name: email.split("@")[0], password: "password123", organizationName })
    .expect(201);
  return { accessToken: response.body.accessToken, organizationId: response.body.defaultOrganizationId };
}

function authHeaders(user: TestUser) {
  return {
    authorization: `Bearer ${user.accessToken}`,
    "x-organization-id": user.organizationId
  };
}

async function createWorkflow(user: TestUser) {
  const response = await request(app.getHttpServer()).post("/workflows").set(authHeaders(user)).send({ name: `Workflow ${Math.random()}` }).expect(201);
  return response.body;
}

async function createVersion(user: TestUser, workflowId: string) {
  const response = await request(app.getHttpServer())
    .post(`/workflows/${workflowId}/versions`)
    .set(authHeaders(user))
    .send({
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [{ key: "check", name: "Check", type: "conditional", config: { left: "1", operator: "equals", right: "1" } }]
    })
    .expect(201);
  return response.body;
}

async function createTrigger(user: TestUser, workflowId: string) {
  const response = await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(authHeaders(user)).send({}).expect(201);
  return response.body;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
