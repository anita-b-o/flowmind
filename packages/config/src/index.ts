import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  SECRET_ENCRYPTION_KEY: z.string().min(16),
  AI_SERVICE_URL: z.string().url(),
  AI_SERVICE_API_KEY: z.string().min(8),
  PUBLIC_API_URL: z.string().url().default("http://localhost:3001"),
  WEBHOOK_TOKEN_PEPPER: z.string().min(16).default("change-me-webhook-token-pepper"),
  WEBHOOK_PAYLOAD_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
  WEBHOOK_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  WEBHOOK_BURST_LIMIT_MAX: z.coerce.number().int().positive().default(10)
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
  return baseEnvSchema.parse(env);
}

export function parseWebEnv(env: NodeJS.ProcessEnv): WebEnv {
  return webEnvSchema.parse(env);
}

export function parseMailEnv(env: NodeJS.ProcessEnv): MailEnv {
  return mailEnvSchema.parse(env);
}
