import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { WorkflowRunner } from "../engine/workflow-runner";
import { WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";

@Processor(WORKFLOW_EXECUTIONS_QUEUE)
export class ExecutionsProcessor extends WorkerHost {
  constructor(private readonly runner: WorkflowRunner) {
    super();
  }

  async process(job: Job<ExecutionJobPayload>) {
    await this.runner.run(job.data);
  }
}
