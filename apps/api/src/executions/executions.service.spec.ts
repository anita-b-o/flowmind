import { NotFoundException } from "@nestjs/common";
import { ExecutionsService } from "./executions.service";

describe("ExecutionsService observability", () => {
  it("returns a cursor page without loading execution payloads", async () => {
    const createdAt = new Date("2026-07-18T12:00:00.000Z");
    const prisma: any = {
      execution: { findMany: jest.fn().mockResolvedValue([{ id: "e1", workflowId: "w1", workflowVersionId: "v1", correlationId: "c1", status: "FAILED", waitReason: null, executionMode: "REAL", startedAt: createdAt, completedAt: createdAt, createdAt, updatedAt: createdAt, runAttempt: 1, retryOfExecutionId: null, parentExecutionId: null, rootExecutionId: null, depth: 0, webhookEventId: "wh1", scheduledTriggerId: null, eventDeliveryId: null, manualExecutionKey: null, startedByUserId: null, workflow: { id: "w1", name: "Safe" }, workflowVersion: { id: "v1", versionNumber: 1 }, startedBy: null, _count: { steps: 1 } }]) },
      stepExecution: { groupBy: jest.fn().mockResolvedValue([{ executionId: "e1", status: "FAILED", _count: { _all: 1 } }]), findMany: jest.fn().mockResolvedValue([{ executionId: "e1", stepKey: "send", errorHandled: false, errorJson: { classification: "timeout", stack: "hidden" } }]) }
    };
    const result = await new ExecutionsService(prisma, {} as any).list("org-1", { limit: 20, page: 1, pageSize: 20 } as any);
    expect(result.items[0]).toMatchObject({ id: "e1", triggerType: "webhook", failedStep: { stepKey: "send", errorCategory: "timeout" } });
    expect(prisma.execution.findMany.mock.calls[0][0].select).not.toHaveProperty("inputJson");
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("returns 404 for a step outside the active organization", async () => {
    const prisma: any = { stepExecution: { findFirst: jest.fn().mockResolvedValue(null) } };
    await expect(new ExecutionsService(prisma, {} as any).stepDetail("org-a", "execution-a", "step-b")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.stepExecution.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a", executionId: "execution-a", id: "step-b" }) }));
  });

  it("never exposes raw step payloads or stacks", async () => {
    const prisma: any = { stepExecution: { findFirst: jest.fn().mockResolvedValue({ id: "s1", executionId: "e1", stepKey: "http", stepType: "http_request", status: "FAILED", attempt: 1, attemptCount: 1, maxAttempts: 1, executionPath: "root", iterationIndex: null, errorHandled: false, startedAt: null, completedAt: null, durationMs: null, nextRetryAt: null, effectStatus: "failed", inputJson: { arbitrary: "secret-canary" }, outputJson: { arbitrary: "secret-canary" }, errorJson: { classification: "timeout", message: "Timeout", stack: "secret-canary" }, debugJson: null, attempts: [] }) } };
    const result = await new ExecutionsService(prisma, {} as any).stepDetail("org", "e1", "s1") as any;
    expect(result).not.toHaveProperty("input");
    expect(result).not.toHaveProperty("output");
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(result.error).toEqual({ category: "timeout", code: "STEP_TIMEOUT", messageSafe: "Timeout" });
  });

  it("rejects an invalid opaque history cursor", async () => {
    const prisma: any = { execution: { findMany: jest.fn() } };
    await expect(new ExecutionsService(prisma, {} as any).list("org", { cursor: "not-a-cursor" } as any)).rejects.toThrow("Invalid execution cursor");
    expect(prisma.execution.findMany).not.toHaveBeenCalled();
  });

  it("uses the compound createdAt/id cursor without offset pagination", async () => {
    const timestamp = new Date("2026-07-19T12:00:00.000Z");
    const rows = [executionRow("e3", timestamp), executionRow("e2", timestamp), executionRow("e1", timestamp)];
    const prisma: any = {
      workflow: { findFirst: jest.fn() },
      execution: { findMany: jest.fn().mockResolvedValue(rows) },
      stepExecution: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) }
    };
    const first: any = await new ExecutionsService(prisma, {} as any).list("org", { limit: 2 } as any);
    expect(first.items.map((item: any) => item.id)).toEqual(["e3", "e2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    prisma.execution.findMany.mockResolvedValueOnce([executionRow("e1", timestamp)]);
    const second: any = await new ExecutionsService(prisma, {} as any).list("org", { limit: 2, cursor: first.nextCursor } as any);
    expect(second.items.map((item: any) => item.id)).toEqual(["e1"]);
    expect(prisma.execution.findMany.mock.calls[1][0]).not.toHaveProperty("skip");
    expect(prisma.execution.findMany.mock.calls[1][0].where).toEqual(expect.objectContaining({ AND: expect.any(Array) }));
  });

  it("orders equal-timestamp timeline events by type priority and keeps cursor pagination stable", async () => {
    const timestamp = new Date("2026-07-19T12:00:00.000Z");
    const execution = { ...executionRow("e1", timestamp), startedAt: timestamp, completedAt: timestamp, steps: [], approvalRequests: [{ id: "a1", requestedAt: timestamp, decidedAt: timestamp, status: "APPROVED", stepKey: "approve", executionPath: "root", iterationIndex: null }], childExecutions: [], deadLetters: [], eventDelivery: null };
    const prisma: any = { execution: { findFirst: jest.fn().mockResolvedValue(execution) }, internalEvent: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new ExecutionsService(prisma, {} as any);
    const first: any = await service.timeline("org", "e1", { limit: 3 } as any);
    expect(first.items.map((item: any) => item.type)).toEqual(["execution_created", "execution_started", "approval_requested"]);
    const second: any = await service.timeline("org", "e1", { limit: 3, cursor: first.nextCursor } as any);
    expect(second.items.map((item: any) => item.type)).toEqual(["approval_decided", "execution_completed"]);
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(5);
  });

  it("builds the persisted root/child/grandchild tree and scopes both queries to the organization", async () => {
    const timestamp = new Date("2026-07-19T12:00:00.000Z");
    const node = (id: string, parentExecutionId: string | null, depth: number) => ({ id, parentExecutionId, parentStepExecutionId: null, rootExecutionId: depth ? "root" : null, depth, workflowId: `w-${id}`, status: "COMPLETED", createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, workflow: { name: id }, parentStepExecution: null });
    const prisma: any = { execution: { findFirst: jest.fn().mockResolvedValue({ id: "child", rootExecutionId: "root" }), findMany: jest.fn().mockResolvedValue([node("root", null, 0), node("child", "root", 1), node("grandchild", "child", 2)]) } };
    const result: any = await new ExecutionsService(prisma, {} as any).tree("org-a", "child");
    expect(result.children[0].children[0]).toMatchObject({ id: "grandchild", depth: 2, status: "COMPLETED" });
    expect(prisma.execution.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a" }) }));
  });
});

function executionRow(id: string, createdAt: Date) {
  return { id, workflowId: "w1", workflowVersionId: "v1", correlationId: "c1", status: "COMPLETED", waitReason: null, executionMode: "REAL", startedAt: createdAt, completedAt: createdAt, createdAt, updatedAt: createdAt, runAttempt: 1, retryOfExecutionId: null, parentExecutionId: null, rootExecutionId: null, depth: 0, webhookEventId: null, scheduledTriggerId: null, eventDeliveryId: null, manualExecutionKey: "manual", startedByUserId: null, workflow: { id: "w1", name: "Safe" }, workflowVersion: { id: "v1", versionNumber: 1 }, startedBy: null, _count: { steps: 0 } };
}
