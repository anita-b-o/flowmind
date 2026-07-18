import { StepType } from "@automation/shared-types";
import { ApprovalHandler } from "./approval.handler";

describe("ApprovalHandler", () => {
  const context: any = { metadata: { runtime: { organizationId: "org", executionId: "execution", stepExecutionId: "step-execution", executionPath: "for_each:loop:0", iterationIndex: 0 } } };
  const step: any = { key: "approve", name: "Approve", type: StepType.Approval, position: 1, config: { title: "Review", allowedRoles: ["editor"] } };

  it("creates one durable pending request and returns a worker-free wait", async () => {
    const created: any[] = [];
    const prisma: any = { approvalRequest: { findUnique: jest.fn(async () => null) }, execution: { findFirstOrThrow: jest.fn(async () => ({ workflowId: "workflow", workflowVersionId: "version", correlationId: "correlation" })) }, $transaction: jest.fn(async (callback: any) => callback({ approvalRequest: { upsert: jest.fn(async ({ create }: any) => { created.push(create); return { id: "approval" }; }) }, auditLog: { create: jest.fn() } })) };
    const result = await new ApprovalHandler(prisma).execute(step, context);
    expect(result.control).toEqual({ waitReason: "approval", durableWait: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ stepExecutionId: "step-execution", executionPath: "for_each:loop:0", iterationIndex: 0, title: "Review" });
  });

  it("turns a terminal request into compact business output", async () => {
    const prisma: any = { approvalRequest: { findUnique: jest.fn(async () => ({ status: "REJECTED", decidedAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date(), decidedByUserId: "user" })) } };
    const result = await new ApprovalHandler(prisma).execute(step, context);
    expect(result.output).toEqual({ decision: "rejected", decidedAt: "2026-01-01T00:00:00.000Z", decidedByUserId: "user" });
  });
});
