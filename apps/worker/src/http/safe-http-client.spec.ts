import { SafeHttpClient } from "./safe-http-client";
import { isBlockedIp } from "./ip-range";

describe("SafeHttpClient", () => {
  it.each(["127.0.0.1", "0.0.0.0", "10.1.1.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"])(
    "blocks %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    }
  );

  it("allows a public URL and parses JSON", async () => {
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fakeFetch(200, { ok: true }));
    await expect(client.request({ url: "https://example.com/data" })).resolves.toMatchObject({
      status: 200,
      body: { ok: true }
    });
  });

  it("blocks DNS resolving to private IP", async () => {
    const client = new SafeHttpClient(async () => ["127.0.0.1"], fakeFetch(200, {}));
    await expect(client.request({ url: "https://example.com" })).rejects.toThrow("Private, reserved or metadata IP");
  });

  it("blocks public redirect to private target", async () => {
    const client = new SafeHttpClient(
      async (hostname) => (hostname === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"]),
      fakeFetch(302, "", { location: "http://internal.local" })
    );
    await expect(client.request({ url: "https://example.com" })).rejects.toThrow("Private, reserved or metadata IP");
  });

  it("blocks a same-host HTTPS to HTTP redirect before sending credentials", async () => {
    const fetcher = sequenceFetch(
      { status: 302, headers: { location: "http://example.com/end" } },
      { status: 200, body: "unexpected" }
    );
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fetcher.fetch);

    const error = await client.request({ url: "https://example.com/start", headers: { Authorization: "Bearer test-secret" }, allowedRestrictedHeaders: ["Authorization"] }).catch((cause) => cause);
    expect(error).toHaveProperty("message", "Redirect from HTTPS to HTTP is not allowed");
    expect(String(error)).not.toContain("test-secret");
    expect(fetcher.requests).toHaveLength(1);
    expect(fetcher.requests[0].headers.Authorization).toBe("Bearer test-secret");
  });

  it("does not forward standard or secret-backed headers across hosts", async () => {
    const fetcher = sequenceFetch(
      { status: 302, headers: { location: "https://b.test/end" } },
      { status: 200, body: { ok: true } }
    );
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fetcher.fetch);

    await client.request({
      url: "https://a.test/start",
      headers: { Authorization: "Bearer test-secret", "Proxy-Authorization": "Basic test-secret", Cookie: "session=test-secret", "X-Api-Key": "test-secret", Accept: "application/json" },
      allowedRestrictedHeaders: ["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key"]
    });

    expect(fetcher.requests[1].headers).toEqual({ "content-type": "application/json" });
  });

  it("preserves headers on a same-origin HTTPS redirect", async () => {
    const fetcher = sequenceFetch(
      { status: 302, headers: { location: "/two" } },
      { status: 200, body: { ok: true } }
    );
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fetcher.fetch);

    await client.request({ url: "https://a.test/one", headers: { Authorization: "Bearer test-secret" }, allowedRestrictedHeaders: ["Authorization"] });

    expect(fetcher.requests[1].url).toBe("https://a.test/two");
    expect(fetcher.requests[1].headers.Authorization).toBe("Bearer test-secret");
  });

  it("permits an HTTP to HTTPS redirect and preserves same-host headers", async () => {
    const fetcher = sequenceFetch(
      { status: 302, headers: { location: "https://a.test/two" } },
      { status: 200, body: { ok: true } }
    );
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fetcher.fetch);

    await client.request({ url: "http://a.test/one", headers: { Authorization: "Bearer test-secret" }, allowedRestrictedHeaders: ["Authorization"] });

    expect(fetcher.requests[1].headers.Authorization).toBe("Bearer test-secret");
  });

  it("blocks a downgrade at the unsafe hop in a redirect chain", async () => {
    const fetcher = sequenceFetch(
      { status: 302, headers: { location: "https://a.test/two" } },
      { status: 302, headers: { location: "https://b.test/three" } },
      { status: 302, headers: { location: "http://b.test/four" } }
    );
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fetcher.fetch);

    await expect(client.request({ url: "https://a.test/one", headers: { Authorization: "Bearer test-secret" }, allowedRestrictedHeaders: ["Authorization"] })).rejects.toThrow(
      "Redirect from HTTPS to HTTP is not allowed"
    );
    expect(fetcher.requests).toHaveLength(3);
    expect(fetcher.requests[2].headers.Authorization).toBeUndefined();
  });

  it("rejects too large responses", async () => {
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fakeFetch(200, "x".repeat(20), { "content-length": "20" }));
    await expect(client.request({ url: "https://example.com", maxResponseBytes: 5 })).rejects.toThrow("too large");
  });

  it("rejects unsafe URL credentials and headers", async () => {
    const client = new SafeHttpClient(async () => ["93.184.216.34"], fakeFetch(200, "ok"));
    await expect(client.request({ url: "https://user:pass@example.com" })).rejects.toThrow("credentials");
    await expect(client.request({ url: "https://example.com", headers: { authorization: "secret" } })).rejects.toThrow("not allowed");
    await expect(client.request({ url: "https://example.com", headers: { "Transfer-Encoding": "chunked" } })).rejects.toThrow("not allowed");
  });
});

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers
    })) as typeof fetch;
}

function sequenceFetch(...responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""), {
      status: response.status,
      headers: response.headers
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
