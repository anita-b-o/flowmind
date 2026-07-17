import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { TestRuntimePolicy } from "./test-runtime-policy";

describe("TestRuntimePolicy", () => {
  function policy(testRun: { externalMode: "mock" | "real"; stepMocksJson?: unknown }) {
    return new TestRuntimePolicy({
      execution: {
        findUnique: jest.fn().mockResolvedValue({
          executionMode: "TEST",
          testRun: { stepMocksJson: {}, ...testRun }
        })
      }
    } as any);
  }

  it("mocks HTTP without running the real handler", async () => {
    const decision = await policy({ externalMode: "mock" }).decide({
      executionId: "execution-1",
      step: { key: "call_api", name: "Call API", type: StepType.HttpRequest, position: 1, config: {} },
      resolvedConfig: { url: "https://example.test" }
    });

    expect(decision.kind).toBe("mock");
    expect(decision.kind === "mock" ? decision.result.output : undefined).toMatchObject({ simulated: true, kind: "http", status: 200 });
  });

  it("keeps database steps dry-run even in real mode", async () => {
    const decision = await policy({ externalMode: "real" }).decide({
      executionId: "execution-1",
      step: { key: "write_record", name: "Write", type: StepType.DatabaseRecord, position: 1, config: {} },
      resolvedConfig: { collection: "orders", data: { id: 1 } }
    });

    expect(decision.kind).toBe("mock");
    expect(decision.kind === "mock" ? decision.result.output : undefined).toMatchObject({ dryRun: true, simulated: true, wouldPersist: true });
  });

  it("allows non-database side effects to run in confirmed real mode", async () => {
    const decision = await policy({ externalMode: "real" }).decide({
      executionId: "execution-1",
      step: { key: "send_email", name: "Email", type: StepType.EmailNotification, position: 1, config: {} },
      resolvedConfig: { to: "ada@example.com" }
    });

    expect(decision).toEqual({ kind: "run_real" });
  });

  it("returns simulated AI output and simulated errors", async () => {
    const aiDecision = await policy({
      externalMode: "mock",
      stepMocksJson: { classify: { ai: { response: { label: "vip" }, inputTokens: 2, outputTokens: 1 } } }
    }).decide({
      executionId: "execution-1",
      step: { key: "classify", name: "Classify", type: StepType.AiClassification, position: 1, config: {} },
      resolvedConfig: {}
    });
    expect(aiDecision.kind === "mock" ? aiDecision.result : undefined).toMatchObject({
      status: StepExecutionStatus.Completed,
      output: { simulated: true, mock: true, response: { label: "vip" } }
    });

    const errorDecision = await policy({
      externalMode: "mock",
      stepMocksJson: { classify: { behavior: "simulated_error", error: { message: "boom" } } }
    }).decide({
      executionId: "execution-1",
      step: { key: "classify", name: "Classify", type: StepType.AiClassification, position: 1, config: {} },
      resolvedConfig: {}
    });
    expect(errorDecision.kind).toBe("error");
    expect(errorDecision.kind === "error" ? errorDecision.error.message : "").toBe("boom");
  });
});
