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
