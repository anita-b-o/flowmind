import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { ExecutionReplayMode, ExecutionStatus, StepExecutionStatus } from "@automation/shared-types";
import { WorkerModule } from "../worker.module";
import { WorkflowRunner } from "./workflow-runner";

const prisma = new PrismaClient();

describe("WorkflowRunner execution replay", () => {
  let context: { close(): Promise<void>; init(): Promise<void>; get<T>(value: any): T }; let runner: WorkflowRunner; let organizationId: string;
  beforeAll(async () => { process.env.REDIS_URL ??= "redis://localhost:6379"; context = await Test.createTestingModule({ imports: [WorkerModule] }).compile() as any; await context.init(); runner = context.get(WorkflowRunner); }, 30_000);
  afterEach(async () => { if (organizationId) await cleanup(organizationId); organizationId = ""; });
  afterAll(async () => { await context.close(); await prisma.$disconnect(); });

  it("reuses completed effects in RETRY_FROM_FAILURE and repeats them in FULL_REPLAY", async () => {
    const seed = await fixture(); organizationId = seed.organization.id;
    const source = await prisma.execution.create({ data: { organizationId, workflowId: seed.workflow.id, workflowVersionId: seed.version.id, status: ExecutionStatus.Failed, executionMode: "REAL", inputJson: { trigger: { body: { id: 1 } } }, contextJson: checkpoint(), completedAt: new Date() } });
    const a = await sourceStep(source.id, seed, "a", "transform", StepExecutionStatus.Completed, { value: "a" });
    const b = await sourceStep(source.id, seed, "b", "database_record", StepExecutionStatus.Completed, { recordId: "original-record", collection: "replay_effects" });
    await sourceStep(source.id, seed, "c", "transform", StepExecutionStatus.Failed, null);
    await prisma.internalRecord.create({ data: { organizationId, workflowId: seed.workflow.id, workflowVersionId: seed.version.id, executionId: source.id, stepExecutionId: b.id, collection: "replay_effects", dedupeKey: `flowmind:${source.id}:root:b`, dataJson: { source: true } } });

    const recovery = await prisma.execution.create({ data: { organizationId, workflowId: seed.workflow.id, workflowVersionId: seed.version.id, status: ExecutionStatus.Queued, executionMode: "REAL", replayOfExecutionId: source.id, replayMode: ExecutionReplayMode.RetryFromFailure, replayFromStepKey: "c", replayFromExecutionPath: "root", inputJson: source.inputJson as any, contextJson: checkpoint() } });
    await prisma.executionStepReuse.createMany({ data: [a, b].map((step) => ({ organizationId, recoveryExecutionId: recovery.id, sourceExecutionId: source.id, sourceStepExecutionId: step.id, stepKey: step.stepKey, stepType: step.stepType, executionPath: "root", iterationIndex: null, status: step.status })) });
    await runner.run(job(recovery, seed));

    expect((await prisma.execution.findUniqueOrThrow({ where: { id: recovery.id } })).status).toBe(ExecutionStatus.Completed);
    expect(await prisma.internalRecord.count({ where: { organizationId, collection: "replay_effects" } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: recovery.id, stepKey: { in: ["a", "b"] } } })).toBe(0);
    expect(await prisma.stepExecutionAttempt.count({ where: { executionId: recovery.id } })).toBe(2);
    expect((await prisma.stepExecution.findMany({ where: { executionId: recovery.id }, orderBy: { createdAt: "asc" } })).map((step) => step.stepKey)).toEqual(["c", "d"]);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: source.id } })).status).toBe(ExecutionStatus.Failed);

    const full = await prisma.execution.create({ data: { organizationId, workflowId: seed.workflow.id, workflowVersionId: seed.version.id, status: ExecutionStatus.Queued, executionMode: "REAL", replayOfExecutionId: source.id, replayMode: ExecutionReplayMode.FullReplay, inputJson: source.inputJson as any, contextJson: checkpoint() } });
    await runner.run(job(full, seed));
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: full.id } })).status).toBe(ExecutionStatus.Completed);
    expect(await prisma.internalRecord.count({ where: { organizationId, collection: "replay_effects" } })).toBe(2);
    expect((await prisma.stepExecution.findMany({ where: { executionId: full.id }, orderBy: { createdAt: "asc" } })).map((step) => step.stepKey)).toEqual(["a", "b", "c", "d"]);
    expect(await prisma.internalEvent.count({ where: { eventType: "EXECUTION_COMPLETED", envelopeJson: { path: ["data", "executionId"], equals: recovery.id } } })).toBe(1);
  }, 30_000);
});

async function fixture() {
  const user = await prisma.user.create({ data: { email: `worker-replay-${Date.now()}@example.com`, name: "Replay", passwordHash: "hash" } });
  const organization = await prisma.organization.create({ data: { name: "Worker Replay", slug: `worker-replay-${Date.now()}` } });
  const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name: "Replay", status: "ACTIVE", createdByUserId: user.id } });
  const version = await prisma.workflowVersion.create({ data: { organizationId: organization.id, workflowId: workflow.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date(), createdByUserId: user.id, definitionJson: { workflowDefinitionSchemaVersion: 2, graph: { entryStepKey: "a", edges: [{ from: "a", to: "b", kind: "next" }, { from: "b", to: "c", kind: "next" }, { from: "c", to: "d", kind: "next" }], terminalStepKeys: ["d"] }, workflowVariables: {}, environmentVariables: {}, expressionMode: "strict" }, steps: { create: [step(organization.id, "a", "transform", 1), step(organization.id, "b", "database_record", 2), step(organization.id, "c", "transform", 3), step(organization.id, "d", "transform", 4)] } } });
  await prisma.workflow.update({ where: { id: workflow.id }, data: { activeVersionId: version.id } }); return { user, organization, workflow, version };
}
function step(organizationId: string, key: string, type: string, position: number) { return { organizationId, key, name: key, type, position, configJson: type === "database_record" ? { collection: "replay_effects", data: { replayed: true } } : { mode: "OBJECT", fields: { value: key }, outputType: "OBJECT" } }; }
async function sourceStep(executionId: string, seed: any, key: string, type: string, status: StepExecutionStatus, outputJson: any) { const workflowStep = await prisma.workflowStep.findUniqueOrThrow({ where: { workflowVersionId_key: { workflowVersionId: seed.version.id, key } } }); return prisma.stepExecution.create({ data: { organizationId: seed.organization.id, executionId, workflowStepId: workflowStep.id, stepKey: key, stepType: type, status, attempt: 1, attemptCount: 1, maxAttempts: 1, inputJson: {}, outputJson: outputJson ?? undefined, errorJson: status === StepExecutionStatus.Failed ? { message: "transient source failure", classification: "non_retryable" } : undefined, errorHandled: false, startedAt: new Date(), completedAt: new Date(), effectStatus: status === StepExecutionStatus.Completed ? "succeeded" : "failed" } }); }
function checkpoint() { return { trigger: { body: { id: 1 } }, steps: {}, metadata: {}, __runtime: { variables: {}, workflowVariables: {}, initialExecutionVariables: {}, initialWorkflowVariables: {} }, recoveryCheckpoint: { schemaVersion: 1, complete: true, initialExecutionVariables: {}, initialWorkflowVariables: {}, executionVariables: {}, workflowVariables: {} } }; }
function job(execution: { id: string }, seed: any) { return { organizationId: seed.organization.id, executionId: execution.id, workflowId: seed.workflow.id, workflowVersionId: seed.version.id, requestId: `replay-${execution.id}`, correlationId: `replay-${execution.id}`, enqueuedAt: new Date().toISOString() }; }
async function cleanup(orgId: string) { await prisma.executionStepReuse.deleteMany({ where: { organizationId: orgId } }); await prisma.execution.updateMany({ where: { organizationId: orgId }, data: { replayOfExecutionId: null, retryOfExecutionId: null } }); await prisma.organization.delete({ where: { id: orgId } }); await prisma.user.deleteMany({ where: { email: { startsWith: "worker-replay-" } } }); }
