import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";

@Injectable()
export class QueueService {
  constructor(@InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly executionsQueue: Queue) {}

  enqueueExecution(payload: ExecutionJobPayload) {
    return this.executionsQueue.add(EXECUTION_RUN_JOB, payload, {
      jobId: `execution-${payload.executionId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false
    });
  }
}
