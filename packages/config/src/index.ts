import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),
  REFRESH_COOKIE_NAME: z.string().default("refresh_token"),
  REFRESH_COOKIE_DOMAIN: z.string().optional(),
  REFRESH_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  SESSION_IP_HASH_PEPPER: z.string().min(16).default("change-me-session-ip-pepper"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  AUTH_ORIGIN_REQUIRED: z.coerce.boolean().optional(),
  SECRET_ENCRYPTION_KEY: z.string().min(16),
  CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  CONNECTION_ENCRYPTION_VERSION: z.coerce.number().int().positive().default(1),
  CONNECTION_TEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  AI_SERVICE_URL: z.string().url(),
  AI_SERVICE_API_KEY: z.string().min(8),
  PUBLIC_API_URL: z.string().url().default("http://localhost:3001"),
  WEBHOOK_TOKEN_PEPPER: z.string().min(16).default("change-me-webhook-token-pepper"),
  WEBHOOK_PAYLOAD_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
  WEBHOOK_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  WEBHOOK_BURST_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  EXECUTION_LEASE_DURATION_MS: z.coerce.number().int().positive().default(60_000),
  EXECUTION_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  EXECUTION_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  NOTIFICATION_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  NOTIFICATION_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  NOTIFICATION_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(300_000),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  METRICS_ENABLED: z.coerce.boolean().default(false),
  METRICS_API_KEY: z.string().default(""),
  METRICS_HOST: z.string().ip().default("127.0.0.1"),
  API_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
  AI_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9466),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  LOG_REDACT_ENABLED: z.coerce.boolean().default(true),
  MAX_LOG_PAYLOAD_BYTES: z.coerce.number().int().positive().default(16_384),
  REQUEST_ID_HEADER: z.string().default("x-request-id"),
  CORRELATION_ID_HEADER: z.string().default("x-correlation-id")
});

const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3001")
});

const mailEnvSchema = z.object({
  MAIL_HOST: z.string().default("localhost"),
  MAIL_PORT: z.coerce.number().int().positive().default(1025)
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type MailEnv = z.infer<typeof mailEnvSchema>;

export function parseBaseEnv(env: NodeJS.ProcessEnv): BaseEnv {
  const parsed = baseEnvSchema.parse(env);
  validateMetricsConfig(parsed);
  validateConnectionEncryptionConfig(parsed);
  return parsed;
}

export function parseWebEnv(env: NodeJS.ProcessEnv): WebEnv {
  return webEnvSchema.parse(env);
}

export function parseMailEnv(env: NodeJS.ProcessEnv): MailEnv {
  return mailEnvSchema.parse(env);
}

function validateMetricsConfig(env: BaseEnv) {
  if (!env.METRICS_ENABLED) {
    return;
  }
  if (env.NODE_ENV === "production" && !isNonTrivialMetricsKey(env.METRICS_API_KEY)) {
    throw new Error("METRICS_API_KEY must be configured with a non-trivial value when metrics are enabled in production");
  }
}

function isNonTrivialMetricsKey(value: string) {
  const trimmed = value.trim();
  return trimmed.length >= 16 && !["change-me", "changeme", "dev", "test", "password", "metrics"].includes(trimmed.toLowerCase());
}

function validateConnectionEncryptionConfig(env: BaseEnv) {
  if (!env.CONNECTION_ENCRYPTION_KEY) {
    if (env.NODE_ENV === "production") {
      throw new Error("CONNECTION_ENCRYPTION_KEY must be configured in production");
    }
    return;
  }
  decodeConnectionKey(env.CONNECTION_ENCRYPTION_KEY);
}

function decodeConnectionKey(value: string) {
  const [prefix, encoded] = value.includes(":") ? value.split(":", 2) : ["base64", value];
  const buffer = prefix === "hex" ? Buffer.from(encoded, "hex") : prefix === "base64" ? Buffer.from(encoded, "base64") : undefined;
  if (!buffer || buffer.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must be base64:<32 bytes> or hex:<32 bytes>");
  }
  return buffer;
}
