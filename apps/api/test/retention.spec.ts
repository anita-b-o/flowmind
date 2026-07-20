import { PrismaClient } from "@prisma/client";
import { RetentionService } from "../src/retention/retention.service";

const prisma = new PrismaClient();
const service = new RetentionService(prisma);

describe("run history retention against PostgreSQL", () => {
  const ids: string[] = [];
  afterAll(async () => { await prisma.organization.deleteMany({ where: { id: { in: ids } } }); await prisma.$disconnect(); });

  it("dry-runs without writes and execute removes only eligible tenant rows", async () => {
    const old = new Date("2024-01-01T00:00:00.000Z"); const cutoff = new Date("2025-01-01T00:00:00.000Z");
    const left = await seed("retention-left", old); const right = await seed("retention-right", old); const recent = await seed("retention-recent", new Date());
    ids.push(left.organizationId, right.organizationId, recent.organizationId);

    const dryRun = await service.run({ organizationId: left.organizationId, payloadCutoff: cutoff, metadataCutoff: cutoff, batchSize: 10, execute: false });
    expect(dryRun.candidates).toMatchObject({ payloads: 1, rootExecutions: 1 });
    expect(await prisma.execution.findUnique({ where: { id: left.executionId } })).not.toBeNull();

    const executed = await service.run({ organizationId: left.organizationId, payloadCutoff: cutoff, metadataCutoff: cutoff, batchSize: 10, execute: true });
    expect(executed.changed).toMatchObject({ payloads: 1, rootExecutions: 1 });
    expect(await prisma.execution.findUnique({ where: { id: left.executionId } })).toBeNull();
    expect(await prisma.execution.findUnique({ where: { id: right.executionId } })).not.toBeNull();
    expect(await prisma.execution.findUnique({ where: { id: recent.executionId } })).not.toBeNull();
  });

  it("enforces batch limits and never selects the exact cutoff boundary", async () => {
    const cutoff = new Date("2025-02-01T00:00:00.000Z"); const boundary = await seed("retention-boundary", cutoff); ids.push(boundary.organizationId);
    const report = await service.run({ organizationId: boundary.organizationId, payloadCutoff: cutoff, metadataCutoff: cutoff, batchSize: 1, execute: false });
    expect(report.candidates).toMatchObject({ payloads: 0, rootExecutions: 0 });
  });
});

async function seed(name: string, completedAt: Date) {
  const suffix = `${name}-${Date.now()}-${Math.random()}`;
  const organization = await prisma.organization.create({ data: { name, slug: suffix } });
  const user = await prisma.user.create({ data: { email: `${suffix}@example.com`, name, passwordHash: "hash" } });
  const workflow = await prisma.workflow.create({ data: { organizationId: organization.id, name, createdByUserId: user.id } });
  const execution = await prisma.execution.create({ data: { organizationId: organization.id, workflowId: workflow.id, status: "COMPLETED", inputJson: { secret: "discard" }, contextJson: { secret: "discard" }, outputJson: { secret: "discard" }, completedAt } });
  await prisma.$executeRaw`UPDATE executions SET created_at = ${completedAt}, updated_at = ${completedAt} WHERE id = ${execution.id}`;
  return { organizationId: organization.id, executionId: execution.id };
}
