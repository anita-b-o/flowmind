import { PrismaClient } from "@prisma/client";
import { DataStoreRuntimeService } from "./data-store-runtime.service";

const prisma = new PrismaClient();

describe("DataStoreRuntimeService", () => {
  let service: DataStoreRuntimeService;
  let organizationId: string;
  let dataStoreName: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    service = new DataStoreRuntimeService(prisma as any);
  });

  beforeEach(async () => {
    await cleanDatabase();
    const organization = await prisma.organization.create({ data: { name: "Runtime Org", slug: `runtime-${Date.now()}` } });
    organizationId = organization.id;
    dataStoreName = "Runtime Store";
    await prisma.dataStore.create({ data: { organizationId, name: dataStoreName } });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("upserts, merges and enforces optimistic concurrency", async () => {
    const context = { organizationId, executionId: "execution-1", stepExecutionId: "step-1" };
    const created = await service.upsert(context, { dataStoreName, key: "counter", value: { count: 1 }, metadata: { source: "test" } });
    expect(created).toMatchObject({ created: true, updated: false, version: 1, value: { count: 1 } });

    const updated = await service.upsert(context, { dataStoreName, key: "counter", value: { label: "ok" }, mode: "merge", optimisticConcurrency: true, expectedVersion: 1 });
    expect(updated).toMatchObject({ created: false, updated: true, version: 2, value: { count: 1, label: "ok" } });

    await expect(service.upsert(context, { dataStoreName, key: "counter", value: { stale: true }, optimisticConcurrency: true, expectedVersion: 1 })).rejects.toThrow("version conflict");
    await expect(service.upsert(context, { dataStoreName, key: "counter", value: ["not-object"], mode: "merge" })).rejects.toThrow("requires existing and incoming values to be JSON objects");

    const replaced = await service.upsert(context, { dataStoreName, key: "counter", value: ["array"], metadata: { replaced: true } });
    expect(replaced).toMatchObject({ updated: true, version: 3, value: ["array"] });
    const read = await service.get(context, { dataStoreName, key: "counter" });
    expect(read).toMatchObject({ found: true, metadata: { replaced: true }, version: 3 });
  });

  it("ignores expired records and lazily soft deletes them", async () => {
    const context = { organizationId, executionId: "execution-2", stepExecutionId: "step-2" };
    await service.upsert(context, { dataStoreName, key: "ttl", value: { ok: true }, ttlSeconds: 0 });

    const read = await service.get(context, { dataStoreName, key: "ttl" });
    expect(read).toMatchObject({ found: false, expired: true });
    expect(await prisma.dataStoreRecord.count({ where: { organizationId, key: "ttl", deletedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId, action: "datastore.record.ttl_expired" } })).toBe(1);

    const recreated = await service.upsert(context, { dataStoreName, key: "ttl", value: { ok: "new" } });
    expect(recreated).toMatchObject({ created: true, version: 1, value: { ok: "new" } });
  });

  it("counts, lists, exists and deletes without returning expired or deleted records", async () => {
    const context = { organizationId, executionId: "execution-3", stepExecutionId: "step-3" };
    await service.upsert(context, { dataStoreName, key: "b", value: { index: 2 } });
    await service.upsert(context, { dataStoreName, key: "a", value: { index: 1 } });
    await service.upsert(context, { dataStoreName, key: "expired", value: { index: 0 }, ttlSeconds: 0 });

    expect(await service.exists(context, { dataStoreName, key: "a" })).toEqual({ exists: true });
    expect(await service.exists(context, { dataStoreName, key: "expired" })).toEqual({ exists: false });
    expect(await service.count(context, { dataStoreName })).toEqual({ count: 2 });

    const firstPage = await service.list(context, { dataStoreName, limit: 1, offset: 0, sortBy: "key", direction: "asc" });
    expect(firstPage.items.map((item) => item.key)).toEqual(["a"]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await service.list(context, { dataStoreName, limit: 2, offset: 1, sortBy: "key", direction: "asc" });
    expect(secondPage.items.map((item) => item.key)).toEqual(["b"]);

    expect(await service.delete(context, { dataStoreName, key: "a" })).toEqual({ deleted: true, existed: true });
    expect(await service.delete(context, { dataStoreName, key: "a" })).toEqual({ deleted: false, existed: false });
    expect(await service.count(context, { dataStoreName })).toEqual({ count: 1 });
  });

  it("rejects unsafe JSON and invalid limits", async () => {
    const context = { organizationId, executionId: "execution-4", stepExecutionId: "step-4" };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const polluted = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}');

    await expect(service.upsert(context, { dataStoreName, key: "bad", value: circular })).rejects.toThrow("circular");
    await expect(service.upsert(context, { dataStoreName, key: "bad", value: polluted })).rejects.toThrow("not allowed");
    await expect(service.upsert(context, { dataStoreName, key: "bad", value: { ok: true }, ttlSeconds: -1 })).rejects.toThrow("ttlSeconds");
    await expect(service.list(context, { dataStoreName, limit: 0 })).rejects.toThrow("limit");
  });
});

async function cleanDatabase() {
  await prisma.dataStoreRecord.deleteMany();
  await prisma.dataStore.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
