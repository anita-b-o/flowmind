import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { SecretsModule } from "../secrets/secrets.module";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { SafeConnectionTestClient } from "./safe-connection-test-client";

@Module({
  imports: [AuditLogsModule, SecretsModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService, SafeConnectionTestClient, OrganizationGuard, RolesGuard],
  exports: [ConnectionsService]
})
export class ConnectionsModule {}
