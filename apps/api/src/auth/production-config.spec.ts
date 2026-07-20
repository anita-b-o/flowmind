import { parseBaseEnv, redisConnectionOptions } from "@automation/config";

const validProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://db.example/flowmind",
  REDIS_URL: "rediss://queue-user:queue-pass@redis.example:6380/3",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  SESSION_IP_HASH_PEPPER: "c".repeat(32),
  SECRET_ENCRYPTION_KEY: "legacy-secret-key-at-least-32-bytes",
  CONNECTION_ENCRYPTION_KEY: `base64:${Buffer.alloc(32, 1).toString("base64")}`,
  AI_SERVICE_URL: "https://ai.example",
  AI_SERVICE_API_KEY: "d".repeat(32),
  WEBHOOK_TOKEN_PEPPER: "e".repeat(32)
};

describe("production configuration", () => {
  it("rejects known defaults and cross-site refresh cookies without CSRF", () => {
    expect(() => parseBaseEnv({ ...validProduction, JWT_ACCESS_SECRET: "change-me-access-secret" })).toThrow("JWT_ACCESS_SECRET");
    expect(() => parseBaseEnv({ ...validProduction, REFRESH_COOKIE_SAME_SITE: "none" })).toThrow("CSRF");
  });

  it("accepts strong production configuration", () => {
    expect(parseBaseEnv(validProduction).NODE_ENV).toBe("production");
  });

  it("preserves Redis credentials, database and TLS for BullMQ", () => {
    expect(redisConnectionOptions("rediss://queue%2Duser:p%40ss@redis.example:6381/4")).toEqual({
      host: "redis.example",
      port: 6381,
      username: "queue-user",
      password: "p@ss",
      db: 4,
      tls: {}
    });
  });
});
