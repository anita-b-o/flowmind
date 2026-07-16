import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import { Job } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { newTraceId, traceIdOrNew } from "@automation/observability";

export type JobContext = {
  requestId: string;
  parentRequestId: string;
  correlationId: string;
  jobId?: string;
  organizationId: string;
  workflowId: string;
  workflowVersionId: string;
  executionId: string;
  workerId: string;
};

@Injectable()
export class JobContextService {
  private readonly storage = new AsyncLocalStorage<JobContext>();

  create(job: Job<ExecutionJobPayload>, workerId: string): JobContext {
    return {
      requestId: newTraceId(),
      parentRequestId: traceIdOrNew(job.data.requestId),
      correlationId: traceIdOrNew(job.data.correlationId),
      jobId: job.id,
      organizationId: job.data.organizationId,
      workflowId: job.data.workflowId,
      workflowVersionId: job.data.workflowVersionId,
      executionId: job.data.executionId,
      workerId
    };
  }

  run<T>(context: JobContext, callback: () => T) {
    return this.storage.run(context, callback);
  }

  getContext() {
    return this.storage.getStore();
  }

  getRequestId() {
    return this.storage.getStore()?.requestId ?? newTraceId();
  }

  getCorrelationId() {
    return this.storage.getStore()?.correlationId ?? newTraceId();
  }
}
