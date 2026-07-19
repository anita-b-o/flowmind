import { ExecutionRuntimeContext } from "./execution-runtime-context";

describe("ExecutionRuntimeContext error frames", () => {
  it("adds a scoped error without leaking it to Catch parent or Done", () => {
    const runtime = new ExecutionRuntimeContext({ trigger: { body: {} }, steps: {}, variables: {}, metadata: {}, workflow: {}, execution: {} });
    const frame = runtime.createErrorFrame(runtime.context, { message: "safe", category: "non_retryable", stepKey: "failed" });
    expect(frame.error).toEqual({ message: "safe", category: "non_retryable", stepKey: "failed" });
    expect(runtime.context.error).toBeUndefined();
    expect(runtime.snapshot({ includeRuntime: false }).error).toBeUndefined();
  });

  it("composes error with an iteration frame", () => {
    const runtime = new ExecutionRuntimeContext({ trigger: {}, steps: {}, variables: {}, metadata: {}, workflow: {}, execution: {} });
    const iteration = runtime.createIterationFrame({ item: { id: 1 }, index: 3 });
    const frame = runtime.createErrorFrame(iteration, { category: "retryable" });
    expect(frame.item).toEqual({ id: 1 });
    expect(frame.index).toBe(3);
    expect(frame.error?.category).toBe("retryable");
  });
});

describe("ExecutionRuntimeContext recovery checkpoint", () => {
  it("keeps independent initial/current execution and workflow variables", () => {
    const runtime = new ExecutionRuntimeContext({ trigger: {}, steps: {}, variables: {}, metadata: {}, workflow: { variables: { workflowValue: 1 } }, execution: {} });
    runtime.set("execution", "count", 1);
    runtime.set("workflow", "workflowValue", 2);
    const snapshot = runtime.snapshot({ includeRuntime: true }) as any;
    expect(snapshot.recoveryCheckpoint).toMatchObject({ schemaVersion: 1, complete: true, initialExecutionVariables: {}, initialWorkflowVariables: { workflowValue: 1 }, executionVariables: { count: 1 }, workflowVariables: { workflowValue: 2 } });
    const recovered = new ExecutionRuntimeContext({ trigger: {}, steps: {}, variables: {}, metadata: {}, workflow: { variables: {} }, execution: {} }, snapshot.__runtime);
    recovered.set("execution", "count", 3);
    expect(snapshot.__runtime.variables.count).toBe(1);
  });
});
