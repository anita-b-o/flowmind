import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { OrganizationRole } from "@automation/shared-types";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();
let httpApp: INestApplication;
type Actor = { token: string; organizationId: string; userId: string; email: string };
type Method = "get" | "post" | "patch" | "put" | "delete";
type Ids = Record<"workflowId" | "versionId" | "otherVersionId" | "executionId" | "approvalId" | "dataStoreId" | "triggerId" | "notificationRuleId" | "templateId" | "templateVersionId" | "connectionId" | "testRunId", string>;
type MatrixCase = {
  name: string;
  resource: string;
  method: Method;
  path: (ids: Ids) => string;
  minimum: OrganizationRole;
  body?: unknown;
  tenant?: "list" | "resource";
};

const roles = [OrganizationRole.Viewer, OrganizationRole.Editor, OrganizationRole.Admin, OrganizationRole.Owner];
const missing = "00000000-0000-4000-8000-000000000099";
const definition = { workflowDefinitionSchemaVersion: 2, graph: { entryStepKey: "done", edges: [], terminalStepKeys: ["done"] } };
const cases: MatrixCase[] = [
  { name: "workflow list", resource: "Workflows", method: "get", path: () => "/workflows", minimum: OrganizationRole.Viewer, tenant: "list" },
  { name: "workflow detail", resource: "Workflows", method: "get", path: i => `/workflows/${i.workflowId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "workflow create", resource: "Workflows", method: "post", path: () => "/workflows", minimum: OrganizationRole.Editor, body: { name: "matrix workflow create" } },
  { name: "workflow version list", resource: "Versions", method: "get", path: i => `/workflows/${i.workflowId}/versions`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "workflow version detail", resource: "Versions", method: "get", path: i => `/workflows/${i.workflowId}/versions/${i.versionId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "version diff", resource: "Versions", method: "get", path: i => `/workflows/${i.workflowId}/versions/${i.versionId}/diff/${i.otherVersionId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "workflow create version", resource: "Versions", method: "post", path: i => `/workflows/${i.workflowId}/versions`, minimum: OrganizationRole.Editor, body: { trigger: { key: "trigger", name: "Manual", type: "manual_trigger", config: {} }, steps: [{ key: "done", name: "Done", type: "transform", config: {} }], workflowDefinitionSchemaVersion: 2, graph: definition.graph }, tenant: "resource" },
  { name: "execution list", resource: "Executions", method: "get", path: () => "/executions", minimum: OrganizationRole.Viewer, tenant: "list" },
  { name: "execution detail", resource: "Executions", method: "get", path: i => `/executions/${i.executionId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "execution retry", resource: "Executions", method: "post", path: i => `/executions/${i.executionId}/retry`, minimum: OrganizationRole.Editor, body: { reason: "matrix" }, tenant: "resource" },
  { name: "execution replay preview", resource: "Executions", method: "get", path: i => `/executions/${i.executionId}/replay-preview?mode=FULL_REPLAY`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "execution replay", resource: "Executions", method: "post", path: i => `/executions/${i.executionId}/replay`, minimum: OrganizationRole.Editor, body: { mode: "FULL_REPLAY", reason: "matrix" }, tenant: "resource" },
  { name: "execution cancel", resource: "Executions", method: "post", path: i => `/executions/${i.executionId}/cancel`, minimum: OrganizationRole.Editor, body: { reason: "matrix" }, tenant: "resource" },
  { name: "approval list", resource: "Approvals", method: "get", path: () => "/approvals", minimum: OrganizationRole.Viewer, tenant: "list" },
  { name: "approval detail", resource: "Approvals", method: "get", path: i => `/approvals/${i.approvalId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "approval approve", resource: "Approvals", method: "post", path: i => `/approvals/${i.approvalId}/approve`, minimum: OrganizationRole.Viewer, body: { comment: "matrix" }, tenant: "resource" },
  { name: "approval reject", resource: "Approvals", method: "post", path: i => `/approvals/${i.approvalId}/reject`, minimum: OrganizationRole.Viewer, body: { comment: "matrix" }, tenant: "resource" },
  { name: "data store list", resource: "Data Stores", method: "get", path: () => "/data-stores", minimum: OrganizationRole.Editor, tenant: "list" },
  { name: "data store detail", resource: "Data Stores", method: "get", path: i => `/data-stores/${i.dataStoreId}`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "data store create", resource: "Data Stores", method: "post", path: () => "/data-stores", minimum: OrganizationRole.Editor, body: { name: "matrix store" } },
  { name: "data store update", resource: "Data Stores", method: "patch", path: i => `/data-stores/${i.dataStoreId}`, minimum: OrganizationRole.Editor, body: { description: "matrix" }, tenant: "resource" },
  { name: "data store delete", resource: "Data Stores", method: "delete", path: i => `/data-stores/${i.dataStoreId}`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "data store records list", resource: "Data Store Records", method: "get", path: i => `/data-stores/${i.dataStoreId}/records`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "data store record detail", resource: "Data Store Records", method: "get", path: i => `/data-stores/${i.dataStoreId}/records/matrix-key`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "data store record delete", resource: "Data Store Records", method: "delete", path: i => `/data-stores/${i.dataStoreId}/records/matrix-key`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "event trigger list", resource: "Event Triggers", method: "get", path: i => `/workflows/${i.workflowId}/triggers/event`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "event trigger detail", resource: "Event Triggers", method: "get", path: i => `/workflows/${i.workflowId}/triggers/${i.triggerId}/event`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "event trigger create", resource: "Event Triggers", method: "post", path: i => `/workflows/${i.workflowId}/triggers/event`, minimum: OrganizationRole.Editor, body: { name: "matrix event", eventType: "EXECUTION_COMPLETED" }, tenant: "resource" },
  { name: "event trigger update", resource: "Event Triggers", method: "patch", path: i => `/workflows/${i.workflowId}/triggers/${i.triggerId}/event`, minimum: OrganizationRole.Editor, body: { name: "matrix event updated" }, tenant: "resource" },
  { name: "event trigger enable", resource: "Event Triggers", method: "patch", path: i => `/workflows/${i.workflowId}/triggers/${i.triggerId}/enable`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "event trigger disable", resource: "Event Triggers", method: "patch", path: i => `/workflows/${i.workflowId}/triggers/${i.triggerId}/disable`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "event trigger delete", resource: "Event Triggers", method: "delete", path: i => `/workflows/${i.workflowId}/triggers/${i.triggerId}`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "notification rule list", resource: "Notification Rules", method: "get", path: () => "/notification-rules", minimum: OrganizationRole.Viewer, tenant: "list" },
  { name: "notification rule create", resource: "Notification Rules", method: "post", path: () => "/notification-rules", minimum: OrganizationRole.Editor, body: { eventType: "EXECUTION_COMPLETED", channel: "EMAIL", connectionId: missing, recipientConfig: { to: ["matrix@example.com"] }, templateKey: "matrix" } },
  { name: "notification rule update", resource: "Notification Rules", method: "patch", path: i => `/notification-rules/${i.notificationRuleId}`, minimum: OrganizationRole.Editor, body: { templateKey: "matrix-updated" }, tenant: "resource" },
  { name: "notification rule enable", resource: "Notification Rules", method: "patch", path: i => `/notification-rules/${i.notificationRuleId}`, minimum: OrganizationRole.Editor, body: { enabled: true }, tenant: "resource" },
  { name: "notification rule disable", resource: "Notification Rules", method: "patch", path: i => `/notification-rules/${i.notificationRuleId}`, minimum: OrganizationRole.Editor, body: { enabled: false }, tenant: "resource" },
  { name: "notification rule delete", resource: "Notification Rules", method: "delete", path: i => `/notification-rules/${i.notificationRuleId}`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "template list", resource: "Templates", method: "get", path: () => "/workflow-templates", minimum: OrganizationRole.Viewer, tenant: "list" },
  { name: "template detail", resource: "Templates", method: "get", path: i => `/workflow-templates/${i.templateId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "template create", resource: "Templates", method: "post", path: () => "/workflow-templates/from-workflow-version", minimum: OrganizationRole.Editor, body: { name: "matrix template", workflowId: missing, workflowVersionId: missing } },
  { name: "template publish", resource: "Templates", method: "patch", path: i => `/workflow-templates/${i.templateId}/versions/${i.templateVersionId}/publish`, minimum: OrganizationRole.Admin, tenant: "resource" },
  { name: "template archive", resource: "Templates", method: "patch", path: i => `/workflow-templates/${i.templateId}/archive`, minimum: OrganizationRole.Admin, tenant: "resource" },
  { name: "template instantiate preview", resource: "Templates", method: "post", path: i => `/workflow-templates/${i.templateId}/versions/${i.templateVersionId}/preview`, minimum: OrganizationRole.Viewer, body: {}, tenant: "resource" },
  { name: "template instantiate", resource: "Templates", method: "post", path: i => `/workflow-templates/${i.templateId}/versions/${i.templateVersionId}/instantiate`, minimum: OrganizationRole.Editor, body: { name: "matrix instantiated" }, tenant: "resource" },
  { name: "clone preview", resource: "Clone", method: "post", path: i => `/workflows/${i.workflowId}/clone-preview`, minimum: OrganizationRole.Viewer, body: { name: "matrix clone", sourceWorkflowVersionId: missing }, tenant: "resource" },
  { name: "clone", resource: "Clone", method: "post", path: i => `/workflows/${i.workflowId}/clone`, minimum: OrganizationRole.Editor, body: { name: "matrix clone", sourceWorkflowVersionId: missing }, tenant: "resource" },
  { name: "restore preview", resource: "Version Restore", method: "get", path: i => `/workflows/${i.workflowId}/versions/${i.versionId}/restore-preview`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "restore", resource: "Version Restore", method: "post", path: i => `/workflows/${i.workflowId}/versions/${i.versionId}/restore`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "connection list", resource: "Connections", method: "get", path: () => "/connections", minimum: OrganizationRole.Editor, tenant: "list" },
  { name: "connection detail", resource: "Connections", method: "get", path: i => `/connections/${i.connectionId}`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "connection create", resource: "Connections", method: "post", path: () => "/connections", minimum: OrganizationRole.Admin, body: { type: "HTTP_API_KEY", name: "matrix connection", baseUrl: "https://example.invalid", authScheme: "API_KEY", authLocation: "HEADER", authName: "x-api-key", secretValue: "matrix-secret" } },
  { name: "connection update", resource: "Connections", method: "patch", path: i => `/connections/${i.connectionId}`, minimum: OrganizationRole.Admin, body: { description: "matrix" }, tenant: "resource" },
  { name: "connection delete", resource: "Connections", method: "delete", path: i => `/connections/${i.connectionId}`, minimum: OrganizationRole.Owner, tenant: "resource" },
  { name: "test run create", resource: "Test Runs", method: "post", path: i => `/workflows/${i.workflowId}/test-runs`, minimum: OrganizationRole.Editor, body: { workflowVersionId: missing, payload: { trigger: {} }, externalMode: "mock" }, tenant: "resource" },
  { name: "test run list", resource: "Test Runs", method: "get", path: i => `/workflows/${i.workflowId}/test-runs`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "test run detail", resource: "Test Runs", method: "get", path: i => `/workflows/${i.workflowId}/test-runs/${i.testRunId}`, minimum: OrganizationRole.Viewer, tenant: "resource" },
  { name: "test run cancel", resource: "Test Runs", method: "post", path: i => `/workflows/${i.workflowId}/test-runs/${i.testRunId}/cancel`, minimum: OrganizationRole.Editor, tenant: "resource" },
  { name: "test run rerun", resource: "Test Runs", method: "post", path: i => `/workflows/${i.workflowId}/test-runs/${i.testRunId}/rerun`, minimum: OrganizationRole.Editor, tenant: "resource" },
];

const tenantCases = cases.filter(testCase => testCase.tenant);

describe("RC1 centralized HTTP RBAC and tenant matrix", () => {
  let app: INestApplication;
  let owner: Actor;
  let foreign: Actor;
  let actors: Record<OrganizationRole, Actor>;
  let ids: Ids;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "matrix-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET ??= "matrix-refresh-secret-min-16";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    httpApp = app;
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = await register("matrix-owner", "Matrix A");
    foreign = await register("matrix-foreign", "Matrix B");
    for (const role of roles.slice(0, 3)) await addRole(owner.organizationId, role, `matrix-${role}`);
    actors = await roleActors(owner.organizationId);
    ids = await createFixtures(owner);
    console.info(`HTTP_MATRIX_SUMMARY total=${cases.length * roles.length + tenantCases.length} rbac=${cases.length * roles.length} crossTenant=${tenantCases.length} resources=${[...new Set(cases.map(c => c.resource))].length}`);
  }, 30_000);

  afterAll(async () => {
    if (owner && foreign) {
      const organizationIds = [owner.organizationId, foreign.organizationId];
      const templates = await prisma.workflowTemplate.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true } });
      await prisma.workflowTemplateVersion.deleteMany({ where: { templateId: { in: templates.map(template => template.id) } } });
      await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    }
    await app?.close();
    await prisma.$disconnect();
  }, 30_000);

  it.each(cases)("RBAC $resource / $name", async testCase => {
    for (const role of roles) {
      const response = await send(testCase, actors[role], rbacIds(ids));
      const allowed = roles.indexOf(role) >= roles.indexOf(testCase.minimum);
      expect(response.status).toBe(allowed ? expectedAuthorizedStatus(testCase, response.status) : 403);
    }
  }, 30_000);

  it.each(tenantCases)("cross-tenant $resource / $name", async testCase => {
    const response = await send(testCase, foreign, ids);
    if (testCase.tenant === "list") {
      expect(response.status).toBe(200);
      for (const id of Object.values(ids)) expect(JSON.stringify(response.body)).not.toContain(id);
    } else {
      expect(response.status).toBe(404);
    }
  }, 30_000);
});

function expectedAuthorizedStatus(testCase: MatrixCase, actual: number) {
  if (testCase.method === "get" && testCase.tenant === "list") return 200;
  if (testCase.name.endsWith("create") || testCase.name === "workflow create") return [201, 400, 404, 409].includes(actual) ? actual : 201;
  return 404;
}

function rbacIds(ids: Ids): Ids { return Object.fromEntries(Object.keys(ids).map(key => [key, missing])) as Ids; }
async function send(testCase: MatrixCase, actor: Actor, ids: Ids) { const req = request(httpApp.getHttpServer())[testCase.method](testCase.path(ids)).set("authorization", `Bearer ${actor.token}`).set("x-organization-id", actor.organizationId); return testCase.body === undefined ? req : req.send(testCase.body as object); }
async function register(prefix: string, organizationName: string): Promise<Actor> { const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`; const response = await request(httpApp.getHttpServer()).post("/auth/register").send({ email, name: prefix, password: "matrix-password-1!", organizationName }).expect(201); const user = await prisma.user.findUniqueOrThrow({ where: { email } }); return { token: response.body.accessToken, organizationId: response.body.defaultOrganizationId, userId: user.id, email }; }
async function addRole(organizationId: string, role: OrganizationRole, prefix: string) { const actor = await register(prefix, `Matrix ${prefix}`); await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId } }, data: { organizationId, role } }); }
async function roleActors(organizationId: string) { const rows = await prisma.organizationMember.findMany({ where: { organizationId }, include: { user: true } }); const result: Partial<Record<OrganizationRole, Actor>> = {}; for (const row of rows) { const login = await request(httpApp.getHttpServer()).post("/auth/login").send({ email: row.user.email, password: "matrix-password-1!" }).expect(201); result[row.role] = { token: login.body.accessToken, organizationId, userId: row.userId, email: row.user.email }; } return result as Record<OrganizationRole, Actor>; }

async function createFixtures(actor: Actor): Promise<Ids> {
  const workflow = await prisma.workflow.create({ data: { organizationId: actor.organizationId, name: "Matrix workflow", createdByUserId: actor.userId } });
  const version = await prisma.workflowVersion.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, versionNumber: 1, status: "DRAFT", createdByUserId: actor.userId, definitionJson: definition } });
  const otherVersion = await prisma.workflowVersion.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, versionNumber: 2, status: "DRAFT", createdByUserId: actor.userId, definitionJson: definition } });
  const execution = await prisma.execution.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, workflowVersionId: version.id, startedByUserId: actor.userId, status: "RUNNING", inputJson: {}, contextJson: {} } });
  const step = await prisma.stepExecution.create({ data: { organizationId: actor.organizationId, executionId: execution.id, stepKey: "approve", stepType: "Approval", status: "RUNNING", inputJson: {} } });
  const approval = await prisma.approvalRequest.create({ data: { organizationId: actor.organizationId, executionId: execution.id, stepExecutionId: step.id, workflowId: workflow.id, workflowVersionId: version.id, stepKey: "approve", title: "Matrix approval", allowedRoles: roles } });
  const dataStore = await prisma.dataStore.create({ data: { organizationId: actor.organizationId, name: "Matrix store" } });
  await prisma.dataStoreRecord.create({ data: { organizationId: actor.organizationId, dataStoreId: dataStore.id, key: "matrix-key", valueJson: { ok: true } } });
  const trigger = await prisma.trigger.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, type: "event", eventType: "EXECUTION_COMPLETED", configJson: { name: "Matrix event", filters: {} } } });
  const connection = await prisma.connection.create({ data: { organizationId: actor.organizationId, createdByUserId: actor.userId, name: "Matrix connection", type: "http_api_key", configJson: { baseUrl: "https://example.invalid" } } });
  const notificationRule = await prisma.notificationRule.create({ data: { organizationId: actor.organizationId, eventType: "EXECUTION_COMPLETED", connectionId: connection.id, recipientConfigJson: { to: ["matrix@example.com"] }, templateKey: "matrix" } });
  const template = await prisma.workflowTemplate.create({ data: { organizationId: actor.organizationId, createdByUserId: actor.userId, name: "Matrix template" } });
  const templateVersion = await prisma.workflowTemplateVersion.create({ data: { templateId: template.id, versionNumber: 1, definitionJson: definition, dependencyManifestJson: [], sourceWorkflowId: workflow.id, sourceWorkflowVersionId: version.id } });
  const testExecution = await prisma.execution.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, workflowVersionId: version.id, startedByUserId: actor.userId, status: "PENDING", executionMode: "TEST", inputJson: {}, contextJson: {} } });
  const testRun = await prisma.workflowTestRun.create({ data: { organizationId: actor.organizationId, workflowId: workflow.id, workflowVersionId: version.id, executionId: testExecution.id, createdByUserId: actor.userId, payloadJson: { trigger: {} }, stepMocksJson: {}, snapshotDefinitionJson: definition } });
  return { workflowId: workflow.id, versionId: version.id, otherVersionId: otherVersion.id, executionId: execution.id, approvalId: approval.id, dataStoreId: dataStore.id, triggerId: trigger.id, notificationRuleId: notificationRule.id, templateId: template.id, templateVersionId: templateVersion.id, connectionId: connection.id, testRunId: testRun.id };
}
