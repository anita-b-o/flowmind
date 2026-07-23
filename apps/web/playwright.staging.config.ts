import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.STAGING_WEB_URL;
if (!baseURL) {
  throw new Error("STAGING_WEB_URL is required");
}
if (!process.env.STAGING_API_URL) {
  throw new Error("STAGING_API_URL is required");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "staging-rehearsal.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [
    ["list"],
    ["json", { outputFile: "../../.artifacts/staging-playwright.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "staging-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
