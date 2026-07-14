import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";
import { ExecutionsProcessor } from "./queues/executions.processor";
import { WORKFLOW_EXECUTIONS_QUEUE } from "./queues/queue.constants";
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

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379)
      }
    }),
    BullModule.registerQueue({ name: WORKFLOW_EXECUTIONS_QUEUE })
  ],
  providers: [
    PrismaService,
    ExecutionsProcessor,
    WorkflowRunner,
    StepExecutor,
    StepRegistry,
    ExpressionResolver,
    SafeHttpClient,
    HttpRequestHandler,
    ConditionalHandler,
    DatabaseRecordHandler,
    AiHandler,
    EmailNotificationHandler
  ]
})
export class WorkerModule {}
