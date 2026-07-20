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
import { ExecutionRuntimeContext } from "../../worker/src/engine/execution-runtime-context";
import { AppendVariableHandler, GetVariableHandler, IncrementVariableHandler, SetVariableHandler } from "../../worker/src/engine/handlers/variables.handler";

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
    const handler = new HttpRequestHandler(
      new ExpressionResolver(),
      {
        request: async (input: any) => {
          requests.push({ headers: input.headers });
          return { status: 503, ok: false, body: {}, headers: {} };
        }
      } as any,
      {} as any
    );
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

  it("resolves step config centrally and preserves complete expression types", async () => {
    const seed = await seedExecution([
      step("first", StepType.Conditional),
      { ...step("second", StepType.Conditional), config: { left: "{{steps.first.output.count}}", operator: "equals", right: 3 } }
    ]);
    let secondConfig: Record<string, unknown> | undefined;
    const runner = runnerWith(
      {
        [StepType.Conditional]: async (workflowStep: WorkflowStepDefinition) => {
          if (workflowStep.key === "first") {
            return { status: StepExecutionStatus.Completed, output: { count: 3 } };
          }
          secondConfig = workflowStep.config;
          return { status: StepExecutionStatus.Completed, output: { passed: workflowStep.config.left === 3 } };
        }
      },
      new ExpressionResolver()
    );

    await runner.run(seed.payload);

    expect(secondConfig?.left).toBe(3);
  });

  it("executes graph if branches and skips the unselected branch", async () => {
    const seed = await seedExecution(
      [
        step("route", StepType.If),
        step("vip", StepType.DatabaseRecord),
        step("normal", StepType.DatabaseRecord)
      ],
      {
        workflowDefinitionSchemaVersion: 2,
        graph: {
          entryStepKey: "route",
          edges: [
            { from: "route", to: "vip", kind: "if_true", label: "true" },
            { from: "route", to: "normal", kind: "if_false", label: "false" },
            { from: "vip", to: "normal", kind: "next" }
          ]
        }
      }
    );
    const runner = runnerWith({
      [StepType.If]: async () => ({ status: StepExecutionStatus.Completed, output: { matched: false, branch: "false", nextStepKey: "normal" }, control: { nextStepKey: "normal" } }),
      [StepType.DatabaseRecord]: async (workflowStep: WorkflowStepDefinition) => ({ status: StepExecutionStatus.Completed, output: { key: workflowStep.key } })
    });

    await runner.run(seed.payload);

    const rows = await prisma.stepExecution.findMany({ orderBy: { stepKey: "asc" } });
    expect(rows.map((entry) => [entry.stepKey, entry.status, (entry.outputJson as any)?.reason])).toEqual([
      ["normal", StepExecutionStatus.Completed, undefined],
      ["route", StepExecutionStatus.Completed, undefined],
      ["vip", StepExecutionStatus.Skipped, "branch_not_selected"]
    ]);
  });

  it("keeps execution variables in one runtime context and omits them from terminal context cache", async () => {
    const seed = await seedExecution(
      [
        { ...step("set_flag", StepType.SetVariable), config: { scope: "execution", name: "flag", expression: "{{trigger.body.ok}}" } },
        { ...step("get_flag", StepType.GetVariable), config: { scope: "execution", name: "flag" } },
        { ...step("check_flag", StepType.Conditional), config: { left: "{{variables.flag}}", operator: "equals", right: true } }
      ],
      {
        workflowDefinitionSchemaVersion: 2,
        graph: {
          entryStepKey: "set_flag",
          edges: [
            { from: "set_flag", to: "get_flag", kind: "next" },
            { from: "get_flag", to: "check_flag", kind: "next" }
          ]
        },
        workflowVariables: { published: "unchanged" },
        environmentVariables: { region: "test" }
      }
    );
    const resolver = new ExpressionResolver();
    const set = new SetVariableHandler(resolver);
    const get = new GetVariableHandler(resolver);
    const runner = runnerWith(
      {
        [StepType.SetVariable]: set.execute.bind(set),
        [StepType.GetVariable]: get.execute.bind(get),
        [StepType.Conditional]: async (workflowStep: WorkflowStepDefinition) => ({ status: StepExecutionStatus.Completed, output: { passed: workflowStep.config.left === true } })
      },
      resolver
    );

    await runner.run(seed.payload);

    const getStep = await prisma.stepExecution.findFirstOrThrow({ where: { executionId: seed.executionId, stepKey: "get_flag" } });
    expect(getStep.outputJson).toMatchObject({ exists: true, value: true, type: "boolean" });
    const checkStep = await prisma.stepExecution.findFirstOrThrow({ where: { executionId: seed.executionId, stepKey: "check_flag" } });
    expect(checkStep.outputJson).toEqual({ passed: true });
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect((execution.contextJson as any).__runtime).toBeUndefined();
    expect((execution.contextJson as any).variables).toEqual({});
    expect((execution.contextJson as any).workflow.variables.published).toBe("unchanged");
    expect((execution.contextJson as any).workflow.environment.region).toBe("test");
  });

  it("rejects invalid increment and append operations as non retryable variable errors", async () => {
    const resolver = new ExpressionResolver();
    const runtime = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: {} }, execution: {} });
    runtime.set("execution", "count", "not-a-number");
    runtime.set("execution", "items", "not-an-array");
    const increment = new IncrementVariableHandler(resolver);
    const append = new AppendVariableHandler(resolver);

    await expect(increment.execute({ key: "inc", name: "Inc", type: StepType.IncrementVariable, position: 1, config: { scope: "execution", name: "count", amount: 1 } }, runtime.context)).rejects.toThrow("can only increment numbers");
    await expect(append.execute({ key: "append", name: "Append", type: StepType.AppendVariable, position: 1, config: { scope: "execution", name: "items", value: "x" } }, runtime.context)).rejects.toThrow("can only append to arrays");
  });

  it("keeps variable maps isolated across concurrent runtime contexts", async () => {
    const workflow = { id: "workflow-1", variables: { published: "yes" } };
    const runtimeA = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow, execution: { id: "execution-a" } });
    const runtimeB = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow, execution: { id: "execution-b" } });

    await Promise.all([
      Promise.resolve(runtimeA.set("execution", "foo", 1)),
      Promise.resolve(runtimeB.set("execution", "foo", 2))
    ]);

    expect(runtimeA.get("execution", "foo")).toMatchObject({ exists: true, value: 1 });
    expect(runtimeB.get("execution", "foo")).toMatchObject({ exists: true, value: 2 });
    expect(runtimeA.get("workflow", "published")).toMatchObject({ exists: true, value: "yes" });
    expect(runtimeB.get("workflow", "published")).toMatchObject({ exists: true, value: "yes" });
  });

  it("does not carry execution variables into a later execution", () => {
    const first = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: {} }, execution: { id: "execution-a" } });
    first.set("execution", "foo", 1);
    expect(first.snapshot({ includeRuntime: false }).variables).toEqual({});

    const second = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: {} }, execution: { id: "execution-b" } });
    expect(second.get("execution", "foo")).toEqual({ exists: false, value: undefined, type: "undefined" });
  });

  it("mutates workflow variables only in the runtime copy", () => {
    const published = { flag: "published" };
    const runtime = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: published }, execution: { id: "execution" } });

    runtime.set("workflow", "flag", "runtime");

    expect(runtime.get("workflow", "flag")).toMatchObject({ exists: true, value: "runtime" });
    expect(published.flag).toBe("published");
    const later = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: published }, execution: { id: "later" } });
    expect(later.get("workflow", "flag")).toMatchObject({ exists: true, value: "published" });
  });

  it("exposes guarded runtime context views and validates unsafe variable values", () => {
    const runtime = new ExecutionRuntimeContext({
      trigger: { body: { ok: true } },
      steps: {},
      metadata: {},
      workflow: { variables: {}, environment: { region: "test" } },
      execution: { id: "execution" }
    });

    expect(Object.isFrozen(runtime.context.trigger)).toBe(true);
    expect(Object.isFrozen(runtime.context.workflow)).toBe(true);
    expect(Object.isFrozen(runtime.context.workflow!.environment)).toBe(true);
    expect(Object.isFrozen(runtime.context.execution)).toBe(true);
    expect(Object.isFrozen(runtime.context.system)).toBe(true);
    expect(() => ((runtime.context.variables as any).foo = "bad")).toThrow("read-only");
    expect(() => ((runtime.context.execution!.variables as any).foo = "bad")).toThrow("read-only");
    expect(() => ((runtime.context.workflow!.variables as any).foo = "bad")).toThrow("read-only");
    expect(() => runtime.set("execution", "environment", "bad")).toThrow("reserved");
    expect(() => runtime.set("execution", "bad", JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow("not allowed");
    expect(() => runtime.set("execution", "bad", Array.from({ length: 1_001 }, (_, index) => index))).toThrow("too many");
  });

  it("increments and appends missing variables using the documented initial values", () => {
    const runtime = new ExecutionRuntimeContext({ trigger: {}, steps: {}, metadata: {}, workflow: { variables: {} }, execution: { id: "execution" } });
    const item = { id: "a" };

    expect(runtime.increment("execution", "count", 2)).toMatchObject({ exists: true, value: 2, type: "number" });
    expect(runtime.append("execution", "items", item)).toMatchObject({ exists: true, value: [{ id: "a" }], type: "array" });
    item.id = "mutated";
    expect(runtime.get("execution", "items").value).toEqual([{ id: "a" }]);
    expect(() => runtime.increment("execution", "count", Number.POSITIVE_INFINITY)).toThrow("finite number");
  });

  it("schedules and resumes graph delay without recalculating it", async () => {
    const seed = await seedExecution(
      [step("delay", StepType.Delay), step("done", StepType.Conditional)],
      {
        workflowDefinitionSchemaVersion: 2,
        graph: { entryStepKey: "delay", edges: [{ from: "delay", to: "done", kind: "next" }] }
      }
    );
    const runner = runnerWith({
      [StepType.Delay]: async () => ({
        status: StepExecutionStatus.Completed,
        output: { waitUntil: new Date(Date.now() + 60_000).toISOString(), durationMs: 60_000, waitReason: "delay" },
        control: { waitUntil: new Date(Date.now() + 60_000).toISOString(), waitReason: "delay" }
      }),
      [StepType.Conditional]: async () => ({ status: StepExecutionStatus.Completed, output: { done: true } })
    });

    const first = await runner.run(seed.payload);
    expect(first.status).toBe("waiting");
    await prisma.stepExecution.updateMany({ where: { stepKey: "delay" }, data: { nextRetryAt: new Date(Date.now() - 1) } });
    const second = await runner.run(seed.payload);

    expect(second.status).toBe("completed");
    const delay = await prisma.stepExecution.findFirstOrThrow({ where: { stepKey: "delay" } });
    expect(delay.status).toBe(StepExecutionStatus.Completed);
    expect(delay.attemptCount).toBe(1);
  });

  it("does not execute an already cancelled execution", async () => {
    const seed = await seedExecution([step("first", StepType.Conditional)]);
    await prisma.execution.update({ where: { id: seed.executionId }, data: { status: ExecutionStatus.Cancelled, completedAt: new Date() } });
    let calls = 0;
    const runner = runnerWith({
      [StepType.Conditional]: async () => {
        calls += 1;
        return { status: StepExecutionStatus.Completed, output: { ok: true } };
      }
    });

    await runner.run(seed.payload);

    expect(calls).toBe(0);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect(execution.status).toBe(ExecutionStatus.Cancelled);
  });

  it("does not overwrite a cancellation applied while a step is returning", async () => {
    const seed = await seedExecution([step("first", StepType.Conditional)]);
    const runner = runnerWith({
      [StepType.Conditional]: async () => {
        await prisma.execution.update({ where: { id: seed.executionId }, data: { status: ExecutionStatus.Cancelled, completedAt: new Date(), lockedBy: null, lockedUntil: null } });
        return { status: StepExecutionStatus.Completed, output: { ok: true } };
      }
    });

    await runner.run(seed.payload);

    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: seed.executionId } });
    expect(execution.status).toBe(ExecutionStatus.Cancelled);
  });
});

function runnerWith(handlers: Partial<Record<StepType, StepHandler["execute"]>>, expressionResolver?: ExpressionResolver) {
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
    new StepExecutor(prisma as any, registry as any, new ErrorClassifier(), new RetryPolicyResolver(), expressionResolver),
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

async function seedExecution(
  steps: Array<{ key: string; name: string; type: StepType; config: Record<string, unknown>; retryPolicy?: Record<string, unknown> }>,
  definitionJson: Record<string, unknown> = {}
) {
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
      definitionJson: toJson(definitionJson),
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
  await prisma.executionStepReuse.deleteMany();
  await prisma.stepExecutionAttempt.deleteMany();
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
