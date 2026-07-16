import { JobContextService } from "./job-context.service";

describe("JobContextService", () => {
  it("isolates concurrent jobs and generates a worker requestId", async () => {
    const service = new JobContextService();
    const jobA = job("job-a", "parent-a", "correlation-a");
    const jobB = job("job-b", "parent-b", "correlation-b");

    const [a, b] = await Promise.all([
      service.run(service.create(jobA as any, "worker-1"), async () => {
        await delay(20);
        return service.getContext();
      }),
      service.run(service.create(jobB as any, "worker-1"), async () => {
        await delay(5);
        return service.getContext();
      })
    ]);

    expect(a?.requestId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(a?.requestId).not.toBe("parent-a");
    expect(a).toMatchObject({ parentRequestId: "parent-a", correlationId: "correlation-a", executionId: "execution-job-a" });
    expect(b).toMatchObject({ parentRequestId: "parent-b", correlationId: "correlation-b", executionId: "execution-job-b" });
  });
});

function job(id: string, requestId: string, correlationId: string) {
  return {
    id,
    data: {
      organizationId: `org-${id}`,
      executionId: `execution-${id}`,
      workflowId: `workflow-${id}`,
      workflowVersionId: `version-${id}`,
      requestId,
      correlationId,
      enqueuedAt: new Date().toISOString()
    }
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
