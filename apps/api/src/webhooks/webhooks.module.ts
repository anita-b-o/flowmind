import { Module } from "@nestjs/common";
import { QueuesModule } from "../queues/queues.module";
import { TriggersModule } from "../triggers/triggers.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhookRateLimitService } from "./webhook-rate-limit.service";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [QueuesModule, TriggersModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookRateLimitService]
})
export class WebhooksModule {}
