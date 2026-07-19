import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { StepExecutor } from "./step-executor";

describe("StepExecutor durable attempts", () => {
  it("persists retryable attempt 1 followed by successful attempt 2", async () => {
    const attempts = new Map<number, any>();
    const updates: any[] = [];
    const prisma: any = {
      stepExecution: { update: jest.fn(async ({ data }) => { updates.push(data); return data; }) },
      stepExecutionAttempt: { upsert: jest.fn(async ({ where, create, update }) => { const number = where.stepExecutionId_attempt.attempt; attempts.set(number, { ...(attempts.get(number) ?? create), ...update }); return attempts.get(number); }) },
      auditLog: { create: jest.fn() }
    };
    const handler = { execute: jest.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ status: StepExecutionStatus.Completed, output: { ok: true } }) };
    const service = new StepExecutor(prisma, { get: () => handler } as any, { classify: () => "retryable" } as any, { resolve: () => ({ maxAttempts: 2, timeoutSeconds: 30 }), nextRetryAt: () => new Date("2026-07-19T12:01:00Z") } as any);
    const base = { organizationId: "org", executionId: "execution", step: { key: "call", name: "Call", type: StepType.HttpRequest, position: 1, config: {} }, context: { metadata: {} }, executionPath: "root" } as any;

    await expect(service.execute({ ...base, stepExecution: row(0) })).resolves.toMatchObject({ outcome: "retrying" });
    await expect(service.execute({ ...base, stepExecution: row(1) })).resolves.toMatchObject({ outcome: "completed" });

    expect([...attempts.keys()]).toEqual([1, 2]);
    expect(attempts.get(1)).toMatchObject({ status: StepExecutionStatus.Retrying, errorCategory: "retryable", errorCodeSafe: "STEP_RETRYABLE_FAILURE", waitReason: "retry_backoff" });
    expect(attempts.get(2)).toMatchObject({ status: StepExecutionStatus.Completed, effectStatus: "succeeded" });
    expect(attempts.get(1).startedAt).toBeInstanceOf(Date);
    expect(attempts.get(1).completedAt).toBeInstanceOf(Date);
  });

  it("persists one terminal non-retryable failure", async () => {
    const upsert = jest.fn(async ({ create }) => create);
    const prisma: any = { stepExecution: { update: jest.fn() }, stepExecutionAttempt: { upsert }, auditLog: { create: jest.fn() } };
    const service = new StepExecutor(prisma, { get: () => ({ execute: async () => { throw new Error("bad input"); } }) } as any, { classify: () => "non_retryable" } as any, { resolve: () => ({ maxAttempts: 3, timeoutSeconds: 30 }), nextRetryAt: jest.fn() } as any);
    await expect(service.execute({ organizationId: "org", executionId: "execution", step: { key: "validate", name: "Validate", type: StepType.Transform, position: 1, config: {} }, context: { metadata: {} }, stepExecution: row(0) } as any)).rejects.toThrow("bad input");
    const terminal = upsert.mock.calls.map(([arg]) => arg.create).find((item) => item.status === StepExecutionStatus.Failed);
    expect(terminal).toMatchObject({ attempt: 1, errorCategory: "non_retryable", errorCodeSafe: "STEP_FAILED" });
    expect(upsert.mock.calls.filter(([arg]) => arg.create.status === StepExecutionStatus.Failed)).toHaveLength(1);
  });

  it("resumes an approval without incrementing or creating a false attempt", async () => {
    const upsert = jest.fn(async ({ create }) => create);
    const prisma: any = { stepExecution: { update: jest.fn() }, stepExecutionAttempt: { upsert }, auditLog: { create: jest.fn() } };
    const service = new StepExecutor(prisma, { get: () => ({ execute: async () => ({ status: StepExecutionStatus.Completed, output: { decision: "APPROVED" } }) }) } as any, { classify: () => "non_retryable" } as any, { resolve: () => ({ maxAttempts: 1, timeoutSeconds: 30 }) } as any);
    await service.execute({ organizationId: "org", executionId: "execution", step: { key: "approval", name: "Approval", type: StepType.Approval, position: 1, config: {} }, context: { metadata: {} }, stepExecution: { ...row(1), effectStatus: "approval_waiting" } } as any);
    expect(new Set(upsert.mock.calls.map(([arg]) => arg.create.attempt))).toEqual(new Set([1]));
  });
});

function row(attemptCount: number) {
  return { id: "step", attemptCount, maxAttempts: 2, status: StepExecutionStatus.Pending, nextRetryAt: null, effectKey: "effect", effectStatus: null, outputJson: null, executionPath: "root", iterationIndex: null };
}
