import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { AiHandler } from "./ai.handler";

describe("AiHandler trace propagation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("propagates request and correlation headers without exposing the service API key to logs", async () => {
    const calls: any[] = [];
    global.fetch = jest.fn(async (_url, init: any) => {
      calls.push(init);
      return { ok: true, json: async () => ({ summary: "ok" }) };
    }) as any;
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const handler = new AiHandler(
      { resolveValue: (value: unknown) => value } as any,
      {
        getContext: () => ({
          requestId: "worker-request-1",
          parentRequestId: "parent-request-1",
          correlationId: "ai-correlation-1",
          executionId: "execution-1",
          organizationId: "org-1",
          workflowId: "workflow-1",
          workflowVersionId: "version-1",
          workerId: "worker-1"
        })
      } as any,
      logger as any
    );

    const result = await handler.execute(
      { key: "ai", name: "AI", type: StepType.AiSummary, position: 1, config: { text: "hello" } },
      {
        trigger: {},
        steps: {},
        metadata: { runtime: { executionId: "execution-1", stepExecutionId: "step-execution-1" } }
      }
    );

    expect(result.status).toBe(StepExecutionStatus.Completed);
    expect(calls[0].headers["x-request-id"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(calls[0].headers["x-correlation-id"]).toBe("ai-correlation-1");
    expect(calls[0].headers["x-execution-id"]).toBe("execution-1");
    expect(calls[0].headers["x-step-execution-id"]).toBe("step-execution-1");
    expect(JSON.stringify(logger)).not.toContain("dev-ai-service-key");
  });
});
