import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { AuditLogsModule } from "./audit-logs/audit-logs.module";
import { ExecutionsModule } from "./executions/executions.module";
import { DeadLetterExecutionsModule } from "./dead-letter/dead-letter-executions.module";
import { HealthModule } from "./health/health.module";
import { ObservabilityModule } from "./observability/observability.module";
import { MetricsModule } from "./metrics/metrics.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueuesModule } from "./queues/queues.module";
import { TriggersModule } from "./triggers/triggers.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WorkflowsModule } from "./workflows/workflows.module";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379)
      }
    }),
    ObservabilityModule,
    MetricsModule,
    PrismaModule,
    HealthModule,
    AuditLogsModule,
    AuthModule,
    OrganizationsModule,
    WorkflowsModule,
    TriggersModule,
    ExecutionsModule,
    DeadLetterExecutionsModule,
    QueuesModule,
    WebhooksModule
  ]
})
export class AppModule {}
