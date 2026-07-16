import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { ExpressionResolver } from "../expression-resolver";
import { HttpRequestHandler } from "./http-request.handler";

describe("HttpRequestHandler connections", () => {
  it("injects API key headers without returning the secret", async () => {
    const requests: any[] = [];
    const handler = new HttpRequestHandler(
      new ExpressionResolver(),
      {
        request: async (input: any) => {
          requests.push(input);
          return { status: 200, ok: true, body: { ok: true }, headers: {} };
        }
      } as any,
      {
        resolveHttpApiKey: async () => ({
          id: "conn-1",
          type: "HTTP_API_KEY",
          authLocation: "HEADER",
          authName: "Authorization",
          secretValue: "Bearer secret",
          additionalHeaders: { "x-client": "flowmind" }
        })
      } as any
    );

    const result = await handler.execute(
      {
        key: "post",
        name: "Post",
        type: StepType.HttpRequest,
        position: 1,
        config: { connectionId: "conn-1", method: "POST", url: "https://example.com/leads", headers: {}, body: { ok: true } }
      },
      { trigger: {}, steps: {}, metadata: { runtime: { organizationId: "org-1", effectKey: "effect-1" } } }
    );

    expect(requests[0].headers.Authorization).toBe("Bearer secret");
    expect(requests[0].headers["x-client"]).toBe("flowmind");
    expect(requests[0].allowedRestrictedHeaders).toEqual(["Authorization"]);
    expect(JSON.stringify(result)).not.toContain("Bearer secret");
    expect(result.status).toBe(StepExecutionStatus.Completed);
  });
});
