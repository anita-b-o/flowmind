import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { SecretsModule } from "../secrets/secrets.module";
import { QueuesModule } from "../queues/queues.module";
import { ScheduledCronService } from "./scheduled-cron.service";
import { ScheduledTriggersProcessor } from "./scheduled-triggers.processor";
import { ScheduledTriggersService } from "./scheduled-triggers.service";
import { TriggersController } from "./triggers.controller";
import { TriggersService } from "./triggers.service";
import { WebhookTokenService } from "./webhook-token.service";

@Module({
  imports: [AuditLogsModule, SecretsModule, QueuesModule],
  controllers: [TriggersController],
  providers: [TriggersService, ScheduledTriggersService, ScheduledCronService, ScheduledTriggersProcessor, WebhookTokenService, OrganizationGuard, RolesGuard],
  exports: [TriggersService, ScheduledTriggersService, WebhookTokenService]
})
export class TriggersModule {}
