import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";

const prisma = new PrismaClient();

describe("workflow templates and safe cloning", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = "test-access-secret-min-16";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-16";
    await clean();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 30_000);
  afterAll(async () => { await app?.close(); await clean(); await prisma.$disconnect(); });

  it("versions, publishes, maps and instantiates without copying operational state", async () => {
    const organization = await prisma.organization.create({ data: { name: "Templates", slug: `templates-${Date.now()}` } });
    const other = await prisma.organization.create({ data: { name: "Other", slug: `templates-other-${Date.now()}` } });
    const owner = await member(organization.id, "owner", "template-owner@example.com");
    const editor = await member(organization.id, "editor", "template-editor@example.com");
    const viewer = await member(organization.id, "viewer", "template-viewer@example.com");
    const sourceStore = await prisma.dataStore.create({ data: { organizationId: organization.id, name: "Source state" } });
    const targetStore = await prisma.dataStore.create({ data: { organizationId: organization.id, name: "Target state" } });
    const foreignStore = await prisma.dataStore.create({ data: { organizationId: other.id, name: "Foreign state" } });
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, createdByUserId: editor.userId, name: "Complex source" } });
    const definition = { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "store", name: "Store", type: "data_store_get_record", config: { dataStoreId: sourceStore.id, key: "item" } }], graph: { entryStepKey: "store", edges: [], terminalStepKeys: ["store"] }, workflowVariables: { region: "south" }, environmentVariables: { stage: "test" } };
    const sourceVersion = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, createdByUserId: editor.userId, versionNumber: 1, definitionJson: definition, materializedTriggerSnapshotJson: { materialized: true, triggers: [{ id: "operational-trigger", type: "webhook", enabled: true, tokenPreview: "never-copy", config: { path: "source" } }] }, steps: { create: [{ organizationId: organization.id, key: "webhook", name: "Webhook", type: "webhook_trigger", position: 0, configJson: {} }, { organizationId: organization.id, key: "store", name: "Store", type: "data_store_get_record", position: 1, configJson: { dataStoreId: sourceStore.id, key: "item" } }] } } });
    await prisma.trigger.create({ data: { organizationId: organization.id, workflowId: workflow.id, type: "webhook", tokenHash: "hash", tokenPreview: "preview", configJson: {}, enabled: true } });

    await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(viewer.token, organization.id)).send({ name: "Denied", workflowId: workflow.id, workflowVersionId: sourceVersion.id }).expect(403);
    const created = await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(editor.token, organization.id)).send({ name: "Reusable state", workflowId: workflow.id, workflowVersionId: sourceVersion.id });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const templateId = created.body.id; const templateVersionId = created.body.versions[0].id;
    expect(created.body.versions[0].dependencyManifestJson.dependencies).toEqual([expect.objectContaining({ kind: "DATA_STORE", classification: "REQUIRES_MAPPING", stepKey: "store" })]);
    expect(JSON.stringify(created.body)).not.toContain("never-copy");
    expect((await prisma.workflowVersion.findUniqueOrThrow({ where: { id: sourceVersion.id } })).definitionJson).toEqual(definition);

    await request(app.getHttpServer()).get("/workflow-templates").set(headers(viewer.token, organization.id)).expect(200);
    await request(app.getHttpServer()).patch(`/workflow-templates/${templateId}/versions/${templateVersionId}/publish`).set(headers(editor.token, organization.id)).send({}).expect(403);
    await request(app.getHttpServer()).patch(`/workflow-templates/${templateId}/versions/${templateVersionId}/publish`).set(headers(owner.token, organization.id)).send({}).expect(200);
    await expect(prisma.workflowTemplateVersion.update({ where: { id: templateVersionId }, data: { definitionJson: { changed: true } } })).rejects.toThrow();

    const dependencyKey = created.body.versions[0].dependencyManifestJson.dependencies[0].dependencyKey;
    const missing = await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${templateVersionId}/preview`).set(headers(viewer.token, organization.id)).send({ mappings: [] }).expect(201);
    expect(missing.body.canInstantiate).toBe(false);
    const foreign = await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${templateVersionId}/preview`).set(headers(editor.token, organization.id)).send({ mappings: [{ dependencyKey, targetResourceId: foreignStore.id }] }).expect(201);
    expect(foreign.body.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_mapping" })]));
    const preview = await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${templateVersionId}/preview`).set(headers(editor.token, organization.id)).send({ mappings: [{ dependencyKey, targetResourceId: targetStore.id }] }).expect(201);
    expect(preview.body.canInstantiate).toBe(true);
    const instantiated = await request(app.getHttpServer()).post(`/workflow-templates/${templateId}/versions/${templateVersionId}/instantiate`).set(headers(editor.token, organization.id)).send({ name: "Instantiated", mappings: [{ dependencyKey, targetResourceId: targetStore.id }] }).expect(201);
    const materialized = await prisma.workflow.findUniqueOrThrow({ where: { id: instantiated.body.id }, include: { versions: { include: { steps: true } }, triggers: true, executions: true } });
    expect(materialized.versions).toHaveLength(1); expect(materialized.versions[0].status).toBe("DRAFT"); expect(materialized.triggers).toHaveLength(0); expect(materialized.executions).toHaveLength(0);
    expect((materialized.versions[0].definitionJson as any).graph).toEqual(definition.graph); expect((materialized.versions[0].definitionJson as any).workflowVariables).toEqual({ region: "south" }); expect((materialized.versions[0].definitionJson as any).steps[0].config.dataStoreId).toBe(targetStore.id);

    const cloned = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/clone`).set(headers(editor.token, organization.id)).send({ sourceWorkflowVersionId: sourceVersion.id, name: "Safe clone", mappings: [] }).expect(201);
    const clone = await prisma.workflow.findUniqueOrThrow({ where: { id: cloned.body.id }, include: { versions: true, triggers: true, executions: true, variables: true } });
    expect(clone.versions).toHaveLength(1); expect(clone.versions[0].status).toBe("DRAFT"); expect(clone.triggers).toHaveLength(0); expect(clone.executions).toHaveLength(0); expect(clone.variables).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: { in: ["template.created", "template.published", "template.instantiated", "workflow.cloned"] } } })).toBe(4);
  }, 30_000);

  it("fails closed for sensitive declarative variables and tenant-hides sources", async () => {
    const organization = await prisma.organization.findFirstOrThrow({ where: { name: "Templates" } });
    const other = await prisma.organization.findFirstOrThrow({ where: { name: "Other" } });
    const editor = await member(organization.id, "editor", "template-sensitive@example.com");
    const foreignWorkflow = await prisma.workflow.create({ data: { organizationId: other.id, createdByUserId: editor.userId, name: "Foreign" } });
    await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(editor.token, organization.id)).send({ name: "Foreign", workflowId: foreignWorkflow.id, workflowVersionId: "missing" }).expect(404);
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, createdByUserId: editor.userId, name: "Sensitive" } });
    const definition = { trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [{ key: "done", name: "Done", type: "transform", config: { mode: "OBJECT", fields: { ok: true } } }], workflowVariables: { api_token: "plain-secret" } };
    const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, createdByUserId: editor.userId, versionNumber: 1, definitionJson: definition, steps: { create: [{ organizationId: organization.id, key: "webhook", name: "Webhook", type: "webhook_trigger", position: 0, configJson: {} }, { organizationId: organization.id, key: "done", name: "Done", type: "transform", position: 1, configJson: { mode: "OBJECT", fields: { ok: true } } }] } } });
    await request(app.getHttpServer()).post("/workflow-templates/from-workflow-version").set(headers(editor.token, organization.id)).send({ name: "Sensitive", workflowId: workflow.id, workflowVersionId: version.id }).expect(400);
    expect(await prisma.workflowTemplate.count({ where: { name: "Sensitive" } })).toBe(0);
  });
});

async function member(organizationId: string, role: "owner" | "editor" | "viewer", email: string) { const user = await prisma.user.create({ data: { email, name: email, passwordHash: "hash" } }); await prisma.organizationMember.create({ data: { organizationId, userId: user.id, role } }); const token = await new JwtService().signAsync({ sub: user.id, email, tokenType: "access", jti: user.id }, { secret: process.env.JWT_ACCESS_SECRET }); return { userId: user.id, token }; }
function headers(token: string, organizationId: string) { return { authorization: `Bearer ${token}`, "x-organization-id": organizationId }; }
async function clean() { await prisma.workflowTemplateVersion.deleteMany(); await prisma.workflowTemplate.deleteMany(); await prisma.notificationDelivery.deleteMany(); await prisma.notificationRequest.deleteMany(); await prisma.notificationRule.deleteMany(); await prisma.approvalRequest.deleteMany(); await prisma.executionStepReuse.deleteMany(); await prisma.deadLetterExecution.deleteMany(); await prisma.internalRecord.deleteMany(); await prisma.stepExecutionAttempt.deleteMany(); await prisma.stepExecution.deleteMany(); await prisma.workflowTestRun.deleteMany(); await prisma.execution.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.webhookReplayNonce.deleteMany(); await prisma.internalEventDelivery.deleteMany(); await prisma.internalEvent.deleteMany(); await prisma.internalEventChain.deleteMany(); await prisma.trigger.deleteMany(); await prisma.dataStoreRecord.deleteMany(); await prisma.dataStore.deleteMany(); await prisma.workflowVariable.deleteMany(); await prisma.organizationVariable.deleteMany(); await prisma.workflowStep.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany(); await prisma.secret.deleteMany(); await prisma.connection.deleteMany(); await prisma.auditLog.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.refreshTokenSession.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany(); }
