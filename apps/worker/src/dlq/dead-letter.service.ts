import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { WORKFLOW_EXECUTIONS_DLQ } from "../queues/queue.constants";
import { WorkerLoggerService } from "../observability/worker-logger.service";
import { WorkerMetricsService, dlqReasonCode } from "../metrics/worker-metrics.service";

export type DeadLetterInput = {
  organizationId: string;
  executionId: string;
  workflowId: string;
  workflowVersionId: string;
  reason: string;
  failedStepKey?: string;
  failedStepExecutionId?: string;
  attempts?: number;
  lastErrorJson?: unknown;
  jobId?: string;
};

@Injectable()
export class DeadLetterService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_EXECUTIONS_DLQ) private readonly dlq: Queue,
    private readonly logger?: WorkerLoggerService,
    private readonly metrics?: WorkerMetricsService
  ) {}

  async create(input: DeadLetterInput) {
    const existing = await this.prisma.deadLetterExecution.findFirst({
      where: { executionId: input.executionId, resolvedAt: null }
    });
    const row = existing ?? (await this.prisma.deadLetterExecution.create({
      data: {
        organizationId: input.organizationId,
        executionId: input.executionId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        sourceQueue: "workflow-executions",
        reason: input.reason,
        failedStepKey: input.failedStepKey,
        failedStepExecutionId: input.failedStepExecutionId,
        attempts: input.attempts ?? 0,
        lastErrorJson: toJson(input.lastErrorJson ?? {}),
        jobId: input.jobId
      }
    }).catch(async () => {
      const raced = await this.prisma.deadLetterExecution.findFirst({
        where: { executionId: input.executionId, resolvedAt: null }
      });
      if (raced) return raced;
      throw new Error("Failed to create dead letter execution");
    }));

    this.metrics?.dlqEntries.inc({ reason_code: dlqReasonCode(row.reason), outcome: existing ? "existing" : "created" });
    await this.publish(row.id).catch((error) => {
      this.metrics?.dlqPublishFailures.inc({ reason_code: dlqReasonCode(row.reason) });
      this.logger?.warn("worker.execution.dead_letter_publish_failed", {
        deadLetterId: row.id,
        executionId: row.executionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return row;
  }

  async publish(deadLetterId: string) {
    const row = await this.prisma.deadLetterExecution.findUnique({ where: { id: deadLetterId } });
    if (!row) return;
    await this.dlq.add(
      "dead-letter.execution",
      {
        deadLetterId: row.id,
        organizationId: row.organizationId,
        executionId: row.executionId,
        workflowId: row.workflowId,
        workflowVersionId: row.workflowVersionId,
        reason: row.reason,
        failedStepKey: row.failedStepKey
      },
      { jobId: `dead-letter-${row.id}`, attempts: 1, removeOnComplete: 1000, removeOnFail: false }
    );
    this.metrics?.dlqEntries.inc({ reason_code: dlqReasonCode(row.reason), outcome: "publish_succeeded" });
  }

  async onModuleDestroy() {
    await this.dlq.close().catch(() => undefined);
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
