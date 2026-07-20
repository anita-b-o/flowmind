import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: [
    {
      command: "env NODE_ENV=test DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/automation_platform REDIS_URL=redis://127.0.0.1:6379 JWT_ACCESS_SECRET=playwright-access-secret JWT_REFRESH_SECRET=playwright-refresh-secret SESSION_IP_HASH_PEPPER=playwright-session-pepper SECRET_ENCRYPTION_KEY=playwright-secret-key CONNECTION_ENCRYPTION_KEY=base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE= AI_SERVICE_URL=http://127.0.0.1:8000 AI_SERVICE_API_KEY=playwright-ai-key CORS_ORIGIN=http://127.0.0.1:3100 PUBLIC_APP_URL=http://127.0.0.1:3100 PUBLIC_API_URL=http://127.0.0.1:3001 WEBHOOK_TOKEN_PEPPER=playwright-webhook-pepper corepack pnpm --filter @automation/api dev",
      url: "http://127.0.0.1:3001/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      command: "env NODE_ENV=test DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/automation_platform REDIS_URL=redis://127.0.0.1:6379 JWT_ACCESS_SECRET=playwright-access-secret JWT_REFRESH_SECRET=playwright-refresh-secret SESSION_IP_HASH_PEPPER=playwright-session-pepper SECRET_ENCRYPTION_KEY=playwright-secret-key CONNECTION_ENCRYPTION_KEY=base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE= AI_SERVICE_URL=http://127.0.0.1:8000 AI_SERVICE_API_KEY=playwright-ai-key PUBLIC_API_URL=http://127.0.0.1:3001 WEBHOOK_TOKEN_PEPPER=playwright-webhook-pepper WORKER_HEALTH_PORT=3002 corepack pnpm --filter @automation/worker dev",
      url: "http://127.0.0.1:3002/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      command: "env NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 corepack pnpm dev --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/login",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ],
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ]
});
