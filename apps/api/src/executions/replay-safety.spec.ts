import { ExecutionReplayMode } from "@automation/shared-types";
import { ExecutionsService } from "./executions.service";
import { containsUnavailableRecoveryValue, replaySafety } from "./replay-safety";

describe("execution replay safety", () => {
  it("classifies mutation effects and detects unavailable persisted values", () => {
    expect(replaySafety("http_request", { method: "GET" })).toBe("READ_ONLY");
    expect(replaySafety("http_request", { method: "POST" })).toBe("SIDE_EFFECT");
    expect(replaySafety("database_record", {})).toBe("SIDE_EFFECT");
    expect(containsUnavailableRecoveryValue({ body: { token: "[redacted]" } })).toBe(true);
    expect(containsUnavailableRecoveryValue({ body: { ok: true } })).toBe(false);
  });

  it("previews a version-pinned full replay with an explicit side-effect warning", async () => {
    const source = executionFixture();
    const service = new ExecutionsService({ execution: { findFirst: jest.fn().mockResolvedValue(source) } } as any, {} as any);
    const preview = await service.replayPreview("org-1", "execution-1", ExecutionReplayMode.FullReplay);
    expect(preview).toMatchObject({ possible: true, workflowVersionId: "version-1", warnings: ["This replay may repeat side effects."] });
    expect(preview.sideEffects.map((step) => step.stepKey)).toContain("write");
  });

  it("selects the nested unhandled failure and reuses only durable predecessors", async () => {
    const source = executionFixture();
    source.status = "FAILED";
    source.steps = [
      step("loop", "for_each", "root", "FAILED", 0),
      step("write", "database_record", "root/loop[0]", "COMPLETED", 1),
      step("transform", "transform", "root/loop[1]", "FAILED", 2)
    ];
    source.steps[0].inputJson = { forEachState: { items: [1, 2], nextIndex: 1, currentStepKey: "transform" } };
    const service = new ExecutionsService({ execution: { findFirst: jest.fn().mockResolvedValue(source) } } as any, {} as any);
    const preview = await service.replayPreview("org-1", "execution-1", ExecutionReplayMode.RetryFromFailure);
    expect(preview.possible).toBe(true);
    expect(preview.startingPoint).toEqual({ stepKey: "transform", executionPath: "root/loop[1]", iterationIndex: 2 });
    expect(preview.reusedSteps.map((step) => step.stepKey)).toEqual(["write"]);
  });

  it("does not treat a handled TRY_CATCH failure as a recovery candidate", async () => {
    const source = executionFixture();
    source.status = "COMPLETED";
    source.steps = [step("body", "transform", "root/try[guard]/body", "FAILED", 1)];
    source.steps[0].errorHandled = true;
    const service = serviceFor(source);

    const preview = await service.replayPreview("org-1", "execution-1", ExecutionReplayMode.RetryFromFailure);

    expect(preview).toMatchObject({ possible: false, reason: "SOURCE_NOT_FAILED" });
    expect(preview.blockedReasons).toContain("UNHANDLED_FAILURE_NOT_FOUND");
  });

  it("reuses only a durable terminal approval decision", async () => {
    const source = executionFixture();
    source.status = "FAILED";
    const approval = step("approval", "approval", "root", "COMPLETED", 1);
    source.steps = [approval, step("transform", "transform", "root", "FAILED", 2)];
    source.approvalRequests = [{ stepExecutionId: approval.id, status: "APPROVED" }];
    expect((await serviceFor(source).replayPreview("org-1", "execution-1", ExecutionReplayMode.RetryFromFailure)).possible).toBe(true);

    source.approvalRequests = [{ stepExecutionId: approval.id, status: "EXPIRED" }];
    const blocked = await serviceFor(source).replayPreview("org-1", "execution-1", ExecutionReplayMode.RetryFromFailure);
    expect(blocked).toMatchObject({ possible: false, reason: "APPROVAL_DECISION_UNAVAILABLE" });
  });
});

function executionFixture(): any {
  return {
    id: "execution-1", organizationId: "org-1", workflowId: "workflow-1", workflowVersionId: "version-1", status: "COMPLETED",
    inputJson: { trigger: { body: { id: 1 } } }, contextJson: { __runtime: { variables: {} }, recoveryCheckpoint: { schemaVersion: 1, complete: true, initialExecutionVariables: {}, initialWorkflowVariables: {} } },
    workflowVersion: { id: "version-1", organizationId: "org-1", workflowId: "workflow-1", steps: [
      { key: "write", type: "database_record", position: 1, configJson: {} }, { key: "transform", type: "transform", position: 2, configJson: {} }
    ] }, steps: [], approvalRequests: []
  };
}
function step(stepKey: string, stepType: string, executionPath: string, status: string, order: number): any { return { id: `step-${order}`, stepKey, stepType, executionPath, iterationIndex: order || null, status, errorHandled: false, outputJson: { ok: true }, inputJson: {}, createdAt: new Date(1_000 + order) }; }
function serviceFor(source: any) { return new ExecutionsService({ execution: { findFirst: jest.fn().mockResolvedValue(source) } } as any, {} as any); }
