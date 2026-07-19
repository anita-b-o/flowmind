import { publicError, sanitizePublic } from "./public-sanitizer";

describe("public execution sanitization", () => {
  it("recursively redacts debugger-sensitive values", () => {
    const sanitized = sanitizePublic({ headers: { authorization: "Bearer secret", Cookie: "sid=secret", "set-cookie": "sid=secret", "x-api-key": "secret" }, nested: [{ password: "pw", accessToken: "access", refresh_token: "refresh", encryptedValue: "cipher" }], safe: "hello" }) as any;
    expectRedacted(sanitized.headers.authorization);
    expectRedacted(sanitized.headers.Cookie);
    expectRedacted(sanitized.headers["set-cookie"]);
    expectRedacted(sanitized.headers["x-api-key"]);
    expectRedacted(sanitized.nested[0].password);
    expectRedacted(sanitized.nested[0].accessToken);
    expectRedacted(sanitized.nested[0].refresh_token);
    expectRedacted(sanitized.nested[0].encryptedValue);
    expect(sanitized.safe).toBe("hello");
  });
  it("exposes only a bounded safe error contract", () => {
    expect(publicError({ classification: "timeout", code: "STEP_TIMEOUT", message: "Timed out", stack: "secret stack", cause: { token: "secret" } })).toEqual({
      category: "timeout",
      code: "STEP_TIMEOUT",
      messageSafe: "Timed out"
    });
  });

  it.each([
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "Basic dXNlcjpwYXNzd29yZA==",
    "https://user:password@example.com/path",
    "postgresql://dbuser:dbpassword@database.internal/app",
    "-----BEGIN PRIVATE KEY----- secret",
    "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop"
  ])("redacts credential-shaped strings: %s", (secret) => {
    expect(sanitizePublic({ harmlessName: secret })).toEqual({ harmlessName: "[redacted]" });
  });

  it("removes stack and provider bodies by key", () => {
    expect(sanitizePublic({ stack: "trace", responseBody: "raw", providerRequest: { body: "raw" }, smtpCredentials: "smtp-secret", connectionString: "postgres://u:p@db/app", safe: "visible" })).toEqual({
      stack: "[redacted]",
      responseBody: "[redacted]",
      providerRequest: "[redacted]",
      smtpCredentials: "[redacted]",
      connectionString: "[redacted]",
      safe: "visible"
    });
  });
});

function expectRedacted(value: unknown) {
  expect(String(value).toLowerCase()).toBe("[redacted]");
}
