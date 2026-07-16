import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";
import { ExecutionsProcessor } from "./queues/executions.processor";
import { WORKFLOW_EXECUTIONS_QUEUE } from "./queues/queue.constants";
import { WORKFLOW_EXECUTIONS_DLQ } from "./queues/queue.constants";
import { WorkflowRunner } from "./engine/workflow-runner";
import { StepExecutor } from "./engine/step-executor";
import { StepRegistry } from "./engine/step-registry";
import { ExpressionResolver } from "./engine/expression-resolver";
import { HttpRequestHandler } from "./engine/handlers/http-request.handler";
import { ConditionalHandler } from "./engine/handlers/conditional.handler";
import { DatabaseRecordHandler } from "./engine/handlers/database-record.handler";
import { AiHandler } from "./engine/handlers/ai.handler";
import { EmailNotificationHandler } from "./engine/handlers/email-notification.handler";
import { SafeHttpClient } from "./http/safe-http-client";
import { ErrorClassifier } from "./engine/error-classifier";
import { RetryPolicyResolver } from "./engine/retry-policy-resolver";
import { ContextReconstructor } from "./engine/context-reconstructor";
import { WorkerIdentityService } from "./runtime/worker-identity.service";
import { ShutdownStateService } from "./runtime/shutdown-state.service";
import { ExecutionLeaseService } from "./engine/execution-lease.service";
import { DeadLetterService } from "./dlq/dead-letter.service";
import { ExecutionReconcilerService } from "./recovery/execution-reconciler.service";
import { WorkerHealthService } from "./health/worker-health.service";
import { JobContextService } from "./observability/job-context.service";
import { WorkerLoggerService } from "./observability/worker-logger.service";
import { WorkerMetricsService } from "./metrics/worker-metrics.service";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379)
      }
    }),
    BullModule.registerQueue({ name: WORKFLOW_EXECUTIONS_QUEUE }, { name: WORKFLOW_EXECUTIONS_DLQ })
  ],
  providers: [
    PrismaService,
    ExecutionsProcessor,
    WorkflowRunner,
    StepExecutor,
    StepRegistry,
    ExpressionResolver,
    ErrorClassifier,
    RetryPolicyResolver,
    ContextReconstructor,
    WorkerIdentityService,
    ShutdownStateService,
    ExecutionLeaseService,
    DeadLetterService,
    ExecutionReconcilerService,
    WorkerHealthService,
    JobContextService,
    WorkerLoggerService,
    WorkerMetricsService,
    SafeHttpClient,
    HttpRequestHandler,
    ConditionalHandler,
    DatabaseRecordHandler,
    AiHandler,
    EmailNotificationHandler
  ]
})
export class WorkerModule {}
