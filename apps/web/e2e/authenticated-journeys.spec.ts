import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const api = "http://127.0.0.1:3001";
const prisma = new PrismaClient();

test.describe("authenticated RC1 journeys", () => {
  let account: Account;
  test.beforeEach(async ({ request }) => { account = await register(request); });

  test("A. Login navigates to the authenticated Dashboard", async ({ page }) => {
    await login(page, account);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
    await expect(page.getByText("Queue health")).toBeVisible();
  });

  test("B. creates, edits, versions, and publishes a workflow through the UI", async ({ page }) => {
    await login(page, account);
    await page.getByRole("link", { name: "Open workflows" }).click();
    const name = `Playwright flow ${Date.now()}`;
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description", { exact: true }).fill("RC1 authenticated journey");
    await page.getByRole("button", { name: "Create workflow" }).click();
    const created = page.getByRole("link", { name });
    await expect(created).toBeVisible();
    if (!/\/workflows\/[0-9a-f-]+$/.test(page.url())) await page.goto((await created.getAttribute("href"))!);
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name }).first()).toBeVisible();
    await page.getByRole("button", { name: "Form" }).click();
    await page.getByLabel("Step type to add").selectOption("transform");
    await page.getByRole("button", { name: "Add step" }).click();
    await page.getByLabel("Name", { exact: true }).last().fill("Published transform");
    await page.getByLabel("Key", { exact: true }).last().fill("published_transform");
    await expect(page.getByText("Definition valid")).toBeVisible();
    await page.getByRole("button", { name: "Create version" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Publish version" }).click();
    const activation = page.getByRole("dialog", { name: "Activate workflow version" });
    await activation.getByRole("button", { name: "Activate version" }).click();
    await expect(page.getByText("Active version")).toBeVisible();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  });

  test("C. webhook reaches the worker and completes, then appears in Run History", async ({ page, request }) => {
    const workflow = await createRunnable(request, account, "Webhook journey");
    const trigger = await apiPost(request, account, `/workflows/${workflow.id}/triggers`, {});
    const accepted = await (await request.post(`${api}/webhooks/${trigger.id}/${trigger.token}`, { data: { name: "Ada" }, headers: { "idempotency-key": `pw-${Date.now()}` } })).json();
    await expect.poll(() => executionStatus(request, account, accepted.executionId), { timeout: 20_000 }).toBe("COMPLETED");
    await login(page, account); await openRunHistory(page);
    await expect(page.getByRole("link", { name: new RegExp(accepted.executionId.slice(0, 8)) })).toBeVisible();
  });

  test("D. an authorized user approves in the UI and the same execution completes", async ({ page, request }) => {
    const workflow = await createApprovalWorkflow(request, account);
    const trigger = await apiPost(request, account, `/workflows/${workflow.id}/triggers`, {});
    const startedResponse = await request.post(`${api}/webhooks/${trigger.id}/${trigger.token}`, { data: { approval: true }, headers: { "idempotency-key": `approval-${Date.now()}` } });
    expect(startedResponse.ok(), await startedResponse.text()).toBeTruthy();
    const started = await startedResponse.json();
    const executionId = started.executionId ?? started.execution?.id ?? started.id;
    expect(executionId).toBeTruthy();
    await expect.poll(() => executionStatus(request, account, executionId), { timeout: 20_000 }).toMatch(/RETRYING|QUEUED/);
    let approval: { id: string; executionId: string } | undefined;
    await expect.poll(async () => {
      const approvals = await apiGet(request, account, "/approvals?status=PENDING");
      approval = approvals.items.find((item: { executionId: string }) => item.executionId === executionId);
      return approval?.id ?? "";
    }, { timeout: 20_000 }).toMatch(/[0-9a-f-]{10,}/);
    await login(page, account);
    await page.goto(`/approvals/${approval!.id}`);
    await expect(page.getByText("PENDING", { exact: true })).toBeVisible();
    await page.getByLabel("Optional comment").fill("Approved by RC1 browser journey");
    await page.getByRole("button", { name: "Approve" }).click();
    const confirmation = page.getByRole("dialog", { name: "Approve request?" });
    const confirm = confirmation.getByRole("button", { name: "Approve" });
    await confirm.click();
    await expect(confirmation).toBeHidden();
    await expect.poll(() => executionStatus(request, account, executionId), { timeout: 20_000 }).toBe("COMPLETED");
    await page.goto(`/executions/${executionId}`);
    await expect(page.getByText(executionId, { exact: true })).toBeVisible();
    await expect(page.getByText("COMPLETED", { exact: true }).first()).toBeVisible();
    expect(await prisma.internalRecord.count({ where: { executionId, collection: "approval_approved" } })).toBe(1);
  });

  test("E. retries a failed execution from the UI into a distinct completed execution", async ({ page, request }) => {
    const source = await createReplayFixture(request, account);
    await login(page, account);
    await page.goto(`/executions/${source.id}`);
    await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Replay execution" }).click();
    const dialog = page.getByRole("dialog", { name: "Replay execution" });
    await dialog.getByLabel("Mode").selectOption("RETRY_FROM_FAILURE");
    await expect(dialog.getByText(/Starting at.*c/)).toBeVisible();
    const createReplay = dialog.getByRole("button", { name: "Create replay" });
    await expect(createReplay).toBeEnabled();
    await createReplay.click();
    await expect(page).toHaveURL(/\/executions\/[0-9a-f-]+$/);
    await expect.poll(async () => {
      const detail = await apiGet(request, account, `/executions/${source.id}`);
      return detail.replayExecutions?.[0]?.id ?? "";
    }, { timeout: 20_000 }).toMatch(/[0-9a-f-]{10,}/);
    const recoveryId = (await apiGet(request, account, `/executions/${source.id}`)).replayExecutions[0].id;
    await page.goto(`/executions/${recoveryId}`);
    expect(recoveryId).not.toBe(source.id);
    await expect.poll(() => executionStatus(request, account, recoveryId), { timeout: 20_000 }).toBe("COMPLETED");
    await page.reload();
    await expect(page.getByText(`Replayed from:`)).toBeVisible();
    await expect(page.getByText("RETRY_FROM_FAILURE", { exact: false })).toBeVisible();
    expect(await executionStatus(request, account, source.id)).toBe("FAILED");
    expect(await prisma.internalRecord.count({ where: { executionId: source.id, collection: "replay_effects" } })).toBe(1);
  });

  test("F. Run History renders a safe timeline and step detail", async ({ page, request }) => {
    const workflow = await createRunnable(request, account, "History journey");
    const execution = await apiPost(request, account, `/workflows/${workflow.id}/executions`, { input: { trigger: { canary: "safe" } }, idempotencyKey: `history-${Date.now()}`, confirmRealEffects: true });
    const executionId = execution.execution.id;
    await expect.poll(() => executionStatus(request, account, executionId), { timeout: 20_000 }).toBe("COMPLETED");
    await login(page, account); await openRunHistory(page); await page.getByRole("link", { name: new RegExp(executionId.slice(0, 8)) }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    const stepLink = page.getByRole("link", { name: "Open safe step detail" }); await expect(stepLink).toBeVisible(); await stepLink.click();
    await expect(page.getByRole("heading", { name: /Step/ })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("password");
  });
});

async function register(request: APIRequestContext) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const account = { email: `pw-${suffix}@example.com`, password: "Playwright-password-1!" };
  const response = await request.post(`${api}/auth/register`, { data: { ...account, name: "RC1 Operator", organizationName: `RC1 ${suffix}` } });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return { ...account, token: body.accessToken, organizationId: body.defaultOrganizationId };
}

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

async function openRunHistory(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.locator('a[href="/executions"]').first().click();
  await expect(page).toHaveURL(/\/executions$/);
}

type Account = { email: string; password: string; token: string; organizationId: string };
const headers = (account: Account) => ({ authorization: `Bearer ${account.token}`, "x-organization-id": account.organizationId });
async function apiPost(request: APIRequestContext, account: Account, path: string, data: unknown) { const response = await request.post(`${api}${path}`, { data, headers: headers(account) }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); }
async function apiGet(request: APIRequestContext, account: Account, path: string) { const response = await request.get(`${api}${path}`, { headers: headers(account) }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); }
async function executionStatus(request: APIRequestContext, account: Account, id: string) { const response = await request.get(`${api}/executions/${id}`, { headers: headers(account) }); if (response.status() === 404) return "MISSING"; expect(response.ok(), await response.text()).toBeTruthy(); return (await response.json()).status as string; }
async function createRunnable(request: APIRequestContext, account: Account, name: string) {
  const workflow = await apiPost(request, account, "/workflows", { name });
  const version = await apiPost(request, account, `/workflows/${workflow.id}/versions`, {
    workflowDefinitionSchemaVersion: 2,
    trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
    graph: { entryStepKey: "save", edges: [], terminalStepKeys: ["save"] },
    steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "playwright", data: { ok: true } } }]
  });
  const activated = await request.patch(`${api}/workflows/${workflow.id}/versions/${version.id}/activate`, { headers: headers(account) }); expect(activated.ok(), await activated.text()).toBeTruthy();
  return workflow;
}

async function createApprovalWorkflow(request: APIRequestContext, account: Account) {
  const workflow = await apiPost(request, account, "/workflows", { name: `Approval journey ${Date.now()}` });
  const version = await apiPost(request, account, `/workflows/${workflow.id}/versions`, {
    workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
    steps: [
      { key: "approval", name: "Approval", type: "approval", config: { title: "Review request", description: "Safe description", allowedRoles: ["owner"], assigneePolicy: "ANY_AUTHORIZED_USER" } },
      { key: "approved", name: "Approved", type: "database_record", config: { collection: "approval_approved", data: { result: "approved" } } },
      { key: "rejected", name: "Rejected", type: "database_record", config: { collection: "approval_rejected", data: {} } },
      { key: "expired", name: "Expired", type: "database_record", config: { collection: "approval_expired", data: {} } }
    ],
    graph: { entryStepKey: "approval", edges: [{ from: "approval", to: "approved", kind: "approval_approved" }, { from: "approval", to: "rejected", kind: "approval_rejected" }, { from: "approval", to: "expired", kind: "approval_expired" }], terminalStepKeys: ["approved", "rejected", "expired"] }
  });
  const activated = await request.patch(`${api}/workflows/${workflow.id}/versions/${version.id}/activate`, { headers: headers(account) }); expect(activated.ok(), await activated.text()).toBeTruthy();
  return workflow;
}

async function createReplayFixture(request: APIRequestContext, account: Account) {
  const workflow = await apiPost(request, account, "/workflows", { name: `Replay journey ${Date.now()}` });
  const version = await apiPost(request, account, `/workflows/${workflow.id}/versions`, {
    workflowDefinitionSchemaVersion: 2, trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
    graph: { entryStepKey: "a", edges: [{ from: "a", to: "b", kind: "next" }, { from: "b", to: "c", kind: "next" }, { from: "c", to: "d", kind: "next" }], terminalStepKeys: ["d"] },
    steps: [
      { key: "a", name: "A", type: "transform", config: { mode: "OBJECT", fields: { value: "a" }, outputType: "OBJECT" } },
      { key: "b", name: "B", type: "database_record", config: { collection: "replay_effects", data: { once: true } } },
      { key: "c", name: "C", type: "transform", config: { mode: "OBJECT", fields: { value: "c" }, outputType: "OBJECT" } },
      { key: "d", name: "D", type: "transform", config: { mode: "OBJECT", fields: { value: "d" }, outputType: "OBJECT" } }
    ]
  });
  const activated = await request.patch(`${api}/workflows/${workflow.id}/versions/${version.id}/activate`, { headers: headers(account) }); expect(activated.ok(), await activated.text()).toBeTruthy();
  const source = await prisma.execution.create({ data: { organizationId: account.organizationId, workflowId: workflow.id, workflowVersionId: version.id, status: "FAILED", executionMode: "REAL", inputJson: { trigger: {} }, contextJson: checkpoint(), completedAt: new Date() } });
  const steps = await prisma.workflowStep.findMany({ where: { workflowVersionId: version.id } });
  for (const key of ["a", "b"] as const) { const definition = steps.find((item) => item.key === key)!; const row = await prisma.stepExecution.create({ data: { organizationId: account.organizationId, executionId: source.id, workflowStepId: definition.id, stepKey: key, stepType: definition.type, status: "COMPLETED", inputJson: {}, outputJson: { value: key }, attemptCount: 1, maxAttempts: 1, startedAt: new Date(), completedAt: new Date(), effectStatus: "succeeded" } }); if (key === "b") await prisma.internalRecord.create({ data: { organizationId: account.organizationId, workflowId: workflow.id, workflowVersionId: version.id, executionId: source.id, stepExecutionId: row.id, collection: "replay_effects", dedupeKey: `flowmind:${source.id}:root:b`, dataJson: { once: true } } }); }
  const failed = steps.find((item) => item.key === "c")!;
  await prisma.stepExecution.create({ data: { organizationId: account.organizationId, executionId: source.id, workflowStepId: failed.id, stepKey: "c", stepType: failed.type, status: "FAILED", inputJson: {}, errorJson: { message: "Fixture failure", classification: "non_retryable" }, attemptCount: 1, maxAttempts: 1, startedAt: new Date(), completedAt: new Date(), effectStatus: "failed" } });
  return source;
}

function checkpoint() { return { trigger: {}, steps: {}, metadata: {}, __runtime: { variables: {}, workflowVariables: {}, initialExecutionVariables: {}, initialWorkflowVariables: {} }, recoveryCheckpoint: { schemaVersion: 1, complete: true, initialExecutionVariables: {}, initialWorkflowVariables: {}, executionVariables: {}, workflowVariables: {} } }; }
