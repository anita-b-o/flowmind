import { BadRequestException } from "@nestjs/common";
import { RetentionService } from "./retention.service";

const options = {
  organizationId: "org-a",
  payloadCutoff: new Date("2025-01-01T00:00:00.000Z"),
  metadataCutoff: new Date("2025-03-01T00:00:00.000Z"),
  batchSize: 25,
  execute: false
};

describe("RetentionService", () => {
  it("reports eligible data in dry-run without issuing writes", async () => {
    const prisma: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: "root", createdAt: new Date("2024-01-01") }])
        .mockResolvedValueOnce([{ id: "payload", createdAt: new Date("2024-02-01"), bytes: 123n }]),
      execution: { updateMany: jest.fn() }, stepExecution: { updateMany: jest.fn() }
    };
    const report = await new RetentionService(prisma).run(options);
    expect(report).toMatchObject({ mode: "dry_run", organizationId: "org-a", candidates: { payloads: 1, rootExecutions: 1, estimatedJsonBytes: 123 }, changed: { payloads: 0, rootExecutions: 0 } });
    expect(prisma.execution.updateMany).not.toHaveBeenCalled();
  });

  it("tombstones only the requested tenant and bounded candidate ids", async () => {
    const tx: any = { execution: { findMany: jest.fn(async () => []), updateMany: jest.fn(), delete: jest.fn() }, executionStepReuse: { deleteMany: jest.fn() } };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "eligible", createdAt: new Date("2024-01-01"), bytes: 5n }]),
      execution: { updateMany: jest.fn(async () => ({ count: 1 })) },
      stepExecution: { updateMany: jest.fn(async () => ({ count: 1 })) },
      $transaction: jest.fn((callback: any) => callback(tx))
    };
    const report = await new RetentionService(prisma).run({ ...options, execute: true });
    expect(report.changed.payloads).toBe(1);
    expect(prisma.execution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a", id: { in: ["eligible"] } }) }));
    expect(prisma.stepExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a" }) }));
  });

  it("rejects unsafe or unbounded requests", async () => {
    const service = new RetentionService({} as any);
    await expect(service.run({ ...options, organizationId: "" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.run({ ...options, batchSize: 1001 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.run({ ...options, metadataCutoff: new Date(Date.now() + 60_000) })).rejects.toBeInstanceOf(BadRequestException);
  });
});
