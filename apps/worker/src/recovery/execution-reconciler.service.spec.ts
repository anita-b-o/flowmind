import { ExecutionStatus } from "@automation/shared-types";
import { ExecutionReconcilerService } from "./execution-reconciler.service";
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
          if (findManyCall === 3) {
            return [
              {
                id: "execution-1",
                organizationId: "org-1",
                workflowId: "workflow-1",
                workflowVersionId: "version-1",
                status: ExecutionStatus.Queued,
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
      stepExecution: { update: jest.fn() }
    };
    const queue = { close: jest.fn(), add: jest.fn(async (_name, data, opts) => jobs.push({ data, opts }) && { id: opts.jobId }) };
    const service = new ExecutionReconcilerService(prisma as any, new ShutdownStateService(), queue as any, { info: jest.fn() } as any);

    await service.reconcile();

    expect(state.correlationId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(jobs[0].data).toMatchObject({ executionId: "execution-1", correlationId: state.correlationId });
    expect(jobs[0].data.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(jobs[0].opts.jobId).toBe("execution-execution-1");
  });
});
