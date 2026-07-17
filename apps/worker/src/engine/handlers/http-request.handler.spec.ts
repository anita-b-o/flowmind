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
        resolveHttp: async () => ({
          id: "conn-1",
          type: "HTTP",
          authScheme: "API_KEY",
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

  it("injects bearer, basic and custom header connections", async () => {
    const requests: any[] = [];
    const makeHandler = (connection: any) =>
      new HttpRequestHandler(
        new ExpressionResolver(),
        {
          request: async (input: any) => {
            requests.push(input);
            return { status: 200, ok: true, body: {}, headers: {} };
          }
        } as any,
        { resolveHttp: async () => connection } as any
      );

    await makeHandler({ id: "bearer", type: "HTTP", authScheme: "BEARER", secretValue: "token", additionalHeaders: {} }).execute(step(), context());
    await makeHandler({ id: "basic", type: "HTTP", authScheme: "BASIC", username: "ada", secretValue: "pass", additionalHeaders: {} }).execute(step(), context());
    await makeHandler({ id: "custom", type: "HTTP", authScheme: "CUSTOM_HEADERS", secretHeaders: { "X-Api-Key": "key" }, additionalHeaders: {} }).execute(step(), context());

    expect(requests[0].headers.Authorization).toBe("Bearer token");
    expect(requests[1].headers.Authorization).toBe(`Basic ${Buffer.from("ada:pass").toString("base64")}`);
    expect(requests[2].headers["X-Api-Key"]).toBe("key");
    expect(JSON.stringify(requests.map((request) => request.allowedRestrictedHeaders))).toContain("Authorization");
  });

  it("applies secure header precedence and preserves query params for query API keys", async () => {
    const requests: any[] = [];
    const handler = new HttpRequestHandler(
      new ExpressionResolver(),
      {
        request: async (input: any) => {
          requests.push(input);
          return { status: 200, ok: true, body: {}, headers: {} };
        }
      } as any,
      {
        resolveHttp: async () => ({
          id: "conn-1",
          type: "HTTP",
          authScheme: "API_KEY",
          authLocation: "QUERY",
          authName: "api_key",
          secretValue: "query-secret",
          baseUrl: "https://api.example.com/root?tenant=acme",
          additionalHeaders: { "X-Client": "connection", "X-Default": "connection" }
        })
      } as any
    );

    await handler.execute(
      {
        ...step(),
        config: { connectionId: "conn-1", method: "GET", url: "/leads?existing=1", headers: { "X-Client": "step" } }
      },
      context()
    );

    const url = new URL(requests[0].url);
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("api_key")).toBe("query-secret");
    expect(requests[0].headers["X-Client"]).toBe("connection");
    expect(requests[0].headers["X-Default"]).toBe("connection");
  });
});

function step() {
  return {
    key: "get",
    name: "Get",
    type: StepType.HttpRequest,
    position: 1,
    config: { connectionId: "conn-1", method: "GET", url: "https://example.com" }
  };
}

function context() {
  return { trigger: {}, steps: {}, metadata: { runtime: { organizationId: "org-1", effectKey: "effect-1" } } };
}
