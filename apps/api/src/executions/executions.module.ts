import { Module } from "@nestjs/common";
import { OrganizationGuard } from "../organizations/organization.guard";
import { RolesGuard } from "../rbac/roles.guard";
import { QueuesModule } from "../queues/queues.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { ExecutionsController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({
  imports: [QueuesModule, AuditLogsModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService, OrganizationGuard, RolesGuard]
})
export class ExecutionsModule {}
