import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { EXECUTION_RUN_JOB, SCHEDULED_TRIGGER_RUN_JOB, SCHEDULED_TRIGGERS_QUEUE, WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly executionsQueue: Queue,
    @InjectQueue(SCHEDULED_TRIGGERS_QUEUE) private readonly scheduledTriggersQueue: Queue
  ) {}

  enqueueExecution(payload: ExecutionJobPayload, jobId = `execution-${payload.executionId}`) {
    return this.executionsQueue.add(EXECUTION_RUN_JOB, payload, {
      jobId,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: false
    });
  }

  upsertScheduledTriggerScheduler(input: { triggerId: string; organizationId: string; cronPattern: string; timezone: string }) {
    return (this.scheduledTriggersQueue as any).upsertJobScheduler(
      scheduledTriggerSchedulerId(input.triggerId),
      { pattern: input.cronPattern, tz: input.timezone },
      {
        name: SCHEDULED_TRIGGER_RUN_JOB,
        data: { triggerId: input.triggerId, organizationId: input.organizationId },
        opts: {
          attempts: 1,
          removeOnComplete: 1000,
          removeOnFail: false
        }
      }
    );
  }

  removeScheduledTriggerScheduler(triggerId: string) {
    return (this.scheduledTriggersQueue as any).removeJobScheduler(scheduledTriggerSchedulerId(triggerId));
  }
}

export function scheduledTriggerSchedulerId(triggerId: string) {
  return `scheduled-trigger:${triggerId}`;
}
