import { Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { WorkflowRunner } from "../engine/workflow-runner";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";
import { ShutdownStateService } from "../runtime/shutdown-state.service";

@Processor(WORKFLOW_EXECUTIONS_QUEUE)
export class ExecutionsProcessor extends WorkerHost {
  private shutdownStarted = false;

  constructor(
    private readonly runner: WorkflowRunner,
    private readonly shutdown: ShutdownStateService,
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue<ExecutionJobPayload>
  ) {
    super();
  }

  async process(job: Job<ExecutionJobPayload>) {
    if (this.shutdown.isShuttingDown()) {
      return;
    }
    const result = await this.runner.run(job.data);
    if (result.status === "waiting") {
      await this.queue.add(EXECUTION_RUN_JOB, job.data, {
        jobId: `execution-${job.data.executionId}-retry-${result.nextRetryAt.getTime()}`,
        delay: Math.max(0, result.nextRetryAt.getTime() - Date.now()),
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: false
      });
    }
  }

  async onApplicationShutdown() {
    await this.closeWorker();
  }

  async onModuleDestroy() {
    await this.closeWorker();
  }

  private async closeWorker() {
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;
    this.shutdown.beginShutdown();
    await this.worker?.pause();
    await withTimeout(this.worker?.close(false) ?? Promise.resolve(), Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 30_000));
    await this.queue.close().catch(() => undefined);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(undefined as T), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
