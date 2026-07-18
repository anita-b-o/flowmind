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
import { IfHandler } from "./engine/handlers/if.handler";
import { SwitchHandler } from "./engine/handlers/switch.handler";
import { DelayHandler } from "./engine/handlers/delay.handler";
import { WaitUntilHandler } from "./engine/handlers/wait-until.handler";
import { TransformHandler } from "./engine/handlers/transform.handler";
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
import { ConnectionResolver } from "./connections/connection-resolver";
import { ConnectionCryptoService } from "./connections/connection-crypto.service";
import { TestRuntimePolicy } from "./engine/test-runtime-policy";
import { DebugArtifactRecorder } from "./engine/debug-artifact-recorder";
import { DataStoreRuntimeService } from "./data-store/data-store-runtime.service";
import { DataStoreGetRecordHandler } from "./engine/handlers/data-store/get-record.handler";
import { DataStoreUpsertRecordHandler } from "./engine/handlers/data-store/upsert-record.handler";
import { DataStoreDeleteRecordHandler } from "./engine/handlers/data-store/delete-record.handler";
import { DataStoreExistsRecordHandler } from "./engine/handlers/data-store/exists-record.handler";
import { DataStoreCountRecordsHandler } from "./engine/handlers/data-store/count-records.handler";
import { DataStoreListRecordsHandler } from "./engine/handlers/data-store/list-records.handler";
import { AppendVariableHandler, DeleteVariableHandler, GetVariableHandler, IncrementVariableHandler, SetVariableHandler } from "./engine/handlers/variables.handler";

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
    TestRuntimePolicy,
    DebugArtifactRecorder,
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
    DataStoreRuntimeService,
    ConnectionCryptoService,
    ConnectionResolver,
    SafeHttpClient,
    HttpRequestHandler,
    ConditionalHandler,
    IfHandler,
    SwitchHandler,
    DelayHandler,
    WaitUntilHandler,
    TransformHandler,
    DatabaseRecordHandler,
    DataStoreGetRecordHandler,
    DataStoreUpsertRecordHandler,
    DataStoreDeleteRecordHandler,
    DataStoreExistsRecordHandler,
    DataStoreCountRecordsHandler,
    DataStoreListRecordsHandler,
    SetVariableHandler,
    GetVariableHandler,
    DeleteVariableHandler,
    IncrementVariableHandler,
    AppendVariableHandler,
    AiHandler,
    EmailNotificationHandler
  ]
})
export class WorkerModule {}
