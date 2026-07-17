import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { QueuesModule } from "../queues/queues.module";
import { SecretsModule } from "../secrets/secrets.module";
import { TriggersModule } from "../triggers/triggers.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhookRateLimitService } from "./webhook-rate-limit.service";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [AuditLogsModule, QueuesModule, SecretsModule, TriggersModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookRateLimitService]
})
export class WebhooksModule {}
