import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const api = required("STAGING_API_URL").replace(/\/$/, "");
const email = required("STAGING_SMOKE_EMAIL");
const password = required("STAGING_SMOKE_PASSWORD");

test("RC staging release journey", async ({ page, request }) => {
  const account = await apiLogin(request, email, password);
  await uiLogin(page, email, password);

  const workflowName = `RC staging ${Date.now()}`;
  await page.getByRole("link", { name: "Open workflows" }).click();
  await page.getByLabel("Name", { exact: true }).fill(workflowName);
  await page
    .getByLabel("Description", { exact: true })
    .fill("RC staging release rehearsal");
  await page.getByRole("button", { name: "Create workflow" }).click();
  const workflowLink = page.getByRole("link", { name: workflowName });
  if (!/\/workflows\/[0-9a-f-]+$/.test(page.url())) {
    await expect(workflowLink).toBeVisible();
    await page.goto((await workflowLink.getAttribute("href"))!);
  }
  const workflowId = page.url().match(/\/workflows\/([0-9a-f-]+)$/)?.[1];
  expect(workflowId).toBeTruthy();

  await page.getByRole("button", { name: "Form" }).click();
  await page.getByLabel("Step type to add").selectOption("transform");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Name", { exact: true }).last().fill("RC transform");
  await page.getByLabel("Key", { exact: true }).last().fill("rc_transform");
  await expect(page.getByText("Definition valid")).toBeVisible();
  await page.getByRole("button", { name: "Create version" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish version" }).click();
  await page
    .getByRole("dialog", { name: "Activate workflow version" })
    .getByRole("button", { name: "Activate version" })
    .click();
  await expect(page.getByText("Active version")).toBeVisible();

  const manual = await apiPost(
    request,
    account,
    `/workflows/${workflowId}/executions`,
    {
      input: { trigger: { source: "rc-staging-manual" } },
      idempotencyKey: `manual-${Date.now()}`,
      confirmRealEffects: true,
    },
  );
  const manualId = manual.execution.id as string;
  await expect
    .poll(() => executionStatus(request, account, manualId), {
      timeout: 45_000,
    })
    .toBe("COMPLETED");

  const trigger = await apiPost(
    request,
    account,
    `/workflows/${workflowId}/triggers`,
    {},
  );
  const webhookResponse = await request.post(
    `${api}/webhooks/${trigger.id}/${trigger.token}`,
    {
      data: { source: "rc-staging-webhook" },
      headers: { "idempotency-key": `webhook-${Date.now()}` },
    },
  );
  expect(webhookResponse.ok(), await webhookResponse.text()).toBeTruthy();
  const webhook = await webhookResponse.json();
  await expect
    .poll(() => executionStatus(request, account, webhook.executionId), {
      timeout: 45_000,
    })
    .toBe("COMPLETED");

  const approvalWorkflow = await createApprovalWorkflow(request, account);
  const approvalTrigger = await apiPost(
    request,
    account,
    `/workflows/${approvalWorkflow.id}/triggers`,
    {},
  );
  const approvalStart = await request.post(
    `${api}/webhooks/${approvalTrigger.id}/${approvalTrigger.token}`,
    {
      data: { source: "rc-staging-approval" },
      headers: { "idempotency-key": `approval-${Date.now()}` },
    },
  );
  expect(approvalStart.ok(), await approvalStart.text()).toBeTruthy();
  const approvalExecutionId = (await approvalStart.json())
    .executionId as string;
  let approvalId = "";
  await expect
    .poll(
      async () => {
        const approvals = await apiGet(
          request,
          account,
          "/approvals?status=PENDING",
        );
        approvalId =
          approvals.items.find(
            (item: { executionId: string }) =>
              item.executionId === approvalExecutionId,
          )?.id ?? "";
        return approvalId;
      },
      { timeout: 45_000 },
    )
    .toMatch(/[0-9a-f-]{10,}/);

  await page.goto(`/approvals/${approvalId}`);
  await expect(page.getByText("PENDING", { exact: true })).toBeVisible();
  await page
    .getByLabel("Optional comment")
    .fill("Approved by RC staging rehearsal");
  await page.getByRole("button", { name: "Approve" }).click();
  await page
    .getByRole("dialog", { name: "Approve request?" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect
    .poll(() => executionStatus(request, account, approvalExecutionId), {
      timeout: 45_000,
    })
    .toBe("COMPLETED");

  const replay = await apiPost(
    request,
    account,
    `/executions/${manualId}/replay`,
    {
      mode: "FULL_REPLAY",
      reason: "RC staging rehearsal",
    },
    { "idempotency-key": `replay-${Date.now()}` },
  );
  const replayId = replay.execution.id as string;
  expect(replayId).not.toBe(manualId);
  await expect
    .poll(() => executionStatus(request, account, replayId), {
      timeout: 45_000,
    })
    .toBe("COMPLETED");
  expect(await executionStatus(request, account, manualId)).toBe("COMPLETED");

  await page.goto(`/executions/${replayId}`);
  await expect(
    page.getByText("COMPLETED", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open safe step detail" }),
  ).toBeVisible();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantB = await register(
    request,
    `rc-tenant-b-${suffix}@example.invalid`,
    `RC-tenant-${suffix}-Password-1!`,
  );
  const crossTenant = await request.get(`${api}/workflows`, {
    headers: authHeaders(account.token, tenantB.organizationId),
  });
  expect([403, 404]).toContain(crossTenant.status());
});

async function uiLogin(
  page: Page,
  accountEmail: string,
  accountPassword: string,
) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(accountEmail);
  await page.getByLabel("Password").fill(accountPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
}

async function apiLogin(
  request: APIRequestContext,
  accountEmail: string,
  accountPassword: string,
): Promise<Account> {
  const response = await request.post(`${api}/auth/login`, {
    data: { email: accountEmail, password: accountPassword },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  return {
    token: body.accessToken,
    organizationId: body.defaultOrganizationId,
  };
}

async function register(
  request: APIRequestContext,
  accountEmail: string,
  accountPassword: string,
) {
  const response = await request.post(`${api}/auth/register`, {
    data: {
      email: accountEmail,
      password: accountPassword,
      name: "RC Tenant B",
      organizationName: `RC Tenant B ${Date.now()}`,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  return {
    token: body.accessToken as string,
    organizationId: body.defaultOrganizationId as string,
  };
}

async function apiPost(
  request: APIRequestContext,
  account: Account,
  path: string,
  data: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const response = await request.post(`${api}${path}`, {
    data,
    headers: {
      ...authHeaders(account.token, account.organizationId),
      ...extraHeaders,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function apiGet(
  request: APIRequestContext,
  account: Account,
  path: string,
) {
  const response = await request.get(`${api}${path}`, {
    headers: authHeaders(account.token, account.organizationId),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function executionStatus(
  request: APIRequestContext,
  account: Account,
  executionId: string,
) {
  const response = await request.get(`${api}/executions/${executionId}`, {
    headers: authHeaders(account.token, account.organizationId),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).status as string;
}

async function createApprovalWorkflow(
  request: APIRequestContext,
  account: Account,
) {
  const workflow = await apiPost(request, account, "/workflows", {
    name: `RC approval ${Date.now()}`,
  });
  const version = await apiPost(
    request,
    account,
    `/workflows/${workflow.id}/versions`,
    {
      workflowDefinitionSchemaVersion: 2,
      expressionMode: "strict",
      trigger: {
        key: "webhook",
        name: "Webhook",
        type: "webhook_trigger",
        config: {},
      },
      steps: [
        {
          key: "approval",
          name: "Approval",
          type: "approval",
          config: {
            title: "RC review",
            allowedRoles: ["owner"],
            assigneePolicy: "ANY_AUTHORIZED_USER",
          },
        },
        {
          key: "approved",
          name: "Approved",
          type: "transform",
          config: {
            mode: "OBJECT",
            fields: { result: "approved" },
            outputType: "OBJECT",
          },
        },
        {
          key: "rejected",
          name: "Rejected",
          type: "transform",
          config: {
            mode: "OBJECT",
            fields: { result: "rejected" },
            outputType: "OBJECT",
          },
        },
        {
          key: "expired",
          name: "Expired",
          type: "transform",
          config: {
            mode: "OBJECT",
            fields: { result: "expired" },
            outputType: "OBJECT",
          },
        },
      ],
      graph: {
        entryStepKey: "approval",
        edges: [
          { from: "approval", to: "approved", kind: "approval_approved" },
          { from: "approval", to: "rejected", kind: "approval_rejected" },
          { from: "approval", to: "expired", kind: "approval_expired" },
        ],
        terminalStepKeys: ["approved", "rejected", "expired"],
      },
    },
  );
  const activation = await request.patch(
    `${api}/workflows/${workflow.id}/versions/${version.id}/activate`,
    {
      headers: authHeaders(account.token, account.organizationId),
    },
  );
  expect(activation.ok(), await activation.text()).toBeTruthy();
  return workflow;
}

function authHeaders(token: string, organizationId: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-organization-id": organizationId,
  };
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type Account = { token: string; organizationId: string };
