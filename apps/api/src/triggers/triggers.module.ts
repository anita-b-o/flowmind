import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { TriggersController } from "./triggers.controller";
import { TriggersService } from "./triggers.service";
import { WebhookTokenService } from "./webhook-token.service";

@Module({
  controllers: [TriggersController],
  providers: [TriggersService, WebhookTokenService, OrganizationGuard, RolesGuard],
  exports: [TriggersService, WebhookTokenService]
})
export class TriggersModule {}
