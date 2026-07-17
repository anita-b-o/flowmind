import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeForLog } from "./index";

test("sanitizeForLog redacts normalized sensitive keys without broad partial matches", () => {
  const sanitized = sanitizeForLog({
    headers: {
      authorization: "Bearer secret",
      "proxy-authorization": "Basic secret",
      Cookie: "sid=secret",
      "set-cookie": "sid=secret",
      "x-api-key": "secret",
      "api-key": "secret",
      api_key: "secret",
      token: "secret",
      access_token: "secret",
      refresh_token: "secret",
      password: "secret",
      secret: "secret",
      client_secret: "secret",
      clientSecret: "secret",
      tokenizedLabel: "keep"
    }
  }) as { headers: Record<string, unknown> };

  assert.equal(sanitized.headers.authorization, "[REDACTED]");
  assert.equal(sanitized.headers["proxy-authorization"], "[REDACTED]");
  assert.equal(sanitized.headers.Cookie, "[REDACTED]");
  assert.equal(sanitized.headers["set-cookie"], "[REDACTED]");
  assert.equal(sanitized.headers["x-api-key"], "[REDACTED]");
  assert.equal(sanitized.headers["api-key"], "[REDACTED]");
  assert.equal(sanitized.headers.api_key, "[REDACTED]");
  assert.equal(sanitized.headers.token, "[REDACTED]");
  assert.equal(sanitized.headers.access_token, "[REDACTED]");
  assert.equal(sanitized.headers.refresh_token, "[REDACTED]");
  assert.equal(sanitized.headers.password, "[REDACTED]");
  assert.equal(sanitized.headers.secret, "[REDACTED]");
  assert.equal(sanitized.headers.client_secret, "[REDACTED]");
  assert.equal(sanitized.headers.clientSecret, "[REDACTED]");
  assert.equal(sanitized.headers.tokenizedLabel, "keep");
});
