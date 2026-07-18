import { Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { ExecutionJobPayload } from "@automation/shared-types";
import { WorkflowRunner } from "../engine/workflow-runner";
import { EXECUTION_RUN_JOB, WORKFLOW_EXECUTIONS_QUEUE } from "./queue.constants";
import { ShutdownStateService } from "../runtime/shutdown-state.service";
import { JobContextService } from "../observability/job-context.service";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerIdentityService } from "../runtime/worker-identity.service";
import { newTraceId } from "@automation/observability";
import { WorkerMetricsService } from "../metrics/worker-metrics.service";

@Processor(WORKFLOW_EXECUTIONS_QUEUE)
export class ExecutionsProcessor extends WorkerHost {
  private shutdownStarted = false;

  constructor(
    private readonly runner: WorkflowRunner,
    private readonly shutdown: ShutdownStateService,
    @InjectQueue(WORKFLOW_EXECUTIONS_QUEUE) private readonly queue: Queue<ExecutionJobPayload>,
    private readonly jobContext: JobContextService,
    private readonly logger: WorkerLoggerService,
    private readonly identity: WorkerIdentityService,
    private readonly metrics: WorkerMetricsService
  ) {
    super();
  }

  async process(job: Job<ExecutionJobPayload>) {
    if (this.shutdown.isShuttingDown()) {
      return;
    }
    this.metrics.jobsReceived.inc({ queue: WORKFLOW_EXECUTIONS_QUEUE });
    if (job.data.origin) this.metrics.executionQueueLatency.observe({ origin: job.data.origin }, Math.max(0, (Date.now() - Date.parse(job.data.enqueuedAt)) / 1000));
    this.metrics.activeJobs.inc({ queue: WORKFLOW_EXECUTIONS_QUEUE });
    return this.jobContext.run(this.jobContext.create(job, this.identity.id), async () => {
      try {
        this.logger.info("worker.job.received", { jobId: job.id });
        const result = await this.runner.run(job.data);
        if (result.status === "waiting" && result.nextRetryAt) {
          await this.queue.add(
            EXECUTION_RUN_JOB,
            { ...job.data, requestId: newTraceId(), enqueuedAt: new Date().toISOString() },
            {
              jobId: `execution-${job.data.executionId}-retry-${result.nextRetryAt.getTime()}`,
              delay: Math.max(0, result.nextRetryAt.getTime() - Date.now()),
              attempts: 1,
              removeOnComplete: 1000,
              removeOnFail: false
            }
          );
        }
      } finally {
        this.metrics.activeJobs.dec({ queue: WORKFLOW_EXECUTIONS_QUEUE });
      }
    });
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
    this.logger.info("worker.shutdown.started");
    await this.worker?.pause();
    await withTimeout(this.worker?.close(false) ?? Promise.resolve(), Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 30_000));
    await this.queue.close().catch(() => undefined);
    this.logger.info("worker.shutdown.completed");
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
