import { Prisma, PrismaClient } from "@prisma/client";
import { ExecutionStatus, StepExecutionStatus, StepType, type ExecutionContext, type WorkflowStepDefinition } from "@automation/shared-types";
import type { StepHandler } from "../../worker/src/engine/types";
import { WorkflowRunner } from "../../worker/src/engine/workflow-runner";
import { StepExecutor } from "../../worker/src/engine/step-executor";
import { ErrorClassifier } from "../../worker/src/engine/error-classifier";
import { RetryPolicyResolver } from "../../worker/src/engine/retry-policy-resolver";
import { ContextReconstructor } from "../../worker/src/engine/context-reconstructor";
import { HttpStepError } from "../../worker/src/engine/step-errors";
import { DatabaseRecordHandler } from "../../worker/src/engine/handlers/database-record.handler";
import { ExpressionResolver } from "../../worker/src/engine/expression-resolver";
import { HttpRequestHandler } from "../../worker/src/engine/handlers/http-request.handler";

const prisma = new PrismaClient();

describe("step recovery engine", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    await cleanDatabase();
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("retries a timeout-like error and resumes the same step", async () => {
    const seed = await seedExecution([step("unstable", StepType.HttpRequest, { retry: { maxAttempts: 2, backoffMs: 100, strategy: "fixed" } })]);
    let calls = 0;
    const runner = runnerWith({
      [StepType.HttpRequest]: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("Step timed out after 10ms");
        }
        return { status: StepExecutionStatus.Completed, output: { ok: true } };
      }
    });

    const first = await runner.run(seed.payload);
    expect(first.status).toBe("waiting");
    await prisma.stepExecution.updateMany({ data: { nextRetryAt: new Date(Date.now() - 1) } });
    const second = await runner.run(seed.payload);

    expect(second.status).toBe("completed");
    const stepExecution = await prisma.stepExecution.findFirstOrThrow();
    expect(stepExecution.status).toBe(StepExecutionStatus.Completed);
    expect(stepExecution.attemptCount).toBe(2);
  });

  it("retries HTTP 503 and does not retry HTTP 400, SSRF, or invalid config", () => {
    const classifier = new ErrorClassifier();
    expect(classifier.classify(new HttpStepError(503))).toBe("retryable");
    expect(classifier.classify(new HttpStepError(400))).toBe("non_retryable");
    expect(classifier.classify(new Error("Private, reserved or metadata IP is not allowed"))).toBe("non_retryable");
    expect(classifier.classify(new Error("database_record.collection config is invalid"))).toBe("non_retryable");
  });

  it("classifies SMTP temporary and AI rate limit errors as retryable", () => {
    const classifier = new ErrorClassifier();
    expect(classifier.classify(new Error("SMTP temporary failure"))).toBe("retryable");
    expect(classifier.classify(new Error("AI rate limit exceeded"))).toBe("retryable");
  });

  it("resumes from the database and does not execute an already completed step", async () => {
    const seed = await seedExecution([step("first", StepType.Conditional), step("second", StepType.Conditional), step("third", StepType.Conditional)]);
    await prisma.stepExecution.create({
      data: {
        organizationId: seed.organizationId,
        executionId: seed.executionId,
        workflowStepId: seed.steps[0].id,
        stepKey: "first",
        stepType: StepType.Conditional,
        status: StepExecutionStatus.Completed,
        attempt: 1,
        attemptCount: 1,
        maxAttempts: 1,
        inputJson: {},
        outputJson: { ok: "persisted" }
      }
    });
    let firstCalls = 0;
    const runner = runnerWith({
      [StepType.Conditional]: async (workflowStep: WorkflowStepDefinition) => {
        if (workflowStep.key === "first") {
          firstCalls += 1;
        }
        return { status: StepExecutionStatus.Completed, output: { key: workflowStep.key } };
      }
    });

    await runner.run(seed.payload);

    expect(firstCalls).toBe(0);
    const executions = await prisma.stepExecution.findMany({ orderBy: { stepKey: "asc" } });
    expect(executions.map((entry) => [entry.stepKey, entry.status])).toEqual([
      ["first", StepExecutionStatus.Completed],
      ["second", StepExecutionStatus.Completed],
      ["third", StepExecutionStatus.Completed]
    ]);
  });

  it("does not duplicate database_record effects", async () => {
    const seed = await seedExecution([step("save", StepType.DatabaseRecord)]);
    const handler = new DatabaseRecordHandler(prisma as any, new ExpressionResolver());
    const context = runtimeContext(seed, seed.steps[0].id, "step-exec-1", "flowmind:dedupe");
    const workflowStep: WorkflowStepDefinition = {
      key: "save",
      name: "Save",
      type: StepType.DatabaseRecord,
      position: 1,
      config: { collection: "leads", data: { email: "ada@example.com" } }
    };

    await prisma.stepExecution.create({
      data: stepExecutionData(seed, seed.steps[0].id, "step-exec-1", "save", StepType.DatabaseRecord)
    });
    await handler.execute(workflowStep, context);
    await handler.execute(workflowStep, context);

    expect(await prisma.internalRecord.count()).toBe(1);
  });

  it("adds a stable idempotency key to retried HTTP mutations", async () => {
    const requests: Array<{ headers?: Record<string, string> }> = [];
    const handler = new HttpRequestHandler(new ExpressionResolver(), {
      request: async (input: any) => {
        requests.push({ headers: input.headers });
        return { status: 503, ok: false, body: {}, headers: {} };
      }
    } as any);
    const context = runtimeContext({ organizationId: "org", workflowId: "wf", workflowVersionId: "wv", executionId: "ex" }, "step", "se", "flowmind:ex:post");

    await expect(
      handler.execute({ key: "post", name: "Post", position: 1, type: StepType.HttpRequest, config: { url: "https://example.com", method: "POST" } }, context)
    ).rejects.toThrow("HTTP request failed with 503");
    await expect(
      handler.execute({ key: "post", name: "Post", position: 1, type: StepType.HttpRequest, config: { url: "https://example.com", method: "POST" } }, context)
    ).rejects.toThrow("HTTP request failed with 503");

    expect(requests.map((request) => request.headers?.["Idempotency-Key"])).toEqual(["flowmind:ex:post", "flowmind:ex:post"]);
  });

  it("reuses persisted AI output instead of calling the handler again", async () => {
    const seed = await seedExecution([step("ai", StepType.AiSummary)]);
    await prisma.stepExecution.create({
      data: {
        organizationId: seed.organizationId,
        executionId: seed.executionId,
        workflowStepId: seed.steps[0].id,
        stepKey: "ai",
        stepType: StepType.AiSummary,
        status: StepExecutionStatus.Completed,
        attempt: 1,
        attemptCount: 1,
        maxAttempts: 1,
        inputJson: {},
        outputJson: { summary: "cached" }
      }
    });
    let aiCalls = 0;
    const runner = runnerWith({
      [StepType.AiSummary]: async () => {
        aiCalls += 1;
        return { status: StepExecutionStatus.Completed, output: { summary: "new" } };
      }
    });

    await runner.run(seed.payload);

    expect(aiCalls).toBe(0);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect((execution.contextJson as any).steps.ai.output).toEqual({ summary: "cached" });
  });
});

function runnerWith(handlers: Partial<Record<StepType, StepHandler["execute"]>>) {
  const registry = {
    get(type: string) {
      const execute = handlers[type as StepType];
      if (!execute) {
        throw new Error(`No handler for ${type}`);
      }
      return { type: type as StepType, execute };
    }
  };
  return new WorkflowRunner(
    prisma as any,
    new StepExecutor(prisma as any, registry as any, new ErrorClassifier(), new RetryPolicyResolver()),
    new ContextReconstructor(),
    {
      acquire: async () => true,
      heartbeatIntervalMs: () => 10_000,
      assertOwned: async () => undefined,
      release: async () => undefined
    } as any,
    { create: async () => undefined } as any
  );
}

function step(key: string, type: StepType, retryPolicy?: Record<string, unknown>) {
  return { key, name: key, type, config: {}, retryPolicy };
}

async function seedExecution(steps: Array<{ key: string; name: string; type: StepType; config: Record<string, unknown>; retryPolicy?: Record<string, unknown> }>) {
  const user = await prisma.user.create({
    data: { email: `${Math.random()}@example.com`, name: "Test", passwordHash: "hash" }
  });
  const organization = await prisma.organization.create({
    data: { name: "Org", slug: `org-${Math.random()}`, members: { create: { userId: user.id, role: "owner" } } }
  });
  const workflow = await prisma.workflow.create({
    data: { organizationId: organization.id, name: "Workflow", status: "ACTIVE", createdByUserId: user.id }
  });
  const version = await prisma.workflowVersion.create({
    data: {
      organizationId: organization.id,
      workflowId: workflow.id,
      versionNumber: 1,
      status: "ACTIVE",
      definitionJson: {},
      createdByUserId: user.id,
      steps: {
        createMany: {
          data: [
            { organizationId: organization.id, key: "webhook", name: "Webhook", type: StepType.WebhookTrigger, position: 0, configJson: {} },
            ...steps.map((workflowStep, index) => ({
              organizationId: organization.id,
              key: workflowStep.key,
              name: workflowStep.name,
              type: workflowStep.type,
              position: index + 1,
              configJson: toJson(workflowStep.config),
              retryPolicyJson: workflowStep.retryPolicy ? toJson(workflowStep.retryPolicy) : undefined
            }))
          ]
        }
      }
    }
  });
  const workflowSteps = await prisma.workflowStep.findMany({ where: { workflowVersionId: version.id }, orderBy: { position: "asc" } });
  const execution = await prisma.execution.create({
    data: {
      organizationId: organization.id,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      status: ExecutionStatus.Queued,
      inputJson: { trigger: { body: { ok: true } } },
      contextJson: { trigger: { body: { ok: true } }, steps: {}, metadata: {} }
    }
  });
  return {
    organizationId: organization.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    executionId: execution.id,
    steps: workflowSteps.filter((workflowStep) => workflowStep.position > 0),
    payload: {
      organizationId: organization.id,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      executionId: execution.id,
      requestId: "test-request",
      correlationId: "test-correlation",
      enqueuedAt: new Date().toISOString()
    }
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function runtimeContext(seed: any, workflowStepId: string, stepExecutionId: string, effectKey: string): ExecutionContext {
  return {
    trigger: {},
    steps: {},
    metadata: {
      organizationId: seed.organizationId,
      workflowId: seed.workflowId,
      workflowVersionId: seed.workflowVersionId,
      executionId: seed.executionId,
      runtime: {
        organizationId: seed.organizationId,
        workflowStepId,
        executionId: seed.executionId,
        stepExecutionId,
        effectKey
      }
    }
  };
}

function stepExecutionData(seed: any, workflowStepId: string, id: string, stepKey: string, stepType: StepType) {
  return {
    id,
    organizationId: seed.organizationId,
    executionId: seed.executionId,
    workflowStepId,
    stepKey,
    stepType,
    status: StepExecutionStatus.Running,
    attempt: 1,
    attemptCount: 1,
    maxAttempts: 1,
    inputJson: {}
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
