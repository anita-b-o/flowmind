const api = required("STAGING_API_URL").replace(/\/$/, "");
const email = required("STAGING_SMOKE_EMAIL");
const password = required("STAGING_SMOKE_PASSWORD");

const authLimit = Number(process.env.AUTH_RATE_LIMIT_MAX_PER_ACCOUNT ?? 10);
const disposableEmail = `rc-rate-limit-${Date.now()}@example.invalid`;
let authLimited = false;
for (let attempt = 0; attempt < authLimit + 2; attempt += 1) {
  const response = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: disposableEmail, password: "invalid-password" })
  });
  if (response.status === 429) {
    authLimited = true;
    break;
  }
}
if (!authLimited) throw new Error("Auth rate limiting did not return 429");

const login = await jsonRequest("/auth/login", {
  method: "POST",
  body: { email, password }
});
const account = {
  token: login.accessToken,
  organizationId: login.defaultOrganizationId
};
const workflow = await jsonRequest("/workflows", {
  method: "POST",
  account,
  body: { name: `RC rate limit ${Date.now()}` }
});
const version = await jsonRequest(`/workflows/${workflow.id}/versions`, {
  method: "POST",
  account,
  body: {
    workflowDefinitionSchemaVersion: 2,
    expressionMode: "strict",
    trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
    steps: [{
      key: "done",
      name: "Done",
      type: "transform",
      config: { mode: "OBJECT", fields: { result: "ok" }, outputType: "OBJECT" }
    }],
    graph: { entryStepKey: "done", edges: [], terminalStepKeys: ["done"] }
  }
});
await jsonRequest(`/workflows/${workflow.id}/versions/${version.id}/activate`, {
  method: "PATCH",
  account
});
const trigger = await jsonRequest(`/workflows/${workflow.id}/triggers`, {
  method: "POST",
  account,
  body: {}
});

const webhookLimit = Number(process.env.WEBHOOK_BURST_LIMIT_MAX ?? 10);
const requests = Array.from({ length: webhookLimit + 2 }, (_, index) =>
  fetch(`${api}/webhooks/${trigger.id}/${trigger.token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `rc-rate-limit-${Date.now()}-${index}`
    },
    body: JSON.stringify({ source: "rc-rate-limit" })
  })
);
const responses = await Promise.all(requests);
if (!responses.some((response) => response.status === 429)) {
  throw new Error("Webhook burst limiting did not return 429");
}

console.log("FlowMind auth and webhook rate limiting: PASS");

async function jsonRequest(path, { method, account, body }) {
  const headers = { "content-type": "application/json" };
  if (account) {
    headers.authorization = `Bearer ${account.token}`;
    headers["x-organization-id"] = account.organizationId;
  }
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
