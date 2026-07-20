import { expect, test } from "@playwright/test";

test("login and registration remain usable across viewports", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to FlowMind" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");

  await page.getByRole("link", { name: /create/i }).click();
  if (!/\/register$/.test(page.url())) await page.goto("/register");
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
});

test("unknown routes render a safe 404", async ({ page }) => {
  const response = await page.goto("/not-a-flowmind-route");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found|could not be found/i)).toBeVisible();
});
