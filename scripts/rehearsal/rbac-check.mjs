const api = required("STAGING_API_URL").replace(/\/$/, "");
const organizationId = required("RBAC_ORGANIZATION_ID");

const owner = await login(required("STAGING_SMOKE_EMAIL"), required("STAGING_SMOKE_PASSWORD"));
const admin = await login(required("RBAC_ADMIN_EMAIL"), required("RBAC_ADMIN_PASSWORD"));
const editor = await login(required("RBAC_EDITOR_EMAIL"), required("RBAC_EDITOR_PASSWORD"));
const viewer = await login(required("RBAC_VIEWER_EMAIL"), required("RBAC_VIEWER_PASSWORD"));

await expectStatus(viewer, "GET", "/workflows", undefined, 200);
await expectStatus(viewer, "POST", "/workflows", { name: "viewer must not create" }, 403);
await expectStatus(viewer, "GET", "/connections", undefined, 403);

await expectStatus(editor, "GET", "/connections", undefined, 200);
await expectStatus(editor, "POST", "/workflows", { name: `RC editor ${Date.now()}` }, 201);
await expectStatus(editor, "POST", "/connections", connectionBody("editor"), 403);
await expectStatus(editor, "GET", "/audit-logs", undefined, 403);

await expectStatus(admin, "GET", "/audit-logs", undefined, 200);
const created = await expectStatus(admin, "POST", "/connections", connectionBody("admin"), 201);
await expectStatus(admin, "DELETE", `/connections/${created.id}`, undefined, 403);
await expectStatus(owner, "DELETE", `/connections/${created.id}`, undefined, 200);

process.stdout.write("Staging RBAC validation: PASS\n");

async function login(email, password) {
  const response = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(`Login failed for ${email}: ${response.status}`);
  const body = await response.json();
  return body.accessToken;
}

async function expectStatus(token, method, path, body, expected) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-organization-id": organizationId,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status !== expected) {
    throw new Error(`${method} ${path}: expected ${expected}, received ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function connectionBody(actor) {
  return {
    type: "HTTP_API_KEY",
    name: `RC ${actor} ${Date.now()}`,
    baseUrl: "https://example.invalid",
    authScheme: "API_KEY",
    authLocation: "HEADER",
    authName: "x-api-key",
    secretValue: `rc-${actor}-secret-value`
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
