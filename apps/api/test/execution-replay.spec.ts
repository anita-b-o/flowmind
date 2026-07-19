import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ExecutionReplayMode, OrganizationRole } from "@automation/shared-types";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { QueueService } from "../src/queues/queue.service";

const prisma = new PrismaClient();
const createdOrganizationIds: string[] = [];

describe("execution replay API", () => {
  let app: INestApplication; let jwt: JwtService;
  const queue = { enqueueExecution: jest.fn(async () => ({ id: "queued" })) };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = "replay-access-secret-min-16"; process.env.JWT_REFRESH_SECRET = "replay-refresh-secret-min-16";
    const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(QueueService).useValue(queue).compile();
    app = ref.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.init(); jwt = new JwtService();
  }, 30_000);
  afterEach(async () => { queue.enqueueExecution.mockClear(); await clean(); });
  afterAll(async () => { await clean(); await app.close(); await prisma.$disconnect(); });

  it("full replays the original version, warns for effects, preserves lineage, and allows independent replays", async () => {
    const seed = await fixture("full");
    const source = await sourceExecution(seed, "COMPLETED");
    await prisma.workflow.update({ where: { id: seed.workflow.id }, data: { activeVersionId: seed.version2.id } });

    const preview = await request(app.getHttpServer()).get(`/executions/${source.id}/replay-preview`).query({ mode: ExecutionReplayMode.FullReplay }).set(auth(seed.owner, seed.organization.id)).expect(200);
    expect(preview.body).toMatchObject({ possible: true, originalExecutionId: source.id, workflowVersionId: seed.version1.id, startingStep: null, reason: null });
    expect(preview.body.sideEffectWarnings).toContain("This replay may repeat side effects.");
    expect(preview.body).not.toHaveProperty("inputJson"); expect(preview.body).not.toHaveProperty("contextJson");

    const [first, second] = await Promise.all([replay(seed, source.id, ExecutionReplayMode.FullReplay), replay(seed, source.id, ExecutionReplayMode.FullReplay)]);
    expect(first.body.execution.id).not.toBe(second.body.execution.id);
    const rows = await prisma.execution.findMany({ where: { replayOfExecutionId: source.id }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2); expect(rows.every((row) => row.workflowVersionId === seed.version1.id && row.parentExecutionId === null)).toBe(true);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: source.id } })).status).toBe("COMPLETED");
  });

  it("creates a retry-from-failure with A/B reuse and no synthetic attempts", async () => {
    const seed = await fixture("retry"); const source = await sourceExecution(seed, "FAILED");
    const [a, b] = await Promise.all([
      createStep(source.id, seed, "a", "transform", "COMPLETED", 1), createStep(source.id, seed, "b", "database_record", "COMPLETED", 2)
    ]);
    await createStep(source.id, seed, "c", "transform", "FAILED", 3);
    const preview = await request(app.getHttpServer()).get(`/executions/${source.id}/replay-preview`).query({ mode: ExecutionReplayMode.RetryFromFailure }).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(preview.body).toMatchObject({ possible: true, startingStep: { stepKey: "c", executionPath: "root" } });
    expect(preview.body.reusedSteps.map((step: any) => step.stepKey)).toEqual(expect.arrayContaining(["a", "b"]));

    const response = await replay(seed, source.id, ExecutionReplayMode.RetryFromFailure);
    const recoveryId = response.body.execution.id;
    const reuses = await prisma.executionStepReuse.findMany({ where: { recoveryExecutionId: recoveryId }, orderBy: { stepKey: "asc" } });
    expect(reuses.map((reuse) => reuse.sourceStepExecutionId).sort()).toEqual([a.id, b.id].sort());
    expect(await prisma.stepExecutionAttempt.count({ where: { executionId: recoveryId } })).toBe(0);
    expect(await prisma.stepExecution.count({ where: { executionId: recoveryId, stepKey: { in: ["a", "b"] } } })).toBe(0);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: recoveryId } }))).toMatchObject({ replayOfExecutionId: source.id, replayMode: ExecutionReplayMode.RetryFromFailure, replayFromStepKey: "c" });

    const detail = await request(app.getHttpServer()).get(`/executions/${recoveryId}`).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(detail.body).toMatchObject({ replayOfExecutionId: source.id, replayMode: ExecutionReplayMode.RetryFromFailure, parentExecutionId: null });
    expect(detail.body.steps.filter((step: any) => step.reused).map((step: any) => step.stepKey).sort()).toEqual(["a", "b"]);
    const sourceDetail = await request(app.getHttpServer()).get(`/executions/${source.id}`).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(sourceDetail.body.replayExecutions.map((item: any) => item.id)).toContain(recoveryId);
    const timeline = await request(app.getHttpServer()).get(`/executions/${recoveryId}/timeline`).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(timeline.body.items.filter((item: any) => item.type === "reused_step")).toHaveLength(2);
    const reusedDetail = await request(app.getHttpServer()).get(`/executions/${recoveryId}/steps/reuse:${reuses[0].id}`).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(reusedDetail.body).toMatchObject({ reused: true, attempts: [], reusedFromExecutionId: source.id });
    expect(reusedDetail.body).not.toHaveProperty("outputJson");
  });

  it("is fail-closed, enforces RBAC/tenancy, and deduplicates only the same idempotent action", async () => {
    const seed = await fixture("security"); const source = await sourceExecution(seed, "FAILED");
    await createStep(source.id, seed, "c", "transform", "FAILED", 1);
    await prisma.execution.update({ where: { id: source.id }, data: { contextJson: { trigger: {}, steps: {}, recoveryCheckpoint: { complete: false } } } });
    const blocked = await request(app.getHttpServer()).get(`/executions/${source.id}/replay-preview`).query({ mode: ExecutionReplayMode.RetryFromFailure }).set(auth(seed.viewer, seed.organization.id)).expect(200);
    expect(blocked.body).toMatchObject({ possible: false, reason: "CHECKPOINT_INCOMPLETE" });
    await request(app.getHttpServer()).post(`/executions/${source.id}/replay`).set(auth(seed.viewer, seed.organization.id)).send({ mode: ExecutionReplayMode.FullReplay }).expect(403);
    await request(app.getHttpServer()).get(`/executions/${source.id}/replay-preview`).query({ mode: ExecutionReplayMode.FullReplay }).set(auth(seed.outsider, seed.otherOrganization.id)).expect(404);

    await prisma.execution.update({ where: { id: source.id }, data: { contextJson: checkpoint() } });
    const headers = { ...auth(seed.owner, seed.organization.id), "Idempotency-Key": "same-replay" };
    const first = await request(app.getHttpServer()).post(`/executions/${source.id}/replay`).set(headers).send({ mode: ExecutionReplayMode.FullReplay }).expect(201);
    const second = await request(app.getHttpServer()).post(`/executions/${source.id}/replay`).set(headers).send({ mode: ExecutionReplayMode.FullReplay }).expect(201);
    expect(second.body.execution.id).toBe(first.body.execution.id);
  });

  it("lets editors replay and keeps cancellation isolated from the source", async () => {
    const seed = await fixture("cancel");
    const source = await sourceExecution(seed, "COMPLETED");
    const created = await request(app.getHttpServer())
      .post(`/executions/${source.id}/replay`)
      .set(auth(seed.editor, seed.organization.id))
      .send({ mode: ExecutionReplayMode.FullReplay })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/executions/${created.body.execution.id}/cancel`)
      .set(auth(seed.editor, seed.organization.id))
      .send({ reason: "operator cancelled replay" })
      .expect(201);

    expect((await prisma.execution.findUniqueOrThrow({ where: { id: created.body.execution.id } })).status).toBe("CANCELLED");
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: source.id } })).status).toBe("COMPLETED");
  });

  async function replay(seed: any, id: string, mode: ExecutionReplayMode) { return request(app.getHttpServer()).post(`/executions/${id}/replay`).set(auth(seed.owner, seed.organization.id)).send({ mode }).expect(201); }
  async function sourceExecution(seed: any, status: "COMPLETED" | "FAILED") { return prisma.execution.create({ data: { organizationId: seed.organization.id, workflowId: seed.workflow.id, workflowVersionId: seed.version1.id, status, executionMode: "REAL", inputJson: { trigger: { body: { id: 1 } } }, contextJson: checkpoint(), completedAt: new Date() } }); }
  async function createStep(executionId: string, seed: any, key: string, type: string, status: "COMPLETED" | "FAILED", position: number) { const workflowStep = await prisma.workflowStep.findUnique({ where: { workflowVersionId_key: { workflowVersionId: seed.version1.id, key } } }); return prisma.stepExecution.create({ data: { organizationId: seed.organization.id, executionId, workflowStepId: workflowStep?.id, stepKey: key, stepType: type, status, inputJson: {}, outputJson: status === "COMPLETED" ? { value: key } : undefined, errorJson: status === "FAILED" ? { message: "failed", classification: "non_retryable" } : undefined, attemptCount: 1, maxAttempts: 1, startedAt: new Date(Date.now() + position), completedAt: new Date(Date.now() + position) } }); }
  async function fixture(suffix: string) {
    const owner = await user(`replay-owner-${suffix}@example.com`); const editor = await user(`replay-editor-${suffix}@example.com`); const viewer = await user(`replay-viewer-${suffix}@example.com`); const outsider = await user(`replay-outsider-${suffix}@example.com`);
    const organization = await prisma.organization.create({ data: { name: `Replay ${suffix}`, slug: `replay-${suffix}-${Date.now()}`, members: { create: [{ userId: owner.id, role: OrganizationRole.Owner }, { userId: editor.id, role: OrganizationRole.Editor }, { userId: viewer.id, role: OrganizationRole.Viewer }] } } });
    const otherOrganization = await prisma.organization.create({ data: { name: `Other ${suffix}`, slug: `other-${suffix}-${Date.now()}`, members: { create: { userId: outsider.id, role: OrganizationRole.Owner } } } });
    createdOrganizationIds.push(organization.id, otherOrganization.id);
    const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Replay workflow", status: "ACTIVE", createdByUserId: owner.id } });
    const version1 = await version(workflow.id, organization.id, owner.id, 1); const version2 = await version(workflow.id, organization.id, owner.id, 2);
    await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version1.id } });
    return { owner, editor, viewer, outsider, organization, otherOrganization, workflow, version1, version2 };
  }
  async function version(workflowId: string, organizationId: string, userId: string, versionNumber: number) { return prisma.workflowVersion.create({ data: { organizationId, workflowId, versionNumber, status: "ACTIVE", activatedAt: new Date(), definitionJson: { workflowDefinitionSchemaVersion: 2, graph: { entryStepKey: "a", edges: [{ from: "a", to: "b", kind: "next" }, { from: "b", to: "c", kind: "next" }, { from: "c", to: "d", kind: "next" }], terminalStepKeys: ["d"] }, workflowVariables: {}, environmentVariables: {} }, createdByUserId: userId, steps: { create: [row(organizationId, "a", "transform", 1), row(organizationId, "b", "database_record", 2), row(organizationId, "c", "transform", 3), row(organizationId, "d", "transform", 4)] } } }); }
  async function user(email: string) { const row = await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: "hash" } }); return { id: row.id, accessToken: await jwt.signAsync({ sub: row.id, email, tokenType: "access", jti: row.id }, { secret: process.env.JWT_ACCESS_SECRET }) }; }
});

function row(organizationId: string, key: string, type: string, position: number) { return { organizationId, key, name: key, type, position, configJson: type === "database_record" ? { collection: "effects", data: { key } } : {} }; }
function checkpoint() { return { trigger: {}, steps: {}, metadata: {}, __runtime: { variables: {}, workflowVariables: {}, initialExecutionVariables: {}, initialWorkflowVariables: {} }, recoveryCheckpoint: { schemaVersion: 1, complete: true, initialExecutionVariables: {}, initialWorkflowVariables: {}, executionVariables: {}, workflowVariables: {} } }; }
function auth(user: { accessToken: string }, organizationId: string) { return { authorization: `Bearer ${user.accessToken}`, "x-organization-id": organizationId }; }
async function clean() {
  const organizationIds = createdOrganizationIds.splice(0);
  if (organizationIds.length) {
    await prisma.executionStepReuse.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await prisma.execution.updateMany({ where: { organizationId: { in: organizationIds } }, data: { replayOfExecutionId: null, retryOfExecutionId: null } });
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: "replay-" } } });
}
