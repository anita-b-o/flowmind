import { ExecutionStatus } from "@automation/shared-types";
import { ExecutionReconcilerService, pendingDispatchGraceMs, recoveryJobId } from "./execution-reconciler.service";
import { ShutdownStateService } from "../runtime/shutdown-state.service";

describe("ExecutionReconcilerService trace propagation", () => {
  it("assigns a durable correlationId to historical queued executions before enqueueing", async () => {
    const state = { correlationId: null as string | null };
    let findManyCall = 0;
    const jobs: any[] = [];
    const prisma = {
      execution: {
        findMany: jest.fn(async () => {
          findManyCall += 1;
          if (findManyCall === 4) {
            return [
              {
                id: "execution-1",
                organizationId: "org-1",
                workflowId: "workflow-1",
                workflowVersionId: "version-1",
                status: ExecutionStatus.Queued,
                runAttempt: 3,
                correlationId: state.correlationId
              }
            ];
          }
          return [];
        }),
        updateMany: jest.fn(async ({ data }) => {
          state.correlationId ??= data.correlationId;
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn(async () => ({ correlationId: state.correlationId }))
      },
      stepExecution: { update: jest.fn() },
      approvalRequest: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn()
    };
    const queue = { close: jest.fn(), add: jest.fn(async (_name, data, opts) => jobs.push({ data, opts }) && { id: opts.jobId }) };
    const service = new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), queue as any, { info: jest.fn() } as any);

    await service.reconcile();

    expect(state.correlationId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(jobs[0].data).toMatchObject({ executionId: "execution-1", correlationId: state.correlationId });
    expect(jobs[0].data.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(jobs[0].opts.jobId).toBe("execution-execution-1-recovery-queued_job_recovered-run-3");
  });

  it("uses an ID distinct from the retained canonical BullMQ job", () => {
    expect(recoveryJobId("execution-1", "queued_job_recovered", 2)).toBe(
      "execution-execution-1-recovery-queued_job_recovered-run-2"
    );
    expect(recoveryJobId("execution-1", "queued_job_recovered", 2)).not.toBe("execution-execution-1");
  });

  it("recovers a stale pending dispatch with the canonical deterministic job ID", async () => {
    const jobs: any[] = [];
    const stale = {
      id: "execution-pending",
      organizationId: "org-1",
      workflowId: "workflow-1",
      workflowVersionId: "version-1",
      correlationId: "correlation-1"
    };
    const prisma = reconcilerPrisma((args: any) => args.where.status === ExecutionStatus.Pending ? [stale] : []);
    const queue = { close: jest.fn(), add: jest.fn(async (_name, data, opts) => jobs.push({ data, opts }) && { id: opts.jobId }) };
    const service = new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), queue as any, { info: jest.fn() } as any);

    await service.reconcile();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({ executionId: stale.id, organizationId: stale.organizationId });
    expect(jobs[0].opts.jobId).toBe("execution-execution-pending");
  });

  it("does not recover a pending dispatch inside the grace period", async () => {
    const prisma = reconcilerPrisma(() => []);
    const queue = { close: jest.fn(), add: jest.fn() };
    const service = new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), queue as any, { info: jest.fn() } as any);

    await service.reconcile();

    const pendingQuery = prisma.execution.findMany.mock.calls.find(([args]: any[]) => args.where.status === ExecutionStatus.Pending)?.[0];
    expect(pendingQuery.where.createdAt.lte.getTime()).toBeLessThanOrEqual(Date.now() - pendingDispatchGraceMs() + 50);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("concurrent pending recovery attempts retain one logical BullMQ job", async () => {
    const jobs = new Map<string, unknown>();
    const queue = {
      close: jest.fn(),
      add: jest.fn(async (_name, data, opts) => {
        if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data);
        return { id: opts.jobId };
      })
    };
    const pending = [{ id: "execution-race", organizationId: "org-1", workflowId: "workflow-1", workflowVersionId: "version-1", correlationId: "correlation-1" }];
    const first = new ExecutionReconcilerService(reconcilerPrisma((args: any) => args.where.status === ExecutionStatus.Pending ? pending : []) as any, new ShutdownStateService(), queue as any);
    const second = new ExecutionReconcilerService(reconcilerPrisma((args: any) => args.where.status === ExecutionStatus.Pending ? pending : []) as any, new ShutdownStateService(), queue as any);

    await Promise.all([first.reconcile(), second.reconcile()]);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(jobs.size).toBe(1);
    expect([...jobs.keys()]).toEqual(["execution-execution-race"]);
  });
});

function reconcilerPrisma(findExecutions: (args: any) => any[]) {
  return {
    execution: {
      findMany: jest.fn(async (args) => findExecutions(args)),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ correlationId: "correlation-1" }))
    },
    stepExecution: { update: jest.fn() },
    approvalRequest: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn()
  };
}
