import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ExpressionResolver } from "./expression-resolver";
import { ForEachExecutionService } from "./for-each-execution.service";

describe("ForEachExecutionService", () => {
  it("executes items sequentially with isolated item/index frames and collected results", async () => {
    const rows = new Map<string, any>();
    const loopRow = row("loop-id", "loop", "root", null, StepExecutionStatus.Pending);
    rows.set(loopRow.id, loopRow);
    const prisma = fakePrisma(rows);
    const seen: Array<{ item: unknown; index: number; path: string }> = [];
    const stepExecutor = fakeStepExecutor(rows, async (input: any) => {
      seen.push({ item: input.context.item, index: input.context.index, path: input.executionPath });
      return { outcome: "completed", result: { status: StepExecutionStatus.Completed, output: { item: input.context.item, index: input.context.index, alias: input.context.variables.record } } };
    });
    const service = new ForEachExecutionService(prisma as any, stepExecutor as any, new ExpressionResolver());
    const runtime = new ExecutionRuntimeContext({ trigger: { body: { items: ["a", "b", "c"] } }, steps: {}, variables: {}, metadata: { expressionMode: "strict" }, workflow: { variables: {} }, execution: {} });
    const result = await service.execute({
      organizationId: "org",
      executionId: "execution",
      loopStep: { key: "loop", name: "Loop", type: StepType.ForEach, position: 1, config: { source: "{{trigger.body.items}}", itemVariable: "record", mode: "SEQUENTIAL", concurrency: 1, maxItems: 100, collectResults: true, maxResults: 2 } },
      loopStepExecution: loopRow,
      graph: { entryStepKey: "loop", edges: [{ from: "loop", to: "body", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" }, { from: "body", to: "done", kind: "next" }] },
      bodyEntryStepKey: "body",
      doneStepKey: "done",
      bodyStepKeys: new Set(["body"]),
      stepRowsByKey: new Map([["body", { id: "body-step", key: "body", name: "Body", type: StepType.Transform, position: 2, configJson: {}, retryPolicyJson: null, timeoutSeconds: 30 }]]),
      runtimeContext: runtime
    });
    expect(result).toEqual({ outcome: "completed", output: { total: 3, succeeded: 3, failed: 0, skipped: 0, mode: "SEQUENTIAL", results: [{ item: "a", index: 0, alias: "a" }, { item: "b", index: 1, alias: "b" }], resultsTruncated: true } });
    expect(seen).toEqual([
      { item: "a", index: 0, path: "root/loop[0]" },
      { item: "b", index: 1, path: "root/loop[1]" },
      { item: "c", index: 2, path: "root/loop[2]" }
    ]);
    expect(runtime.context.item).toBeUndefined();
    expect([...rows.values()].filter((entry) => entry.stepKey === "body").map((entry) => entry.iterationIndex)).toEqual([0, 1, 2]);
  });

  it("continues after an exhausted iteration failure and marks it handled", async () => {
    const rows = new Map<string, any>();
    const loopRow = row("loop-id", "loop", "root", null, StepExecutionStatus.Pending);
    rows.set(loopRow.id, loopRow);
    const prisma = fakePrisma(rows);
    const stepExecutor = fakeStepExecutor(rows, async (input: any) => {
      if (input.context.index === 0) throw new Error("bad item");
      return { outcome: "completed", result: { status: StepExecutionStatus.Completed, output: input.context.item } };
    });
    const service = new ForEachExecutionService(prisma as any, stepExecutor as any, new ExpressionResolver());
    const runtime = new ExecutionRuntimeContext({ trigger: { body: { items: [1, 2] } }, steps: {}, variables: {}, metadata: { expressionMode: "strict" }, workflow: { variables: {} }, execution: {} });
    const result = await service.execute({ organizationId: "org", executionId: "execution", loopStep: { key: "loop", name: "Loop", type: StepType.ForEach, position: 1, config: { source: "{{trigger.body.items}}", continueOnError: true } }, loopStepExecution: loopRow, graph: { entryStepKey: "loop", edges: [{ from: "loop", to: "body", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" }, { from: "body", to: "done", kind: "next" }] }, bodyEntryStepKey: "body", doneStepKey: "done", bodyStepKeys: new Set(["body"]), stepRowsByKey: new Map([["body", { id: "body-step", key: "body", name: "Body", type: StepType.Transform, position: 2, configJson: {}, retryPolicyJson: null, timeoutSeconds: 30 }]]), runtimeContext: runtime });
    expect(result.outcome).toBe("completed");
    if (result.outcome === "completed") expect(result.output).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect([...rows.values()].find((entry) => entry.iterationIndex === 0)?.errorHandled).toBe(true);
  });
});

function row(id: string, stepKey: string, executionPath: string, iterationIndex: number | null, status: StepExecutionStatus) {
  return { id, stepKey, stepType: stepKey === "loop" ? "for_each" : "transform", executionPath, iterationIndex, status, attemptCount: 0, maxAttempts: 1, effectKey: `effect:${executionPath}:${stepKey}`, effectStatus: null, inputJson: {}, outputJson: null, errorJson: null, startedAt: null, completedAt: null, errorHandled: false, createdAt: new Date() };
}

function fakePrisma(rows: Map<string, any>) {
  return {
    stepExecution: {
      findMany: async ({ where }: any) => [...rows.values()].filter((entry) => entry.executionPath === where.executionPath),
      update: async ({ where, data }: any) => { const current = rows.get(where.id); Object.assign(current, data); return current; },
      findUniqueOrThrow: async ({ where }: any) => rows.get(where.id)
    },
    auditLog: { create: async () => ({}) }
  };
}

function fakeStepExecutor(rows: Map<string, any>, executeHandler: (input: any) => Promise<any>) {
  return {
    ensure: async (input: any) => {
      const existing = [...rows.values()].find((entry) => entry.stepKey === input.step.key && entry.executionPath === input.executionPath);
      if (existing) return existing;
      const created = row(`${input.executionPath}:${input.step.key}`, input.step.key, input.executionPath, input.iterationIndex, StepExecutionStatus.Pending);
      rows.set(created.id, created);
      return created;
    },
    execute: async (input: any) => {
      const target = rows.get(input.stepExecution.id);
      try {
        const outcome = await executeHandler(input);
        Object.assign(target, { status: StepExecutionStatus.Completed, outputJson: outcome.result.output, attemptCount: 1, effectStatus: "succeeded" });
        return outcome;
      } catch (error) {
        Object.assign(target, { status: StepExecutionStatus.Failed, attemptCount: 1, errorJson: { message: error instanceof Error ? error.message : String(error), classification: "non_retryable" }, effectStatus: "failed" });
        throw error;
      }
    },
    skip: async () => { throw new Error("unexpected skip"); },
    completeWait: async () => { throw new Error("unexpected wait"); }
  };
}
