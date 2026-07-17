import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { SecretsModule } from "../secrets/secrets.module";
import { TriggersController } from "./triggers.controller";
import { TriggersService } from "./triggers.service";
import { WebhookTokenService } from "./webhook-token.service";

@Module({
  imports: [AuditLogsModule, SecretsModule],
  controllers: [TriggersController],
  providers: [TriggersService, WebhookTokenService, OrganizationGuard, RolesGuard],
  exports: [TriggersService, WebhookTokenService]
})
export class TriggersModule {}
