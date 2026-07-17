import { sanitizePublic } from "./public-sanitizer";

describe("sanitizePublic", () => {
  it("recursively redacts debugger-sensitive values", () => {
    const sanitized = sanitizePublic({
      headers: {
        authorization: "Bearer secret",
        Cookie: "sid=secret",
        "set-cookie": "sid=secret",
        "x-api-key": "secret"
      },
      nested: [
        {
          password: "pw",
          accessToken: "access",
          refresh_token: "refresh",
          encryptedValue: "cipher"
        }
      ],
      safe: "hello"
    }) as any;

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
});

function expectRedacted(value: unknown) {
  expect(String(value).toLowerCase()).toBe("[redacted]");
}
