import { writeFileSync } from "node:fs";

const api = required("STAGING_API_URL").replace(/\/$/, "");
const email = required("STAGING_SMOKE_EMAIL");
const password = required("STAGING_SMOKE_PASSWORD");
const output = process.argv[2];
if (!output) throw new Error("Usage: capture-staging-state.mjs <output.json>");

const loginResponse = await fetch(`${api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password })
});
if (!loginResponse.ok) throw new Error(`Login failed: ${loginResponse.status}`);
const login = await loginResponse.json();
const headers = {
  authorization: `Bearer ${login.accessToken}`,
  "x-organization-id": login.defaultOrganizationId
};

async function get(path) {
  const response = await fetch(`${api}${path}`, { headers });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

const workflowsResponse = await get("/workflows");
const workflows = arrayFrom(workflowsResponse);
const executions = arrayFrom(await get("/executions?limit=100"));
const approvals = arrayFrom(await get("/approvals?pageSize=100"));
const templates = arrayFrom(await get("/workflow-templates?pageSize=100"));
const notifications = arrayFrom(await get("/notifications?pageSize=100"));
const triggers = [];
for (const workflow of workflows) {
  const response = await get(`/workflows/${workflow.id}/triggers`);
  for (const trigger of arrayFrom(response)) triggers.push({ id: trigger.id, workflowId: workflow.id, type: trigger.type, enabled: trigger.enabled });
}

const state = {
  capturedAt: new Date().toISOString(),
  organizationId: login.defaultOrganizationId,
  workflows: project(workflows, ["id", "status", "activeVersionId"]),
  executions: project(executions, ["id", "status", "workflowId", "workflowVersionId"]),
  approvals: project(approvals, ["id", "status", "executionId"]),
  templates: project(templates, ["id", "status"]),
  notifications: project(notifications, ["id", "status"]),
  triggers: triggers.sort(byId)
};
writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function project(values, keys) {
  return values.map((value) => Object.fromEntries(keys.map((key) => [key, value[key] ?? null]))).sort(byId);
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
