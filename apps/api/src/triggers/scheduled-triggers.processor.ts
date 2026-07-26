import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { SCHEDULED_TRIGGER_RUN_JOB, SCHEDULED_TRIGGERS_QUEUE } from "../queues/queue.constants";
import { ScheduledTriggersService } from "./scheduled-triggers.service";

type ScheduledTriggerJobPayload = {
  organizationId: string;
  triggerId: string;
};

@Processor(SCHEDULED_TRIGGERS_QUEUE, {
  concurrency: 1,
  drainDelay: drainDelaySeconds()
})
export class ScheduledTriggersProcessor extends WorkerHost {
  constructor(private readonly scheduledTriggers: ScheduledTriggersService) {
    super();
  }

  async process(job: Job<ScheduledTriggerJobPayload>) {
    if (job.name !== SCHEDULED_TRIGGER_RUN_JOB) {
      return undefined;
    }
    return this.scheduledTriggers.runDue(job.data.triggerId, job.data.organizationId);
  }

  isRunning() {
    return Boolean(this.worker);
  }
}

function drainDelaySeconds() {
  const value = Number(process.env.BULLMQ_DRAIN_DELAY_SECONDS ?? 5);
  return Number.isInteger(value) && value >= 1 && value <= 300 ? value : 5;
}
