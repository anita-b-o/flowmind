import { Prisma } from "@prisma/client";
import { StepExecutionStatus, StepType } from "@automation/shared-types";
import { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ApprovalHandler } from "./handlers/approval.handler";
import { TryCatchExecutionService } from "./try-catch-execution.service";

describe("APPROVAL technical failure in TRY_CATCH", () => {
  it("captures a real persistence-client failure, sanitizes it, and marks the approval error handled", async () => {
    const rows = new Map<string, any>();
    const guard = row("guard-execution", "guard", "try_catch", "root");
    rows.set(guard.id, guard);
    const persistenceFailure = new Prisma.PrismaClientKnownRequestError(
      "Cannot reach postgresql://flowmind:super-secret@db.internal/flowmind authorization=Bearer.hidden-token",
      { code: "P1001", clientVersion: "6.19.3" }
    );
    const upsert = jest.fn();
    const handler = new ApprovalHandler({ approvalRequest: { findUnique: jest.fn().mockRejectedValue(persistenceFailure), upsert } } as any);
    let catchFrame: any;
    const prisma = fakePrisma(rows);
    const executor = {
      ensure: async ({ step, executionPath }: any) => {
        const existing = [...rows.values()].find((item) => item.stepKey === step.key && item.executionPath === executionPath);
        if (existing) return existing;
        const created = row(`${executionPath}:${step.key}`, step.key, step.type, executionPath);
        rows.set(created.id, created);
        return created;
      },
      execute: async ({ step, context, stepExecution }: any) => {
        if (step.type === StepType.Approval) {
          context.metadata = { runtime: { organizationId: "org", executionId: "execution", stepExecutionId: stepExecution.id, executionPath: stepExecution.executionPath } };
          try {
            await handler.execute(step, context);
          } catch (error) {
            Object.assign(stepExecution, { status: StepExecutionStatus.Failed, attemptCount: 1, effectStatus: "failed", errorJson: { message: "[REDACTED_CONNECTION] authorization=Bearer [REDACTED]", classification: "non_retryable", code: (error as any).code } });
            throw error;
          }
        }
        if (step.key === "caught") catchFrame = context.error;
        Object.assign(stepExecution, { status: StepExecutionStatus.Completed, attemptCount: 1, effectStatus: "succeeded", outputJson: { caught: true } });
        return { outcome: "completed", result: { status: StepExecutionStatus.Completed, output: { caught: true } } };
      },
      completeWait: jest.fn(),
      skip: jest.fn()
    };
    const service = new TryCatchExecutionService(prisma as any, executor as any, {} as any);
    const runtimeContext = new ExecutionRuntimeContext({ trigger: {}, steps: {}, variables: {}, metadata: {}, workflow: { variables: {} }, execution: {} });
    const result = await service.execute({
      organizationId: "org", executionId: "execution", tryStep: { key: "guard", name: "Guard", type: StepType.TryCatch, position: 1, config: {} }, tryStepExecution: guard,
      graph: { entryStepKey: "guard", edges: [
        { from: "guard", to: "approval", kind: "try_body" }, { from: "guard", to: "caught", kind: "try_catch" }, { from: "guard", to: "cleanup", kind: "try_finally" }, { from: "guard", to: "done", kind: "try_done" },
        { from: "approval", to: "cleanup", kind: "next" }, { from: "caught", to: "cleanup", kind: "next" }, { from: "cleanup", to: "done", kind: "next" }
      ] },
      stepRowsByKey: new Map([
        ["approval", stepRow("approval", StepType.Approval, { title: "Review", allowedRoles: ["editor"] })],
        ["caught", stepRow("caught", StepType.SetVariable)], ["cleanup", stepRow("cleanup", StepType.SetVariable)], ["done", stepRow("done", StepType.SetVariable)]
      ]), runtimeContext, parentContext: runtimeContext.context, parentPath: "root"
    });
    expect(result).toMatchObject({ outcome: "completed", output: { status: "handled", bodyStatus: "failed", catchStatus: "succeeded", errorHandled: true, failedStepKey: "approval" } });
    const approval = [...rows.values()].find((item) => item.stepKey === "approval");
    expect(approval).toMatchObject({ status: StepExecutionStatus.Failed, errorHandled: true });
    expect(JSON.stringify(catchFrame)).toContain("[REDACTED_CONNECTION]");
    expect(JSON.stringify(catchFrame)).not.toMatch(/super-secret|hidden-token|postgresql:\/\//i);
    expect(upsert).not.toHaveBeenCalled();
  });
});

function row(id: string, stepKey: string, stepType: string, executionPath: string) { return { id, stepKey, stepType, executionPath, iterationIndex: null, status: StepExecutionStatus.Pending, attemptCount: 0, maxAttempts: 1, effectKey: `effect:${executionPath}:${stepKey}`, effectStatus: null, inputJson: {}, outputJson: null, errorJson: null, errorHandled: false, createdAt: new Date(), updatedAt: new Date() }; }
function stepRow(key: string, type: string, configJson: Record<string, unknown> = {}) { return { id: `definition-${key}`, key, name: key, type, position: 2, configJson, retryPolicyJson: null, timeoutSeconds: 30 }; }
function fakePrisma(rows: Map<string, any>) { return { stepExecution: {
  update: async ({ where, data }: any) => { const current = rows.get(where.id); Object.assign(current, data, { updatedAt: new Date() }); return current; },
  findMany: async ({ where }: any) => [...rows.values()].filter((item) => item.executionPath === where.executionPath),
  findUniqueOrThrow: async ({ where }: any) => rows.get(where.id),
  findFirst: async ({ where }: any) => [...rows.values()].filter((item) => item.status === where.status && item.errorHandled === where.errorHandled).at(-1)
}, auditLog: { create: async () => ({}) } }; }
