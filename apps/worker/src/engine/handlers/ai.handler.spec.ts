import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { AiHandler } from "./ai.handler";
import { EmbeddedFakeAiGateway, HttpAiGateway } from "./ai-gateway";

describe("AiHandler trace propagation", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.AI_SERVICE_URL;
  const originalKey = process.env.AI_SERVICE_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    restoreEnv("AI_SERVICE_URL", originalUrl);
    restoreEnv("AI_SERVICE_API_KEY", originalKey);
  });

  it("propagates request and correlation headers without exposing the service API key to logs", async () => {
    const calls: any[] = [];
    process.env.AI_SERVICE_URL = "http://ai-service.test";
    process.env.AI_SERVICE_API_KEY = "test-service-key";
    global.fetch = jest.fn(async (_url, init: any) => {
      calls.push(init);
      return { ok: true, json: async () => ({ summary: "ok" }) };
    }) as any;
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const handler = new AiHandler(
      { resolveValue: (value: unknown) => value } as any,
      new HttpAiGateway(logger as any),
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
      } as any
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

  it("uses deterministic embedded output without an HTTP request", async () => {
    global.fetch = jest.fn() as any;
    const handler = new AiHandler(
      { resolveValue: (value: unknown) => value } as any,
      new EmbeddedFakeAiGateway()
    );
    const result = await handler.execute(
      {
        key: "classify",
        name: "Classify",
        type: StepType.AiClassification,
        position: 1,
        config: { text: "Urgent portfolio lead" }
      },
      { trigger: {}, steps: {}, metadata: {} }
    );
    expect(result.output).toMatchObject({
      label: "high",
      confidence: 0.9,
      usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 }
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
