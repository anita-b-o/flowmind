import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { StepType } from "@automation/shared-types";
import { WorkflowTestRunsService } from "./workflow-test-runs.service";

const definition = {
  trigger: { key: "webhook", name: "Webhook", type: StepType.WebhookTrigger, position: 0, config: {} },
  steps: [{ key: "call_api", name: "Call API", type: StepType.HttpRequest, position: 1, config: { url: "https://example.test" } }]
};

describe("WorkflowTestRunsService", () => {
  function service(overrides: Record<string, unknown> = {}) {
    const prisma = {
      organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: "admin" }) },
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: "workflow-1", activeVersionId: "version-1", versions: [{ id: "version-1" }] }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: "version-1", definitionJson: definition }) },
      $transaction: jest.fn(async (callback) =>
        callback({
          execution: {
            create: jest.fn().mockResolvedValue({
              id: "execution-1",
              correlationId: "correlation-1"
            })
          },
          workflowTestRun: {
            create: jest.fn().mockResolvedValue({ id: "test-run-1" })
          }
        })
      ),
      workflowTestRun: {
        findFirst: jest.fn().mockResolvedValue({
          id: "test-run-1",
          workflowId: "workflow-1",
          workflowVersionId: "version-1",
          executionId: "execution-1",
          externalMode: "mock",
          source: "version",
          payloadJson: {},
          stepMocksJson: {},
          snapshotDefinitionJson: definition,
          compareWithLastReal: false,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          createdBy: { id: "user-1", email: "ada@example.com", name: "Ada" },
          execution: {
            id: "execution-1",
            status: "QUEUED",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            startedAt: null,
            completedAt: null,
            deadLetters: [],
            steps: []
          }
        })
      },
      ...overrides
    } as any;
    const queue = { enqueueExecution: jest.fn().mockResolvedValue(undefined) };
    return { prisma, queue, service: new WorkflowTestRunsService(prisma, queue as any) };
  }

  it("rejects real mode without explicit confirmation", async () => {
    const { service: subject } = service();
    await expect(
      subject.create("org-1", "user-1", "workflow-1", {
        payload: { trigger: {} },
        externalMode: "real"
      } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects real mode for non-admin users", async () => {
    const { service: subject } = service({
      organizationMember: { findFirst: jest.fn().mockResolvedValue({ role: "editor" }) }
    });
    await expect(
      subject.create("org-1", "user-1", "workflow-1", {
        payload: { trigger: {} },
        externalMode: "real",
        realModeConfirmed: true
      } as any)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("creates mock test runs with a persisted snapshot", async () => {
    const { prisma, queue, service: subject } = service();
    const detail = await subject.create("org-1", "user-1", "workflow-1", {
      payload: { trigger: { body: { ok: true } } },
      externalMode: "mock"
    } as any);

    const tx = await prisma.$transaction.mock.results[0].value;
    expect(tx).toBeDefined();
    expect(queue.enqueueExecution).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "TEST", testRunId: "test-run-1" }));
    expect(detail.sideEffectNodes).toEqual([{ key: "call_api", name: "Call API", type: StepType.HttpRequest, realModeAllowed: true }]);
  });
});
