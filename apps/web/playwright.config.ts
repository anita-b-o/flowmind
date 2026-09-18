import { defineConfig, devices } from "@playwright/test";

const databaseUrl = requiredTestDatabaseUrl();
const redisUrl = requiredIsolatedRedisUrl();
const runtimeEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  JWT_ACCESS_SECRET: "playwright-access-secret",
  JWT_REFRESH_SECRET: "playwright-refresh-secret",
  SESSION_IP_HASH_PEPPER: "playwright-session-pepper",
  SECRET_ENCRYPTION_KEY: "playwright-secret-key",
  CONNECTION_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  AI_SERVICE_URL: "http://127.0.0.1:8000",
  AI_SERVICE_API_KEY: "playwright-ai-key",
  PUBLIC_API_URL: "http://127.0.0.1:3001",
  WEBHOOK_TOKEN_PEPPER: "playwright-webhook-pepper",
  FLOWMIND_DEPLOYMENT_PROFILE: "demo-free",
  FLOWMIND_AI_MODE: "embedded-fake",
  FLOWMIND_EMAIL_MODE: "embedded-fake",
  DEMO_REGISTRATION_ENABLED: "true",
  AUTH_ORIGIN_REQUIRED: "false",
  CORS_ORIGIN: "http://127.0.0.1:3100",
  PUBLIC_APP_URL: "http://127.0.0.1:3100"
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: [
    {
      command: "corepack pnpm --filter @automation/demo-runtime... build && corepack pnpm --filter @automation/demo-runtime start:prod",
      env: runtimeEnv,
      url: "http://127.0.0.1:3001/health/ready",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "env NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 corepack pnpm dev --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/login",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ],
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ]
});

function requiredTestDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("Playwright requires DATABASE_URL for automation_platform_test");
  }
  const url = new URL(value);
  const databaseName = url.pathname.replace(/^\//, "");
  if (databaseName !== "automation_platform_test") {
    throw new Error("Playwright refuses a database other than automation_platform_test");
  }
  if (!isLoopback(url.hostname)) {
    throw new Error("Playwright refuses a non-local test database");
  }
  return value;
}

function requiredIsolatedRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) {
    throw new Error("Playwright requires an isolated REDIS_URL");
  }
  const url = new URL(value);
  if (!isLoopback(url.hostname) || !url.port || url.port === "6379") {
    throw new Error("Playwright requires Redis on an isolated local port other than 6379");
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
