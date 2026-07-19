import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";
import { SafeHttpClient, type SafeHttpRequest } from "../../worker/src/http/safe-http-client";

const prisma = new PrismaClient();
const httpCalls: SafeHttpRequest[] = [];
let app: INestApplication;

describe("workflow templates runtime smokes A-D", () => {
  let worker: { init: () => Promise<void>; close: () => Promise<void> };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "template-e2e-access-secret";
    process.env.JWT_REFRESH_SECRET = "template-e2e-refresh-secret";
    process.env.CONNECTION_ENCRYPTION_KEY = "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "template-e2e-webhook-pepper";
    const redis = new Redis(process.env.REDIS_URL); await redis.flushdb(); await redis.quit();
    await cleanDatabase();
    const { AppModule } = await import("../src/app.module");
    const { WorkerModule } = await import("../../worker/src/worker.module");
    const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(SafeHttpClient)
      .useValue({ request: async (input: SafeHttpRequest) => { httpCalls.push(structuredClone(input)); return { status: 200, ok: true, body: { provider: input.headers?.Authorization === "Bearer destination-secret" ? "destination" : "original" }, headers: {} }; } })
      .compile();
    worker = workerRef as any; await worker.init();
  }, 30_000);

  afterAll(async () => { await worker?.close(); await app?.close(); await cleanDatabase(); await prisma.$disconnect(); }, 30_000);

  it("Smoke A: instantiates and executes Webhook -> FOR_EACH -> TRY_CATCH -> mapped Data Store", async () => {
    const user = await register("templates-smoke-a@example.com", "Templates Smoke A");
    const sourceStore = await createStore(user, "A source store"); const targetStore = await createStore(user, "A target store");
    const source = await createWorkflow(user, "A source");
    const sourceTrigger = await createTrigger(user, source.id);
    const sourceVersion = await createVersion(user, source.id, complexDefinition(sourceStore.id));
    await publishWorkflow(user, source.id, sourceVersion.id);
    const template = await saveAndPublishTemplate(user, source.id, sourceVersion.id, "A template");
    const manifest = template.version.dependencyManifestJson;
    expect(manifest.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "DATA_STORE", classification: "REQUIRES_MAPPING" })]));
    expect(manifest.triggerHints).toEqual([expect.objectContaining({ type: "webhook" })]);
    expect(JSON.stringify(manifest.triggerHints)).not.toMatch(/sourceTrigger|token|enabled|nextRunAt|createdAt|secret/i);
    const mappings = uniqueMappings(manifest.dependencies, "DATA_STORE", targetStore.id);
    const preview = await previewTemplate(user, template.id, template.version.id, mappings);
    expect(preview.canInstantiate).toBe(true);
    const instantiated = await instantiateTemplate(user, template.id, template.version.id, "A instantiated", mappings);
    const draft = await loadMaterialized(instantiated.id);
    expect(draft.versions).toHaveLength(1); expect(draft.versions[0].status).toBe("DRAFT"); expect(draft.triggers).toHaveLength(0); expect(draft.executions).toHaveLength(0);
    expect((draft.versions[0].definitionJson as any).graph).toEqual((sourceVersion.definitionJson as any).graph);
    expect((draft.versions[0].definitionJson as any).steps.filter((step: any) => step.type.startsWith("data_store_")).every((step: any) => step.config.dataStoreId === targetStore.id)).toBe(true);
    const explicitTrigger = await createTrigger(user, instantiated.id);
    await publishWorkflow(user, instantiated.id, draft.versions[0].id);
    const executionId = await fireWebhook(instantiated.id, explicitTrigger.token, "template-a-runtime", { items: [{ id: "ok", fail: false }, { id: "bad", fail: true }] });
    const completed = await waitForExecution(user, executionId, "COMPLETED");
    expect(completed.steps).toEqual(expect.arrayContaining([expect.objectContaining({ stepKey: "loop", status: "COMPLETED" }), expect.objectContaining({ stepKey: "guard", iterationIndex: 0 }), expect.objectContaining({ stepKey: "caught", iterationIndex: 1, status: "COMPLETED" })]));
    expect(await prisma.dataStoreRecord.count({ where: { dataStoreId: targetStore.id, key: "ok", deletedAt: null } })).toBe(1);
    expect(await prisma.dataStoreRecord.count({ where: { dataStoreId: sourceStore.id } })).toBe(0);
    expect((await prisma.workflowVersion.findUniqueOrThrow({ where: { id: sourceVersion.id } })).definitionJson).toEqual(sourceVersion.definitionJson);
    expect(sourceTrigger.token).toBeDefined();
  }, 40_000);

  it("Smoke B: executes a pinned EXECUTE_WORKFLOW against the mapped child", async () => {
    const user = await register("templates-smoke-b@example.com", "Templates Smoke B");
    const original = await publishedChild(user, "Original child", "original");
    const destination = await publishedChild(user, "Destination child", "destination");
    const parent = await createWorkflow(user, "B parent source");
    const parentVersion = await createVersion(user, parent.id, parentDefinition(original.workflow.id, original.version.id));
    await publishWorkflow(user, parent.id, parentVersion.id);
    const template = await saveAndPublishTemplate(user, parent.id, parentVersion.id, "B template");
    const dependency = template.version.dependencyManifestJson.dependencies.find((item: any) => item.kind === "WORKFLOW");
    expect(dependency).toMatchObject({ classification: "REQUIRES_MAPPING", expectedType: "PINNED_VERSION" });
    const mappings = [{ dependencyKey: dependency.dependencyKey, targetResourceId: destination.workflow.id, targetWorkflowVersionId: destination.version.id }];
    expect((await previewTemplate(user, template.id, template.version.id, mappings)).canInstantiate).toBe(true);
    const instantiated = await instantiateTemplate(user, template.id, template.version.id, "B instantiated", mappings);
    const draft = await loadMaterialized(instantiated.id); const call = (draft.versions[0].definitionJson as any).steps.find((step: any) => step.type === "execute_workflow");
    expect(call.config).toMatchObject({ workflowId: destination.workflow.id, workflowVersionId: destination.version.id, versionPolicy: "PINNED_VERSION" });
    await publishWorkflow(user, instantiated.id, draft.versions[0].id);
    const started = await request(app.getHttpServer()).post(`/workflows/${instantiated.id}/executions`).set(headers(user)).send({ confirmRealEffects: true, input: { trigger: { body: { value: 7 } } } }).expect(201);
    const completed = await waitForExecution(user, started.body.execution.id, "COMPLETED");
    expect(completed.childExecutions).toHaveLength(1);
    const child = await prisma.execution.findUniqueOrThrow({ where: { id: completed.childExecutions[0].id } });
    expect(child).toMatchObject({ workflowId: destination.workflow.id, workflowVersionId: destination.version.id, parentExecutionId: started.body.execution.id, rootExecutionId: started.body.execution.id, status: "COMPLETED" });
    expect(child.workflowId).not.toBe(original.workflow.id); expect(child.outputJson).toEqual({ target: "destination", value: 7 });
    expect(await prisma.internalRecord.count({ where: { executionId: started.body.execution.id, collection: "mapped_child_result", dataJson: { path: ["target"], equals: "destination" } } })).toBe(1);
  }, 40_000);

  it("Smoke C: resolves and executes only the mapped Connection without exposing secrets", async () => {
    httpCalls.length = 0;
    const user = await register("templates-smoke-c@example.com", "Templates Smoke C");
    const other = await register("templates-smoke-c-other@example.com", "Templates Smoke C Other");
    const original = await createHttpConnection(user, "Original connection", "original-secret");
    const destination = await createHttpConnection(user, "Destination connection", "destination-secret");
    const foreign = await createHttpConnection(other, "Foreign connection", "foreign-secret");
    const source = await createWorkflow(user, "C source"); const sourceVersion = await createVersion(user, source.id, connectionDefinition(original.id)); await publishWorkflow(user, source.id, sourceVersion.id);
    const template = await saveAndPublishTemplate(user, source.id, sourceVersion.id, "C template");
    const serialized = JSON.stringify(template);
    expect(template.version.dependencyManifestJson.dependencies).toEqual([expect.objectContaining({ kind: "CONNECTION", classification: "REQUIRES_MAPPING", expectedType: "http_api_key" })]);
    expect(serialized).not.toMatch(/original-secret|destination-secret|foreign-secret/);
    const dependencyKey = template.version.dependencyManifestJson.dependencies[0].dependencyKey;
    const foreignMapping = [{ dependencyKey, targetResourceId: foreign.id }];
    const blocked = await previewTemplate(user, template.id, template.version.id, foreignMapping); expect(blocked.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_mapping" })]));
    const countBefore = await prisma.workflow.count({ where: { organizationId: user.organizationId } });
    await request(app.getHttpServer()).post(`/workflow-templates/${template.id}/versions/${template.version.id}/instantiate`).set(headers(user)).send({ name: "Must not exist", mappings: foreignMapping }).expect(400);
    expect(await prisma.workflow.count({ where: { organizationId: user.organizationId } })).toBe(countBefore);
    const mappings = [{ dependencyKey, targetResourceId: destination.id }];
    const instantiated = await instantiateTemplate(user, template.id, template.version.id, "C instantiated", mappings);
    const draft = await loadMaterialized(instantiated.id); expect((draft.versions[0].definitionJson as any).steps[0].config.connectionId).toBe(destination.id);
    await publishWorkflow(user, instantiated.id, draft.versions[0].id);
    const started = await request(app.getHttpServer()).post(`/workflows/${instantiated.id}/executions`).set(headers(user)).send({ confirmRealEffects: true, input: { trigger: { body: {} } } }).expect(201);
    const completed = await waitForExecution(user, started.body.execution.id, "COMPLETED");
    expect(httpCalls).toHaveLength(1); expect(httpCalls[0].headers?.Authorization).toBe("Bearer destination-secret"); expect(httpCalls[0].headers?.Authorization).not.toContain("original-secret");
    const step = completed.steps.find((item: any) => item.stepKey === "call");
    const publicStep = await request(app.getHttpServer()).get(`/executions/${started.body.execution.id}/steps/${step.id}`).set(headers(user)).expect(200);
    expect(JSON.stringify(publicStep.body)).not.toMatch(/original-secret|destination-secret|foreign-secret/);
  }, 40_000);

  it("Smoke D: clones declarative state only and preserves sanitized trigger hints", async () => {
    const user = await register("templates-smoke-d@example.com", "Templates Smoke D");
    const source = await createWorkflow(user, "D source"); const operational = await createTrigger(user, source.id);
    const sourceVersion = await createVersion(user, source.id, simpleDefinition()); await publishWorkflow(user, source.id, sourceVersion.id);
    await prisma.workflowVariable.create({ data: { organizationId: user.organizationId, workflowId: source.id, key: "historical", valueJson: "runtime" } });
    const executionId = await fireWebhook(source.id, operational.token, "template-d-runtime", { value: "history" }); await waitForExecution(user, executionId, "COMPLETED");
    expect(await prisma.stepExecution.count({ where: { executionId } })).toBeGreaterThan(0); expect(await prisma.stepExecutionAttempt.count({ where: { stepExecution: { executionId } } })).toBeGreaterThan(0);
    const preview = await request(app.getHttpServer()).post(`/workflows/${source.id}/clone-preview`).set(headers(user)).send({ sourceWorkflowVersionId: sourceVersion.id, name: "D clone", mappings: [] }).expect(201);
    expect(preview.body.triggerHints).toEqual([expect.objectContaining({ type: "webhook" })]);
    expect(JSON.stringify(preview.body.triggerHints)).not.toMatch(/token|enabled|nextRunAt|createdAt|updatedAt|secret|state|\"id\"/i);
    const cloned = await request(app.getHttpServer()).post(`/workflows/${source.id}/clone`).set(headers(user)).send({ sourceWorkflowVersionId: sourceVersion.id, name: "D clone", mappings: [] }).expect(201);
    const clone = await loadMaterialized(cloned.body.id);
    expect(clone.versions).toHaveLength(1); expect(clone.versions[0].status).toBe("DRAFT"); expect(clone.versions[0].definitionJson).toEqual(sourceVersion.definitionJson);
    expect(clone.triggers).toHaveLength(0); expect(clone.executions).toHaveLength(0); expect(clone.variables).toHaveLength(0);
    expect(await prisma.stepExecution.count({ where: { execution: { workflowId: clone.id } } })).toBe(0);
    expect(await prisma.stepExecutionAttempt.count({ where: { stepExecution: { execution: { workflowId: clone.id } } } })).toBe(0);
    expect(await prisma.approvalRequest.count({ where: { workflowId: clone.id } })).toBe(0);
    expect(await prisma.internalEvent.count({ where: { envelopeJson: { path: ["data", "workflowId"], equals: clone.id } } })).toBe(0);
    expect(await prisma.notificationRequest.count({ where: { payloadJson: { path: ["workflowId"], equals: clone.id } } })).toBe(0);
    expect(JSON.stringify(clone)).not.toMatch(/webhook token|original-secret|destination-secret/i);
  }, 40_000);

  it("keeps published snapshots immutable and resolves instantiate/archive concurrency coherently", async () => {
    const user = await register("templates-concurrency@example.com", "Templates Concurrency");
    const source = await createWorkflow(user, "Concurrent source"); const version = await createVersion(user, source.id, simpleDefinition()); await publishWorkflow(user, source.id, version.id);
    const template = await saveAndPublishTemplate(user, source.id, version.id, "Concurrent template");
    await expect(prisma.workflowTemplateVersion.update({ where: { id: template.version.id }, data: { definitionJson: { changed: true } } })).rejects.toThrow();
    await expect(prisma.workflowTemplateVersion.update({ where: { id: template.version.id }, data: { dependencyManifestJson: { changed: true } } })).rejects.toThrow();
    const [instantiate, archive] = await Promise.all([
      request(app.getHttpServer()).post(`/workflow-templates/${template.id}/versions/${template.version.id}/instantiate`).set(headers(user)).send({ name: "Concurrent result", mappings: [] }),
      request(app.getHttpServer()).patch(`/workflow-templates/${template.id}/archive`).set(headers(user)).send({})
    ]);
    expect(archive.status).toBe(200); expect([201, 409]).toContain(instantiate.status);
    const rows = await prisma.workflow.findMany({ where: { organizationId: user.organizationId, name: "Concurrent result" }, include: { versions: true } });
    expect(rows.length).toBe(instantiate.status === 201 ? 1 : 0); expect(rows.every((row) => row.versions.length === 1)).toBe(true);
    const persisted = await prisma.workflowTemplateVersion.findUniqueOrThrow({ where: { id: template.version.id } });
    expect(persisted.definitionJson).toEqual(template.version.definitionJson); expect(persisted.dependencyManifestJson).toEqual(template.version.dependencyManifestJson);
  }, 30_000);

  it("blocks sensitive declarative variables without persisting or echoing their value", async () => {
    const user = await register("templates-sensitive-e2e@example.com", "Templates Sensitive E2E"); const source = await createWorkflow(user, "Sensitive source");
    const sensitiveValue = "sensitive-value-must-not-leak";
    const version = await prisma.workflowVersion.create({ data: { organizationId: user.organizationId, workflowId: source.id, createdByUserId: await userId(user), versionNumber: 1, definitionJson: { ...simpleDefinition(), workflowVariables: { api_token: sensitiveValue }, environmentVariables: { safe: "ok" } }, steps: { create: materializedSteps(user.organizationId, simpleDefinition()) } } });
    const response = await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(user)).send({ name: "Blocked sensitive", workflowId: source.id, workflowVersionId: version.id }).expect(400);
    expect(JSON.stringify(response.body)).not.toContain(sensitiveValue); expect(await prisma.workflowTemplate.count({ where: { name: "Blocked sensitive" } })).toBe(0);
  });
});

type TestUser = { accessToken: string; organizationId: string };
async function register(email: string, organizationName: string): Promise<TestUser> { const response = await request(app.getHttpServer()).post("/auth/register").send({ email, name: email.split("@")[0], password: "password123", organizationName }).expect(201); return { accessToken: response.body.accessToken, organizationId: response.body.defaultOrganizationId }; }
function headers(user: TestUser) { return { authorization: `Bearer ${user.accessToken}`, "x-organization-id": user.organizationId }; }
async function userId(user: TestUser) { return (await request(app.getHttpServer()).get("/auth/me").set(headers(user)).expect(200)).body.user.id as string; }
async function createWorkflow(user: TestUser, name: string) { return (await request(app.getHttpServer()).post("/workflows").set(headers(user)).send({ name }).expect(201)).body; }
async function createVersion(user: TestUser, workflowId: string, definition: any) { return (await request(app.getHttpServer()).post(`/workflows/${workflowId}/versions`).set(headers(user)).send(definition).expect(201)).body; }
async function publishWorkflow(user: TestUser, workflowId: string, versionId: string) { await request(app.getHttpServer()).patch(`/workflows/${workflowId}/versions/${versionId}/activate`).set(headers(user)).expect(200); }
async function createTrigger(user: TestUser, workflowId: string) { return (await request(app.getHttpServer()).post(`/workflows/${workflowId}/triggers`).set(headers(user)).send({}).expect(201)).body; }
async function createStore(user: TestUser, name: string) { return (await request(app.getHttpServer()).post("/data-stores").set(headers(user)).send({ name }).expect(201)).body; }
async function createHttpConnection(user: TestUser, name: string, secretValue: string) { return (await request(app.getHttpServer()).post("/connections").set(headers(user)).send({ type: "HTTP", authScheme: "BEARER", name, baseUrl: "https://provider.example", secretValue }).expect(201)).body; }
async function saveAndPublishTemplate(user: TestUser, workflowId: string, workflowVersionId: string, name: string) { const created = (await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(user)).send({ name, workflowId, workflowVersionId }).expect(201)).body; const version = created.versions[0]; await request(app.getHttpServer()).patch(`/workflow-templates/${created.id}/versions/${version.id}/publish`).set(headers(user)).send({}).expect(200); return { ...created, version }; }
async function previewTemplate(user: TestUser, templateId: string, versionId: string, mappings: any[]) { return (await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${versionId}/preview`).set(headers(user)).send({ mappings }).expect(201)).body; }
async function instantiateTemplate(user: TestUser, templateId: string, versionId: string, name: string, mappings: any[]) { return (await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${versionId}/instantiate`).set(headers(user)).send({ name, mappings }).expect(201)).body; }
async function loadMaterialized(workflowId: string) { return prisma.workflow.findUniqueOrThrow({ where: { id: workflowId }, include: { versions: { include: { steps: true } }, triggers: true, executions: true, variables: true } }); }
async function fireWebhook(workflowId: string, token: string, key: string, body: object) { return (await request(app.getHttpServer()).post(`/webhooks/${workflowId}/${token}`).set("Idempotency-Key", key).send(body).expect(202)).body.executionId as string; }
async function waitForExecution(user: TestUser, executionId: string, status: string) { let last: any; for (let attempt = 0; attempt < 80; attempt += 1) { last = (await request(app.getHttpServer()).get(`/executions/${executionId}`).set(headers(user)).expect(200)).body; if (last.status === status) return last; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Execution ${executionId} did not reach ${status}: ${JSON.stringify(last?.error)}`); }
function uniqueMappings(dependencies: any[], kind: string, targetResourceId: string) { return [...new Set(dependencies.filter((item) => item.kind === kind).map((item) => item.dependencyKey))].map((dependencyKey) => ({ dependencyKey, targetResourceId })); }

function complexDefinition(dataStoreId: string) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [
  { key: "loop", name: "Loop", type: "for_each", config: { source: "{{trigger.body.items}}", mode: "SEQUENTIAL", maxItems: 10 } }, { key: "guard", name: "Guard", type: "try_catch", config: {} },
  { key: "route", name: "Route", type: "if", config: { left: "{{item.fail}}", operator: "equals", right: true, trueStepKey: "missing", falseStepKey: "upsert" } },
  { key: "missing", name: "Missing", type: "data_store_get_record", config: { dataStoreId, key: "missing", failIfMissing: true } }, { key: "upsert", name: "Upsert", type: "data_store_upsert_record", config: { dataStoreId, key: "{{item.id}}", value: { ok: true }, mode: "replace" } },
  { key: "caught", name: "Caught", type: "set_variable", config: { scope: "execution", name: "handled", value: true } }, { key: "cleanup", name: "Cleanup", type: "transform", config: { mode: "OBJECT", fields: { cleaned: true }, outputType: "OBJECT" } },
  { key: "iteration_done", name: "Iteration done", type: "transform", config: { mode: "OBJECT", fields: { done: true }, outputType: "OBJECT" } }, { key: "done", name: "Done", type: "data_store_count_records", config: { dataStoreId } }
], graph: { entryStepKey: "loop", edges: [
  { from: "loop", to: "guard", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" }, { from: "guard", to: "route", kind: "try_body" }, { from: "guard", to: "caught", kind: "try_catch" }, { from: "guard", to: "cleanup", kind: "try_finally" }, { from: "guard", to: "iteration_done", kind: "try_done" },
  { from: "route", to: "missing", kind: "if_true" }, { from: "route", to: "upsert", kind: "if_false" }, { from: "missing", to: "cleanup", kind: "next" }, { from: "upsert", to: "cleanup", kind: "next" }, { from: "caught", to: "cleanup", kind: "next" }, { from: "cleanup", to: "iteration_done", kind: "next" }, { from: "iteration_done", to: "done", kind: "next" }
], terminalStepKeys: ["done"] } }; }
function parentDefinition(workflowId: string, workflowVersionId: string) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "call", name: "Call child", type: "execute_workflow", config: { workflowId, workflowVersionId, versionPolicy: "PINNED_VERSION", input: "{{trigger.body}}", timeoutSeconds: 30 } }, { key: "save", name: "Save", type: "database_record", config: { collection: "mapped_child_result", data: { target: "{{steps.call.output.output.target}}", value: "{{steps.call.output.output.value}}" } } }], graph: { entryStepKey: "call", edges: [{ from: "call", to: "save", kind: "next" }], terminalStepKeys: ["save"] } }; }
async function publishedChild(user: TestUser, name: string, target: string) { const workflow = await createWorkflow(user, name); const version = await createVersion(user, workflow.id, { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "subworkflow", name: "Input", type: "subworkflow_trigger", config: {} }, steps: [{ key: "shape", name: "Shape", type: "transform", config: { mode: "OBJECT", fields: { target, value: "{{trigger.input.value}}" }, outputType: "OBJECT" } }, { key: "return", name: "Return", type: "return_workflow_output", config: { output: "{{steps.shape.output}}" } }], graph: { entryStepKey: "shape", edges: [{ from: "shape", to: "return", kind: "next" }], terminalStepKeys: ["return"] } }); await publishWorkflow(user, workflow.id, version.id); return { workflow, version }; }
function connectionDefinition(connectionId: string) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "call", name: "Call provider", type: "http_request", config: { connectionId, url: "/resource", method: "GET" } }], graph: { entryStepKey: "call", edges: [], terminalStepKeys: ["call"] } }; }
function simpleDefinition() { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "save", name: "Save", type: "database_record", config: { collection: "clone_history", data: { value: "{{trigger.body.value}}" } } }], graph: { entryStepKey: "save", edges: [], terminalStepKeys: ["save"] } }; }
function materializedSteps(organizationId: string, definition: any) { return [{ organizationId, key: definition.trigger.key, name: definition.trigger.name, type: definition.trigger.type, position: 0, configJson: definition.trigger.config }, ...definition.steps.map((step: any, index: number) => ({ organizationId, key: step.key, name: step.name, type: step.type, position: index + 1, configJson: step.config }))]; }

async function cleanDatabase() {
  await prisma.workflowTemplateVersion.deleteMany(); await prisma.workflowTemplate.deleteMany(); await prisma.notificationDelivery.deleteMany(); await prisma.notificationRequest.deleteMany(); await prisma.notificationRule.deleteMany(); await prisma.approvalRequest.deleteMany(); await prisma.executionStepReuse.deleteMany(); await prisma.deadLetterExecution.deleteMany(); await prisma.internalRecord.deleteMany(); await prisma.stepExecutionAttempt.deleteMany(); await prisma.stepExecution.deleteMany(); await prisma.workflowTestRun.deleteMany(); await prisma.execution.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.webhookReplayNonce.deleteMany(); await prisma.internalEventDelivery.deleteMany(); await prisma.internalEvent.deleteMany(); await prisma.internalEventChain.deleteMany(); await prisma.trigger.deleteMany(); await prisma.dataStoreRecord.deleteMany(); await prisma.dataStore.deleteMany(); await prisma.workflowVariable.deleteMany(); await prisma.organizationVariable.deleteMany(); await prisma.workflowStep.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany(); await prisma.secret.deleteMany(); await prisma.connection.deleteMany(); await prisma.auditLog.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.refreshTokenSession.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany();
}
